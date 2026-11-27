/**
 * What the backend is doing RIGHT NOW, from the raw job payload only.
 *
 * Signals (backend/main.py _run_job):
 *   - no attempts, no screenshot      → the runtime is loading the page (/screenshot)
 *   - screenshot, no attempts         → preparing (page title, runtime benchmark lookup)
 *   - last attempt verdict "running" with reason
 *       "generating scraper"          → code model writes a scraper
 *       "repairing scraper"           → code model fixes the previous attempt
 *       "running in sandbox"          → gVisor sandbox run (source "saved" = reused scraper)
 *       "checking output"             → JSON shape + evidence check + vision check
 *   - phase "analyzing"               → intelligence layer (only on backends that have it)
 *   - status done / failed            → terminal
 *
 * Nothing here advances on a timer or guesses: an unknown reason is shown as-is.
 */

const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const str = (v) => (v == null ? "" : String(v));

function countRecords(stdout) {
  const t = str(stdout).trim();
  if (!t) return null;
  try {
    const v = JSON.parse(t);
    return Array.isArray(v) ? v.length : null;
  } catch {
    try {
      const v = JSON.parse(t.split("\n").pop());
      return Array.isArray(v) ? v.length : null;
    } catch {
      return null;
    }
  }
}

function shorten(s, n = 140) {
  const t = str(s).replace(/\s+/g, " ").trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
}

/**
 * @returns {{ key: string, mode: string, label: string, detail: string, attempt: number|null, terminal: boolean }}
 *   key: open | prepare | generate | repair | execute | verify | analyze | done | failed | unknown
 *   mode: cube motion (see components/cube.js MODES)
 */
export function liveStage(raw) {
  const r = isObj(raw) ? raw : {};
  const status = str(r.status).toLowerCase();
  const attempts = Array.isArray(r.attempts) ? r.attempts.filter(isObj) : [];
  const last = attempts[attempts.length - 1] || null;
  const n = last ? Number(last.n) || attempts.length : null;
  const rendered = str(r.scrape_mode) === "rendered" || str(last?.scrape_mode) === "rendered";
  const codeModel = str(r.models?.code);
  const results = Array.isArray(r.results) ? r.results.length : 0;

  if (status === "done") {
    return { key: "done", mode: "done", label: "Report ready", detail: results ? `${results} record${results === 1 ? "" : "s"} verified` : "Finished", attempt: n, terminal: true };
  }
  if (status === "failed") {
    return { key: "failed", mode: "failed", label: "Extraction failed", detail: shorten(r.error || last?.reason || "The run stopped."), attempt: n, terminal: true };
  }
  if (str(r.phase) === "analyzing") {
    return { key: "analyze", mode: "analyze", label: "Checking plausibility", detail: "Comparing values with categories and earlier runs", attempt: n, terminal: false };
  }
  if (!last) {
    if (!r.screenshot_base64) return { key: "open", mode: "open", label: "Opening the page", detail: "Loading it in an isolated browser sandbox", attempt: null, terminal: false };
    return { key: "prepare", mode: "prepare", label: "Page captured", detail: "Preparing the extraction", attempt: null, terminal: false };
  }

  const reason = str(last.reason).toLowerCase();
  const verdict = str(last.verdict).toLowerCase();
  const prev = attempts[attempts.length - 2] || null;
  const source = str(last.source);
  const target = rendered ? "the browser-rendered page" : "this page";

  if (verdict === "running") {
    if (reason.startsWith("generating")) {
      return { key: "generate", mode: "generate", label: "Writing a scraper", detail: `${codeModel || "The code model"} is writing Python for ${target}`, attempt: n, terminal: false };
    }
    if (reason.startsWith("repairing")) {
      const why = prev ? shorten(prev.reason, 90) : "";
      return { key: "repair", mode: "repair", label: "Repairing the scraper", detail: why ? `Attempt ${prev.n} failed: ${why}` : "Writing a fix for the failed attempt", attempt: n, terminal: false };
    }
    if (reason.startsWith("running in sandbox")) {
      const label = source === "saved" ? "Running the saved scraper" : source === "repaired" ? "Running the repaired scraper" : "Running in the sandbox";
      const detail = source === "saved" ? "Reused from an earlier verified run — no AI call" : `Attempt ${n} in a disposable sandbox container`;
      return { key: "execute", mode: "execute", label, detail, attempt: n, terminal: false };
    }
    if (reason.startsWith("checking output")) {
      const c = countRecords(last.stdout);
      return { key: "verify", mode: "verify", label: "Verifying results", detail: c ? `Checking ${c} extracted record${c === 1 ? "" : "s"} against the page and screenshot` : "Checking the output against the page and screenshot", attempt: n, terminal: false };
    }
    return { key: "unknown", mode: "prepare", label: "Working", detail: shorten(last.reason), attempt: n, terminal: false };
  }

  // Last attempt has a verdict but the job is still running: the backend is between
  // steps (e.g. the next attempt is about to be appended, or the switch to rendered mode).
  if (verdict === "fail") return { key: "repair", mode: "repair", label: "Attempt failed", detail: shorten(last.reason, 120), attempt: n, terminal: false };
  return { key: "verify", mode: "verify", label: "Finishing", detail: shorten(last.reason, 120), attempt: n, terminal: false };
}
