/**
 * Report exports: Markdown, CSV, JSON, e-mail summary, scraper file. Pure functions.
 *
 * Privacy rule: exports are built from an explicit WHITELIST of report fields, never
 * by serialising the raw job. Left out on purpose:
 *   - runtime internals: runtime_job_id, sandbox telemetry, runtime benchmark details
 *   - raw stdout/stderr (may carry sandbox paths), the screenshot bytes
 *   - anything else the backend may add later
 * The generated scraper is only in its own download, never inside other exports.
 */

import { inferColumns, cellValue, formatCell } from "./schema.js";
import { displayUrl, hostOf } from "../url.js";

const SCHEMA = "siftform.report/v1";

const str = (v) => (v == null ? "" : String(v));
const iso = (d) => (d instanceof Date && !Number.isNaN(d.getTime()) ? d.toISOString() : null);

export function slug(text, max = 48) {
  return (
    str(text)
      .toLowerCase()
      .replace(/^https?:\/\//, "")
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, max)
      .replace(/-+$/, "") || "report"
  );
}

export function baseName(job) {
  return `siftform-${slug((hostOf(job.url) || job.url).replace(/^www\./, ""), 32)}-${slug(job.id || "report", 12)}`;
}

/** Columns in the records' own key order (raw keys, used by CSV and Markdown). */
export function recordColumns(job) {
  return inferColumns(job.results);
}

/** Times we can stand behind: the backend's, else what this browser observed. */
export function reportTimes(job, observed = {}) {
  const started = job.createdAt || (observed.startedAt ? new Date(observed.startedAt) : null);
  const finished = job.finishedAt || (observed.finishedAt ? new Date(observed.finishedAt) : null);
  return { started, finished, source: job.createdAt ? "backend" : started ? "browser" : null };
}

/* ---- JSON ------------------------------------------------------------------ */

function attemptSummary(a) {
  return {
    n: a.n,
    source: a.source,
    verdict: str(a.verdictRaw) || null,
    reason: a.reason || null,
    exit_code: a.exitCode,
    timed_out: a.timedOut,
    duration_ms: a.durationMs,
    record_count: a.outputCount,
  };
}

function evidenceRefs(job) {
  const final = job.finalAttempt;
  const refs = [];
  refs.push({ id: "page", kind: "source_page", url: job.url, note: "Page the records were extracted from." });
  if (job.screenshot || job.hadScreenshot) refs.push({ id: "screenshot", kind: "screenshot", note: "Screenshot captured by the sandbox; not embedded in this export." });
  if (final?.reason) refs.push({ id: "checks", kind: "verification", attempt: final.n, note: final.reason });
  for (const f of job.intel?.findings || []) {
    for (const e of f.evidence || []) {
      refs.push({ id: `${f.id}.${e.id}`, kind: e.kind, finding: f.id, label: e.label || null, url: e.url || null, fetched_at: e.fetched_at || null, fact: e.fact || null });
    }
  }
  return refs;
}

export function toJSON(job, observed = {}) {
  const t = reportTimes(job, observed);
  const security = (job.security?.events || [])
    .filter((e) => !e.benchmark)
    .map((e) => ({ kind: e.kind, status: e.status, detail: e.detail }));
  const intel = job.intel?.status === "done" ? job.intel : null;
  const out = {
    schema: SCHEMA,
    exported_at: new Date().toISOString(),
    report: {
      id: job.id,
      url: job.url,
      title: job.title,
      status: job.status,
      outcome: job.outcome?.label || null,
      started_at: iso(t.started),
      finished_at: iso(t.finished),
      times_observed_by: t.source,
      scrape_mode: job.finalAttempt?.scrapeMode || null,
    },
    records: job.results,
    metadata: {
      record_count: job.results.length,
      fields: recordColumns(job).map((c) => ({ key: c.key, type: c.type, ...(c.currency ? { currency: c.currency } : {}) })),
      attempts: job.attempts.length,
      repaired: job.attempts.length > 1 && !!job.finalAttempt?.succeeded,
      scraper_reused: job.attempts[0]?.source === "saved",
      models: job.models ? { code: job.models.code, vision: job.models.vision } : null,
    },
    verification: {
      final_attempt: job.finalAttempt?.n ?? null,
      verdict: str(job.finalAttempt?.verdictRaw) || null,
      attempts: job.attempts.map(attemptSummary),
    },
    evidence: evidenceRefs(job),
    security_events: security,
  };
  if (intel) {
    out.plausibility = {
      flagged: intel.findings.length,
      findings: intel.findings.map((f) => ({
        id: f.id,
        record_index: f.record_index,
        name: f.name,
        original_value: f.original_value,
        value_changed: false,
        assessment: f.assessment,
        confidence: f.confidence,
        explanation: f.explanation,
        suggested_value: f.suggested_value ?? null,
        evidence_used: f.evidence_used || [],
        method: f.method,
      })),
    };
  }
  if (job.error) out.report.error = job.error;
  return JSON.stringify(out, null, 2);
}

/* ---- CSV ------------------------------------------------------------------- */

function csvCell(v) {
  if (v === null || v === undefined) return "";
  let s = typeof v === "object" ? JSON.stringify(v) : String(v);
  // Spreadsheet formula injection: neutralise text that a spreadsheet would execute.
  if (typeof v === "string" && /^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function toCSV(job) {
  const cols = recordColumns(job);
  const lines = [cols.map((c) => csvCell(c.key)).join(",")];
  for (const r of job.results) lines.push(cols.map((c) => csvCell(cellValue(r, c))).join(","));
  return `﻿${lines.join("\r\n")}\r\n`;
}

/* ---- Markdown -------------------------------------------------------------- */

const mdEsc = (s) => str(s).replace(/\\/g, "\\\\").replace(/\|/g, "\\|").replace(/\r?\n/g, " ");

function fmtDate(d) {
  if (!d) return "";
  return new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit", timeZoneName: "short" }).format(d);
}

export function toMarkdown(job, { observed = {}, link = null } = {}) {
  const cols = recordColumns(job);
  const t = reportTimes(job, observed);
  const out = [];
  out.push(`# ${mdEsc(job.title || hostOf(job.url) || "siftform. report")}`);
  out.push("");
  out.push(`- **Source:** ${job.url}`);
  out.push(`- **Status:** ${job.outcome?.title || job.status}`);
  out.push(`- **Records:** ${job.results.length}`);
  if (t.finished) out.push(`- **Finished:** ${fmtDate(t.finished)}${t.source === "browser" ? " (observed in this browser)" : ""}`);
  out.push(`- **Attempts:** ${job.attempts.length}${job.attempts[0]?.source === "saved" ? " (saved scraper reused)" : ""}`);
  if (link) out.push(`- **Report:** ${link}`);
  out.push("");

  if (job.results.length) {
    out.push("## Records");
    out.push("");
    out.push(`| ${cols.map((c) => mdEsc(c.label)).join(" | ")} |`);
    out.push(`| ${cols.map((c) => (c.align === "end" ? "---:" : "---")).join(" | ")} |`);
    for (const r of job.results) out.push(`| ${cols.map((c) => mdEsc(formatCell(cellValue(r, c), c))).join(" | ")} |`);
    out.push("");
  }

  const intel = job.intel?.status === "done" ? job.intel : null;
  if (intel && intel.findings.length) {
    out.push("## Needs review");
    out.push("");
    for (const f of intel.findings) {
      out.push(`- **${mdEsc(f.name)}** (${mdEsc(f.original_value)}): ${mdEsc(f.assessment_label || f.assessment)}${f.confidence ? `, ${f.confidence} confidence` : ""}. ${mdEsc(f.explanation || "")}`.trim());
    }
    out.push("");
  }

  out.push("## Verification");
  out.push("");
  for (const a of job.attempts) {
    const src = a.source ? ` (${a.source})` : "";
    out.push(`${a.n}. Attempt ${a.n}${src}: ${mdEsc(a.reason || str(a.verdictRaw) || "no verdict")}`);
  }
  if (!job.attempts.length) out.push("No attempts were reported.");
  out.push("");

  const sec = (job.security?.events || []).filter((e) => !e.benchmark);
  if (sec.length) {
    out.push("## Security events in this run");
    out.push("");
    for (const e of sec) out.push(`- ${mdEsc(e.kind)} — ${mdEsc(e.status)}: ${mdEsc(e.detail)}`);
    out.push("");
  }

  out.push(`_Exported from siftform. on ${fmtDate(new Date())}._`);
  return `${out.join("\n")}\n`;
}

/* ---- e-mail ---------------------------------------------------------------- */

const MAILTO_MAX = 1800; // conservative: some mail clients truncate long mailto: URLs

export function emailSummary(job, { link = null } = {}) {
  const cols = recordColumns(job);
  const name = cols.find((c) => c.type === "text") || cols[0];
  const value = cols.find((c) => c.type === "money") || cols.find((c) => c !== name);
  const host = (hostOf(job.url) || job.url).replace(/^www\./, "");
  const subject = `siftform. report: ${job.title || host} (${job.results.length} record${job.results.length === 1 ? "" : "s"})`;
  const head = [
    `${job.title || host}`,
    `Source: ${displayUrl(job.url)}`,
    `Status: ${job.outcome?.title || job.status}`,
    `Records: ${job.results.length}`,
    "",
  ];
  const tail = ["", link ? `Full report: ${link}` : "", "", "Sent from siftform."].filter((l, i, a) => l || a[i - 1]);
  const rows = job.results.map((r) => `• ${name ? formatCell(cellValue(r, name), name) : JSON.stringify(r)}${value ? ` — ${formatCell(cellValue(r, value), value)}` : ""}`);

  let shown = rows.length;
  let body;
  do {
    const list = rows.slice(0, shown);
    if (shown < rows.length) list.push(`…and ${rows.length - shown} more`);
    body = [...head, ...list, ...tail].join("\n");
    shown -= 1;
  } while (shown >= 0 && mailtoUrl(subject, body).length > MAILTO_MAX);
  return { subject, body, href: mailtoUrl(subject, body) };
}

export function mailtoUrl(subject, body) {
  return `mailto:?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
}

/* ---- scraper --------------------------------------------------------------- */

/** The code that produced the accepted results (or the last attempt's, labelled). */
export function scraperFile(job) {
  const final = job.finalCode || (job.finalAttempt?.succeeded ? job.finalAttempt.code : "");
  const code = final || job.finalAttempt?.code || "";
  if (!code) return null;
  const header = [
    "# Generated by siftform.",
    `# Source: ${job.url}`,
    `# Status: ${final ? "produced the verified results in this report" : "last attempt — did NOT produce verified results"}`,
    job.scrapeMode === "rendered"
      ? "# Rendered mode: parses PAGE_HTML (the browser-rendered page); define PAGE_HTML before running. No network."
      : "# Requires: requests, beautifulsoup4. Review before running; it fetches the URL below.",
    "",
  ].join("\n");
  return { name: `${baseName(job)}-scraper.py`, text: `${header}${code.endsWith("\n") ? code : `${code}\n`}`, verified: !!final };
}
