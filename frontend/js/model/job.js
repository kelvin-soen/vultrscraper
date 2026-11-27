/**
 * Job view-model.
 *
 * Converts the raw `GET /api/jobs/{id}` payload into everything the UI
 * renders. This is the ONLY place that interprets backend data, so the
 * contract lives in one file (see frontend/INTEGRATION.md).
 *
 * Honesty rule: a stage, check or security signal is shown as completed
 * only when the payload contains evidence for it. Missing data renders as
 * "pending", "not run" or "not reported", never as success.
 *
 * Supports two payload shapes:
 *  1. The current minimal contract:
 *     { status, url, error, attempts:[{n,code,stdout,stderr,exit_code,verdict,reason}],
 *       results:[...], screenshot_base64 }
 *  2. Optional extensions (all additive, all optional):
 *     steps[], events[], title, created_at, finished_at, models{},
 *     attempts[].timed_out / duration_ms / sandbox{}, security{events[], sandbox{}},
 *     evidence[] or results[]._evidence for screenshot regions.
 */

export const STAGE_DEFS = {
  access: {
    label: "Accessing website",
    description: "Opening the page through the sandbox and collecting its HTML.",
  },
  inspect: {
    label: "Inspecting page structure",
    description: "Reading the markup to locate the information on the page.",
  },
  capture: {
    label: "Capturing visual evidence",
    description: "Taking a screenshot of the original page to verify against.",
  },
  generate: {
    label: "Generating scraper",
    description: "Vultr Serverless Inference writes a Python scraper for this page.",
  },
  execute: {
    label: "Executing in isolated sandbox",
    description: "The scraper runs in a disposable sandbox container, never on the host.",
  },
  extract: {
    label: "Extracting information",
    description: "Parsing the scraper’s output into structured records.",
  },
  verify: {
    label: "Verifying results",
    description: "Comparing the extracted values with the page screenshot.",
  },
  repair: {
    label: "Repairing scraper",
    description: "Diagnosing the failure, writing a corrected scraper and running it again.",
  },
  report: {
    label: "Preparing results",
    description: "Assembling the extracted data into a report.",
  },
};

const VERIFIED_WORDS = /^(ok|pass|passed|match|matched|matches|verified|valid|correct|true|yes|success|good)$/i;
const REJECTED_WORDS =
  /^(fail|failed|mismatch|mismatched|wrong|invalid|incorrect|false|no|rejected|error|empty|bad|crash|timeout)$/i;
const PENDING_WORDS = /^(pending|unknown|unverified|skipped|n\/a|none|)$/i;

/* ------------------------------------------------------------------ */
/* primitives                                                          */
/* ------------------------------------------------------------------ */

const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const arr = (v) => (Array.isArray(v) ? v : []);
const str = (v) => (v == null ? "" : typeof v === "string" ? v : String(v));
const numOrNull = (v) => {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

function toDate(v) {
  if (v == null || v === "") return null;
  const d = typeof v === "number" ? new Date(v < 1e12 ? v * 1000 : v) : new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
}

export function normalizeVerdict(verdict, verifiedFlag) {
  if (verifiedFlag === true) return "verified";
  if (verifiedFlag === false) return "rejected";
  if (verdict === true) return "verified";
  if (verdict === false) return "rejected";
  const v = str(verdict).trim();
  if (VERIFIED_WORDS.test(v)) return "verified";
  if (REJECTED_WORDS.test(v)) return "rejected";
  if (PENDING_WORDS.test(v)) return "pending";
  return "unknown";
}

function normalizeStepStatus(s) {
  const v = str(s).toLowerCase();
  if (/^(done|complete|completed|success|succeeded|ok|passed|verified)$/.test(v)) return "done";
  if (/^(running|active|in_progress|in-progress|started|working)$/.test(v)) return "active";
  if (/^(failed|error|errored|rejected)$/.test(v)) return "failed";
  if (/^(skipped|not_run|cancelled|canceled)$/.test(v)) return "skipped";
  return "pending";
}

/** Parse scraper stdout as a JSON array. Never throws. */
export function parseOutput(stdout) {
  const text = str(stdout).trim();
  if (!text) return { items: null, error: null };
  try {
    const v = JSON.parse(text);
    if (Array.isArray(v)) return { items: v, error: null };
    return { items: null, error: "Output was JSON but not a list of records." };
  } catch {
    return { items: null, error: "Output was not valid JSON." };
  }
}

function lastMeaningfulLine(text) {
  const lines = str(text)
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
  return lines.length ? lines[lines.length - 1].slice(0, 280) : "";
}

const B64 = /^[A-Za-z0-9+/=\r\n]+$/;

/** Build a safe image src from a base64 payload. Returns null when unusable. */
export function screenshotSrc(b64) {
  if (typeof b64 !== "string" || b64.length < 16) return null;
  let data = b64.trim();
  let mime = null;
  const m = data.match(/^data:(image\/(?:png|jpeg|webp|gif|svg\+xml));base64,/i);
  if (m) {
    mime = m[1].toLowerCase();
    data = data.slice(m[0].length);
  }
  if (!B64.test(data)) return null;
  if (!mime) {
    if (data.startsWith("iVBOR")) mime = "image/png";
    else if (data.startsWith("/9j/")) mime = "image/jpeg";
    else if (data.startsWith("UklGR")) mime = "image/webp";
    else if (data.startsWith("R0lGOD")) mime = "image/gif";
    else if (data.startsWith("PHN2Z") || data.startsWith("PD94")) mime = "image/svg+xml";
    else mime = "image/png";
  }
  return `data:${mime};base64,${data.replace(/[\r\n]/g, "")}`;
}

/* ------------------------------------------------------------------ */
/* attempts                                                            */
/* ------------------------------------------------------------------ */

export function normalizeAttempt(raw, index) {
  const r = isObj(raw) ? raw : {};
  const exitCode = numOrNull(r.exit_code ?? r.exitCode);
  const timedOut = (r.timed_out ?? r.timedOut) === true;
  const stdout = str(r.stdout);
  const stderr = str(r.stderr);
  const code = str(r.code);
  const ran = r.ran === true || exitCode !== null || timedOut || stdout !== "" || stderr !== "";
  const verdict = normalizeVerdict(r.verdict, r.verified);
  const reason = str(r.reason);
  const output = parseOutput(stdout);
  const durationMs = numOrNull(r.duration_ms ?? r.durationMs);
  const sandbox = isObj(r.sandbox) ? r.sandbox : null;

  let failure = null;
  if (timedOut) {
    failure = {
      kind: "timeout",
      stage: "execute",
      message: "Execution exceeded the time limit and the sandbox terminated it.",
    };
  } else if (ran && exitCode !== null && exitCode !== 0) {
    failure = {
      kind: "crash",
      stage: "execute",
      message: lastMeaningfulLine(stderr) || `The scraper exited with code ${exitCode}.`,
    };
  } else if (ran && output.error) {
    failure = { kind: "invalid_output", stage: "extract", message: output.error };
  } else if (ran && output.items && output.items.length === 0) {
    failure = {
      kind: "empty",
      stage: "extract",
      message: verdict === "rejected" && reason ? reason : "The scraper returned no records.",
    };
  } else if (verdict === "rejected") {
    failure = {
      kind: "verification",
      stage: "verify",
      message: reason || "Extracted values did not match the screenshot.",
    };
  }

  return {
    n: numOrNull(r.n) ?? index + 1,
    code,
    stdout,
    stderr,
    exitCode,
    timedOut,
    durationMs,
    ran,
    verdict,
    verdictRaw: r.verdict ?? null,
    reason,
    output,
    outputCount: output.items ? output.items.length : null,
    failure,
    sandbox,
    model: str(r.model) || null,
    succeeded: ran && !failure && verdict === "verified",
  };
}

/* ------------------------------------------------------------------ */
/* stages                                                              */
/* ------------------------------------------------------------------ */

function stage(key, status, detail = "", extra = {}) {
  const def = STAGE_DEFS[key] || { label: humanLabel(key), description: "" };
  return { key, label: def.label, description: def.description, status, detail, ...extra };
}

function humanLabel(key) {
  const k = str(key).replace(/[_-]+/g, " ").trim();
  return k.charAt(0).toUpperCase() + k.slice(1);
}

function executeDetail(a) {
  const d = a.durationMs != null ? ` in ${fmtSeconds(a.durationMs)}` : "";
  if (a.timedOut) return `Terminated after exceeding the time limit${d}.`;
  if (a.exitCode !== null && a.exitCode !== 0) return `Exited with code ${a.exitCode}${d}.`;
  if (a.exitCode === 0) return `Completed${d}.`;
  return "Ran in the sandbox.";
}

function fmtSeconds(ms) {
  return ms < 1000 ? `${Math.round(ms)} ms` : `${(ms / 1000).toFixed(1)} s`;
}

function extractStatus(a, resultsCount, single) {
  if (!a || !a.ran) return ["pending", ""];
  if (a.failure && a.failure.stage === "execute") return ["skipped", "Nothing to extract."];
  if (a.failure && a.failure.kind === "empty") return ["failed", "The scraper returned no records."];
  if (a.failure && a.failure.stage === "extract") return ["failed", a.failure.message];
  const n = a.outputCount ?? (single ? resultsCount : null);
  if (n != null) return ["done", `${n} record${n === 1 ? "" : "s"} found.`];
  return ["done", ""];
}

function verifyStatus(a) {
  if (!a) return ["pending", ""];
  if (a.verdict === "verified") return ["done", a.reason || "Values match the screenshot."];
  if (a.verdict === "rejected") return ["failed", a.reason || "Values did not match the screenshot."];
  if (a.verdict === "unknown") return ["done", `Verdict: ${str(a.verdictRaw)}`];
  return ["pending", a.reason && a.ran ? a.reason : ""];
}

/** Derive pipeline stages from attempts when the backend does not send `steps`. */
export function deriveStages(job) {
  const { attempts, status, screenshot, resultsCount } = job;
  const first = attempts[0];
  const last = attempts[attempts.length - 1];
  const single = attempts.length === 1;
  const stages = [];

  // Access — evidenced by a screenshot/HTML fetch or by a generated scraper.
  stages.push(stage("access", screenshot || first ? "done" : "pending"));

  // Capture — the screenshot itself.
  if (screenshot) stages.push(stage("capture", "done", "Screenshot captured."));
  else stages.push(stage("capture", first ? "skipped" : "pending", first ? "No screenshot was returned." : ""));

  // Generate — attempt 1 code.
  stages.push(stage("generate", first && first.code ? "done" : "pending", first?.model ? `Model: ${first.model}` : ""));

  // Execute / extract / verify — first attempt. Repairs are shown in their own stage.
  if (first && first.ran) {
    stages.push(stage("execute", first.failure?.stage === "execute" ? "failed" : "done", executeDetail(first)));
  } else {
    stages.push(stage("execute", "pending"));
  }
  const [exS, exD] = extractStatus(first, resultsCount, single);
  stages.push(stage("extract", exS, exD));
  const [vS, vD] = first && first.ran ? verifyStatus(first) : ["pending", ""];
  stages.push(stage("verify", first?.failure && first.failure.stage !== "verify" && vS === "pending" ? "skipped" : vS, vD));

  // Repair — only when the first attempt failed or more attempts exist.
  const needsRepair = attempts.length > 1 || (first && first.failure);
  if (needsRepair) {
    let rs = "pending";
    let rd = "";
    if (attempts.length > 1 && last.succeeded) {
      rs = "done";
      rd = `Recovered on attempt ${last.n}.`;
    } else if (status === "running") {
      rs = "active";
      rd = attempts.length > 1 ? `Attempt ${last.n} in progress.` : "";
    } else {
      rs = "failed";
      rd = attempts.length > 1 ? `${attempts.length} attempts did not produce verified results.` : "No repair was attempted.";
    }
    stages.push(stage("repair", rs, rd, { attempts: attempts.length }));
  }

  stages.push(stage("report", status === "done" ? "done" : "pending"));
  return finalizeStages(stages, job);
}

/** Map backend-provided steps onto display stages. */
function stagesFromBackend(rawSteps, job) {
  const stages = rawSteps.filter(isObj).map((s, i) => {
    const key = str(s.key ?? s.id ?? s.name ?? `step_${i + 1}`);
    const def = STAGE_DEFS[key];
    return {
      key,
      label: str(s.label) || def?.label || humanLabel(key),
      description: str(s.description) || def?.description || "",
      status: normalizeStepStatus(s.status),
      detail: str(s.detail ?? s.message),
      startedAt: toDate(s.started_at),
      endedAt: toDate(s.ended_at ?? s.finished_at),
      provided: true,
    };
  });
  return finalizeStages(stages, job);
}

/** Resolve pending stages into active / not reached based on job status. */
function finalizeStages(stages, job) {
  const out = stages.map((s) => ({ ...s }));
  if (job.status === "running") {
    if (!out.some((s) => s.status === "active")) {
      const next = out.find((s) => s.status === "pending");
      if (next) next.status = "active";
    }
  } else if (job.status === "failed") {
    const alreadyFailed = out.some((s) => s.status === "failed");
    let marked = alreadyFailed;
    for (const s of out) {
      if (s.status === "active" || s.status === "pending") {
        if (!marked) {
          s.status = "failed";
          s.detail = job.error || s.detail || "The run stopped here.";
          marked = true;
        } else {
          s.status = "skipped";
          s.detail = s.detail || "Not reached.";
        }
      }
    }
  } else {
    for (const s of out) {
      if (s.status === "active" || s.status === "pending") {
        s.status = "skipped";
        s.detail = s.detail || "Not run.";
      }
    }
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* self-healing rounds                                                 */
/* ------------------------------------------------------------------ */

function verifyStep(a) {
  if (!a || !a.ran) return "pending";
  if (a.failure && a.failure.stage !== "verify") return "skipped";
  if (a.verdict === "verified") return "done";
  if (a.verdict === "rejected") return "failed";
  return "pending";
}

/**
 * One round per repair: the failure that triggered it and the progress of
 * the corrected scraper. A trailing pending round is added while the agent
 * is still working on a fix that has not produced code yet.
 */
export function deriveRepairs(job) {
  const { attempts, status } = job;
  const rounds = [];
  for (let k = 1; k < attempts.length; k++) {
    const from = attempts[k - 1];
    const to = attempts[k];
    rounds.push(buildRound(k, from, to, status));
  }
  const last = attempts[attempts.length - 1];
  if (status === "running" && last && last.failure) {
    rounds.push(buildRound(attempts.length, last, null, status));
  }
  return rounds;
}

function buildRound(k, from, to, status) {
  const execStatus = !to ? "pending" : !to.ran ? "pending" : to.failure?.stage === "execute" ? "failed" : "done";
  const steps = [
    {
      key: "failed",
      label: k === 1 ? "Original extraction failed" : `Attempt ${from.n} failed`,
      status: "failed",
      detail: from.failure?.message || from.reason || "The previous attempt did not produce verified results.",
    },
    { key: "investigate", label: "Investigating the failure", status: to ? "done" : "pending", detail: "" },
    {
      key: "regenerate",
      label: "Generating corrected scraper",
      status: to && to.code ? "done" : "pending",
      detail: "",
    },
    {
      key: "reexecute",
      label: "Executing corrected scraper",
      status: execStatus,
      detail: to && to.ran ? executeDetail(to) : "",
    },
    {
      key: "reverify",
      label: "Verifying new results",
      status: verifyStep(to),
      detail: to && to.ran ? (to.failure?.message && to.failure.stage !== "verify" ? to.failure.message : to.reason) : "",
    },
  ];

  if (status === "running") {
    const next = steps.find((s) => s.status === "pending");
    if (next && !steps.some((s) => s.status === "active")) next.status = "active";
  } else {
    for (const s of steps) if (s.status === "pending") s.status = "skipped";
  }

  let state = "in_progress";
  if (to && to.succeeded) state = "repaired";
  else if (to && to.failure) state = "failed";
  else if (to && to.ran && to.verdict !== "verified" && status !== "running") state = "unverified";
  else if (status !== "running") state = to ? "unverified" : "failed";

  return { index: k, from, to, steps, state };
}

/* ------------------------------------------------------------------ */
/* outcome                                                             */
/* ------------------------------------------------------------------ */

export function deriveOutcome(job) {
  const { status, attempts, error } = job;
  const last = attempts[attempts.length - 1];
  const repaired = attempts.length > 1;

  if (status === "running") {
    return { kind: "running", label: "In progress", title: "Working", detail: "" };
  }
  if (last && last.succeeded && status !== "failed") {
    return repaired
      ? {
          kind: "repaired",
          label: "Self-healed",
          title: "Recovered and verified",
          detail: `The first scraper failed. A corrected scraper was generated on attempt ${last.n} and its results were verified against the screenshot.`,
        }
      : {
          kind: "verified",
          label: "Verified",
          title: "Verified against the page",
          detail: "Extracted values were checked against a screenshot of the page.",
        };
  }
  if (repaired && (status === "failed" || last.failure)) {
    return {
      kind: "repair_failed",
      label: "Repair unsuccessful",
      title: "Repair unsuccessful",
      detail: error || `${attempts.length} attempts did not produce verified results.`,
    };
  }
  if (status === "failed" || (last && last.failure)) {
    return {
      kind: "failed",
      label: "Failed",
      title: "Extraction failed",
      detail: error || last?.failure?.message || "The run did not complete.",
    };
  }
  if (last && !last.ran) {
    return {
      kind: "unverified",
      label: "Not executed",
      title: "Scraper generated, not executed",
      detail: "The backend generated a scraper but did not report running or verifying it.",
    };
  }
  return {
    kind: "unverified",
    label: "Verification incomplete",
    title: "Verification incomplete",
    detail: "Results were extracted but the backend did not report a visual verification verdict.",
  };
}

/* ------------------------------------------------------------------ */
/* security                                                            */
/* ------------------------------------------------------------------ */

export const CAPABILITIES = [
  { key: "timeout", label: "Infinite-loop termination", kinds: ["timeout", "infinite_loop", "loop"] },
  { key: "filesystem", label: "Filesystem isolation", kinds: ["filesystem", "fs", "file_access"] },
  { key: "ssrf", label: "SSRF protection", kinds: ["ssrf", "network", "egress"] },
  { key: "prompt_injection", label: "Prompt-injection protection", kinds: ["prompt_injection", "injection"] },
  { key: "secrets", label: "Secret hygiene", kinds: ["secret", "secrets", "secret_hygiene", "env"] },
  { key: "cleanup", label: "Automatic container destruction", kinds: ["cleanup", "container_removed", "destroy"] },
];

const RUN_BADGE = { blocked: "Blocked in this run", detected: "Detected in this run", failed: "Failed in this run" };

/**
 * "runtime security benchmark (12/12, 11:06 UTC)". The date is added when the
 * benchmark ran on another UTC day than the job (or today, if the job has no date),
 * so an old benchmark never reads as fresh.
 */
function describeBenchmark(bench, jobDate) {
  const parts = [];
  if (bench && Number.isFinite(bench.passed) && Number.isFinite(bench.total)) parts.push(`${bench.passed}/${bench.total}`);
  const at = bench ? toDate(bench.finished_at) : null;
  if (at) {
    const iso = at.toISOString();
    const day = iso.slice(0, 10);
    const refDay = (jobDate || new Date()).toISOString().slice(0, 10);
    parts.push(`${refDay !== day ? `${day} ` : ""}${iso.slice(11, 16)} UTC`);
  }
  return `runtime security benchmark${parts.length ? ` (${parts.join(", ")})` : ""}`;
}

export function deriveSecurity(raw, attempts) {
  const sec = isObj(raw.security) ? raw.security : {};
  const sandbox = isObj(sec.sandbox) ? sec.sandbox : isObj(raw.sandbox) ? raw.sandbox : null;
  const events = arr(sec.events)
    .filter(isObj)
    .map((e) => ({
      kind: str(e.kind ?? e.type).toLowerCase(),
      status: str(e.status || "observed").toLowerCase(),
      detail: str(e.detail ?? e.message),
      attempt: numOrNull(e.attempt),
      benchmark: str(e.source).toLowerCase() === "benchmark",
    }));
  const benchmarkNote = describeBenchmark(isObj(sec.benchmark) ? sec.benchmark : null, toDate(raw.created_at));

  // Events from this job and runtime-wide benchmark results are kept apart:
  // a benchmark pass is never presented as something observed in this run.
  const capabilities = CAPABILITIES.map((cap) => {
    const evs = events.filter((e) => cap.kinds.includes(e.kind));
    const runEvs = evs.filter((e) => !e.benchmark);
    const benchEvs = evs.filter((e) => e.benchmark);
    const notes = runEvs.map((e) => e.detail).filter(Boolean);
    let observed = runEvs.length > 0;

    if (cap.key === "timeout") {
      const t = attempts.filter((a) => a.timedOut);
      if (t.length) {
        observed = true;
        notes.unshift(
          ...t.map((a) => `Attempt ${a.n} exceeded the time limit and was terminated${a.durationMs != null ? ` after ${fmtSeconds(a.durationMs)}` : ""}.`)
        );
      }
    }
    if (cap.key === "cleanup") {
      const removed = attempts.filter((a) => a.sandbox && a.sandbox.container_removed === true);
      if (removed.length) {
        observed = true;
        notes.unshift(removed.length === attempts.length ? "Container destroyed after every attempt." : `Container destroyed after ${removed.length} attempt${removed.length === 1 ? "" : "s"}.`);
      } else if (sandbox && sandbox.container_removed === true) {
        observed = true;
        notes.unshift("Container destroyed after execution.");
      }
    }
    if (observed) {
      const status = runEvs[0]?.status || "observed";
      return { key: cap.key, label: cap.label, observed, evidence: "run", status, badge: RUN_BADGE[status] || "Observed in this run", notes };
    }
    if (benchEvs.length) {
      const passed = benchEvs.every((e) => e.status === "passed");
      return {
        key: cap.key,
        label: cap.label,
        observed: false,
        evidence: "benchmark",
        status: passed ? "passed" : "failed",
        badge: null,
        notes: [passed ? `Verified by ${benchmarkNote}` : `Failed in ${benchmarkNote}`],
      };
    }
    return { key: cap.key, label: cap.label, observed: false, evidence: "none", status: "not_reported", badge: null, notes };
  });

  const runs = attempts
    .filter((a) => a.ran)
    .map((a) => ({
      n: a.n,
      durationMs: a.durationMs,
      timedOut: a.timedOut,
      exitCode: a.exitCode,
      runtime: str(a.sandbox?.runtime ?? sandbox?.runtime) || null,
      timeoutS: numOrNull(a.sandbox?.timeout_s ?? sandbox?.timeout_s),
      network: str(a.sandbox?.network ?? sandbox?.network) || null,
      removed: a.sandbox?.container_removed ?? null,
    }));

  const totalMs = runs.reduce((s, r) => (r.durationMs != null ? s + r.durationMs : s), 0);
  const hasTelemetry = !!sandbox || events.length > 0 || runs.some((r) => r.durationMs != null || r.runtime);

  return { sandbox, events, capabilities, runs, totalMs: runs.some((r) => r.durationMs != null) ? totalMs : null, hasTelemetry };
}

/* ------------------------------------------------------------------ */
/* evidence                                                            */
/* ------------------------------------------------------------------ */

function bbox(v) {
  if (Array.isArray(v) && v.length === 4 && v.every((n) => Number.isFinite(Number(n)))) {
    const [x, y, w, h] = v.map(Number);
    return w > 0 && h > 0 ? { x, y, w, h } : null;
  }
  if (isObj(v)) {
    const x = numOrNull(v.x), y = numOrNull(v.y);
    const w = numOrNull(v.w ?? v.width), h = numOrNull(v.h ?? v.height);
    return x != null && y != null && w > 0 && h > 0 ? { x, y, w, h } : null;
  }
  return null;
}

export function deriveEvidence(raw, results) {
  const byIndex = new Map();
  arr(raw.evidence)
    .filter(isObj)
    .forEach((e, i) => {
      const idx = numOrNull(e.index ?? e.result_index) ?? i;
      byIndex.set(idx, {
        box: bbox(e.bbox ?? e.box),
        verified: typeof e.verified === "boolean" ? e.verified : null,
        note: str(e.note ?? e.reason),
      });
    });
  results.forEach((r, i) => {
    if (isObj(r) && isObj(r._evidence)) {
      byIndex.set(i, {
        box: bbox(r._evidence.bbox ?? r._evidence.box),
        verified: typeof r._evidence.verified === "boolean" ? r._evidence.verified : null,
        note: str(r._evidence.note),
      });
    } else if (isObj(r) && typeof r._verified === "boolean" && !byIndex.has(i)) {
      byIndex.set(i, { box: null, verified: r._verified, note: "" });
    }
  });
  const hasBoxes = [...byIndex.values()].some((e) => e.box);
  const hasItemVerdicts = [...byIndex.values()].some((e) => e.verified !== null);
  return { byIndex, hasBoxes, hasItemVerdicts };
}

/* ------------------------------------------------------------------ */
/* entry point                                                         */
/* ------------------------------------------------------------------ */

export function normalizeJob(raw, { id = null, url = "" } = {}) {
  const r = isObj(raw) ? raw : {};
  const statusRaw = str(r.status).toLowerCase();
  const status = statusRaw === "done" || statusRaw === "failed" ? statusRaw : "running";
  const attempts = arr(r.attempts).map(normalizeAttempt);
  const results = arr(r.results).filter((x) => x !== null && x !== undefined);
  const screenshot = screenshotSrc(r.screenshot_base64);

  const job = {
    id: str(r.id) || id,
    url: str(r.url) || url,
    title: str(r.title) || null,
    status,
    error: str(r.error) || null,
    attempts,
    results,
    resultsCount: results.length,
    screenshot,
    createdAt: toDate(r.created_at),
    finishedAt: toDate(r.finished_at),
    models: isObj(r.models) ? { code: str(r.models.code) || null, vision: str(r.models.vision) || null } : null,
    log: arr(r.events)
      .filter(isObj)
      .map((e) => ({ at: toDate(e.ts ?? e.at ?? e.time), message: str(e.message ?? e.msg), level: str(e.level) })),
    hasBackendSteps: Array.isArray(r.steps) && r.steps.length > 0,
  };

  job.stages = job.hasBackendSteps ? stagesFromBackend(r.steps, job) : deriveStages(job);
  job.repairs = deriveRepairs(job);
  job.outcome = deriveOutcome(job);
  job.security = deriveSecurity(r, attempts);
  job.evidence = deriveEvidence(r, results);
  job.finalAttempt = attempts[attempts.length - 1] || null;
  job.durationMs = job.createdAt && job.finishedAt ? job.finishedAt - job.createdAt : null;
  return job;
}
