/** Shared UI primitives built on the design tokens. */

import { h, icon, copyText } from "../dom.js";
import { tokenizePython } from "../model/highlight.js";
import { formatDuration } from "../model/format.js";

const MARK_LABEL = {
  done: "Completed",
  active: "In progress",
  failed: "Failed",
  pending: "Waiting",
  skipped: "Not run",
  flag: "Needs review",
};

/** Status marker: shape carries meaning, not colour. */
export function mark(status, { size = "md", label } = {}) {
  const s = MARK_LABEL[status] ? status : "pending";
  const glyph = s === "done" ? icon("check", { size: 12 }) : s === "failed" ? icon("x", { size: 12 }) : s === "skipped" ? icon("minus", { size: 12 }) : s === "flag" ? icon("alert", { size: 12 }) : null;
  return h("span", { class: `mark mark--${s} mark--${size}`, role: "img", "aria-label": label || MARK_LABEL[s] }, glyph);
}

export function pill(text, { tone = "default", markStatus } = {}) {
  return h("span", { class: `pill pill--${tone}` }, markStatus ? mark(markStatus, { size: "sm" }) : null, h("span", { text }));
}

export function button(label, { variant = "secondary", size = "md", iconName, iconAfter, onClick, type = "button", attrs = {} } = {}) {
  return h(
    "button",
    { class: `btn btn--${variant} btn--${size}`, type, onClick, ...attrs },
    iconName ? icon(iconName) : null,
    label ? h("span", { text: label }) : null,
    iconAfter ? icon(iconAfter) : null
  );
}

export function eyebrow(text) {
  return h("p", { class: "t-eyebrow", text });
}

export function skeleton({ lines = 3, block = false } = {}) {
  if (block) return h("div", { class: "skeleton skeleton--block", "aria-hidden": "true" });
  return h(
    "div",
    { class: "skeleton-lines", "aria-hidden": "true" },
    Array.from({ length: lines }, (_, i) => h("span", { class: "skeleton", style: { width: `${[92, 76, 54, 84][i % 4]}%` } }))
  );
}

export function emptyState(title, body, action) {
  return h("div", { class: "empty" }, h("p", { class: "empty__title", text: title }), body ? h("p", { class: "empty__body", text: body }) : null, action || null);
}

/** Disclosure with stable open state across re-renders (keyed in `openSet`). */
export function disclosure(summary, content, { key, openSet, meta, className = "" } = {}) {
  const open = key && openSet ? openSet.has(key) : false;
  const d = h(
    "details",
    { class: `disclosure ${className}`, open },
    h(
      "summary",
      { class: "disclosure__summary" },
      h("span", { class: "disclosure__chevron" }, icon("chevron", { size: 14 })),
      h("span", { class: "disclosure__label", text: summary }),
      meta ? h("span", { class: "disclosure__meta" }, meta) : null
    ),
    h("div", { class: "disclosure__body" }, typeof content === "function" ? null : content)
  );
  let rendered = typeof content !== "function";
  d.addEventListener("toggle", () => {
    if (key && openSet) d.open ? openSet.add(key) : openSet.delete(key);
    if (d.open && !rendered) {
      d.querySelector(".disclosure__body").append(content());
      rendered = true;
    }
  });
  if (open && !rendered) {
    d.querySelector(".disclosure__body").append(content());
    rendered = true;
  }
  return d;
}

/** Read-only code view with line numbers, monochrome highlighting, copy. */
export function codeView(code, { language = "python", filename, maxHeight } = {}) {
  const text = String(code ?? "");
  const pre = h("pre", { class: "code__pre", tabindex: "0" });
  const codeEl = h("code", { class: "code__code" });
  if (language === "python") {
    for (const t of tokenizePython(text)) {
      codeEl.append(t.type === "plain" ? document.createTextNode(t.text) : h("span", { class: `tok tok--${t.type}`, text: t.text }));
    }
  } else codeEl.textContent = text;
  pre.append(codeEl);

  const lineCount = text ? text.replace(/\n$/, "").split("\n").length : 0;
  const gutter = h("div", { class: "code__gutter", "aria-hidden": "true" }, Array.from({ length: lineCount }, (_, i) => h("span", { text: String(i + 1) })));

  const copyBtn = h("button", { class: "code__copy", type: "button", "aria-label": "Copy to clipboard" }, icon("copy", { size: 14 }), h("span", { text: "Copy" }));
  copyBtn.addEventListener("click", async () => {
    const ok = await copyText(text);
    copyBtn.lastChild.textContent = ok ? "Copied" : "Copy failed";
    setTimeout(() => (copyBtn.lastChild.textContent = "Copy"), 1600);
  });

  return h(
    "div",
    { class: `code code--${language}`, style: maxHeight ? { "--code-max-h": maxHeight } : null },
    h("div", { class: "code__bar" }, h("span", { class: "code__name t-mono", text: filename || (language === "python" ? "scraper.py" : language) }), h("span", { class: "code__lines t-micro c-3", text: `${lineCount} lines` }), copyBtn),
    h("div", { class: "code__scroll" }, language === "python" ? gutter : null, pre)
  );
}

/** Plain monospaced log output (stdout/stderr). */
export function logView(text, { label, empty = "No output." } = {}) {
  const t = String(text ?? "");
  return h(
    "div",
    { class: "log" },
    label ? h("div", { class: "log__label t-eyebrow", text: label }) : null,
    t ? h("pre", { class: "log__pre", tabindex: "0", text: t }) : h("p", { class: "log__empty t-small c-3", text: empty })
  );
}

/* ---- attempt helpers --------------------------------------------------- */

export function attemptState(a) {
  if (!a.ran) return { status: "pending", label: a.code ? "Generated" : "Generating" };
  if (a.failure) {
    const map = { timeout: "Timed out", crash: "Crashed", invalid_output: "Invalid output", empty: "No records", verification: "Rejected" };
    return { status: "failed", label: map[a.failure.kind] || "Failed" };
  }
  if (a.verdict === "verified") return { status: "done", label: "Verified" };
  if (a.verdict === "unknown") return { status: "done", label: `Verdict: ${String(a.verdictRaw)}` };
  return { status: "active", label: "Awaiting verification" };
}

export function attemptMeta(a) {
  const bits = [];
  if (a.exitCode !== null) bits.push(`exit ${a.exitCode}`);
  if (a.timedOut) bits.push("timed out");
  if (a.durationMs != null) bits.push(formatDuration(a.durationMs));
  if (a.outputCount != null) bits.push(`${a.outputCount} record${a.outputCount === 1 ? "" : "s"}`);
  return bits.join(" · ");
}

/**
 * Attempt card: status, verdict reason, and expandable code/stdout/stderr.
 * `live` marks the attempt still being worked on.
 */
export function attemptCard(a, { openSet, live = false, idPrefix = "a" } = {}) {
  const st = attemptState(a);
  const showStatus = live && st.status === "pending" ? "active" : st.status;
  const meta = attemptMeta(a);
  const reason = a.failure?.message || a.reason;
  return h(
    "article",
    { class: `attempt attempt--${showStatus}`, "aria-label": `Attempt ${a.n}` },
    h(
      "header",
      { class: "attempt__head" },
      mark(showStatus),
      h("h4", { class: "attempt__title", text: `Attempt ${a.n}` }),
      h("span", { class: "attempt__state t-small", text: st.label }),
      meta ? h("span", { class: "attempt__meta t-micro t-num c-3", text: meta }) : null
    ),
    reason && reason !== "generated (not run yet)" ? h("p", { class: "attempt__reason t-small c-2", text: reason }) : null,
    h(
      "div",
      { class: "attempt__details" },
      a.code ? disclosure("Scraper code", () => codeView(a.code, { filename: `attempt_${a.n}.py` }), { key: `${idPrefix}${a.n}-code`, openSet }) : null,
      a.ran ? disclosure("Output", () => logView(a.stdout, { empty: "The scraper printed nothing to stdout." }), { key: `${idPrefix}${a.n}-out`, openSet, meta: a.outputCount != null ? `${a.outputCount} records` : null }) : null,
      a.stderr ? disclosure("Errors", () => logView(a.stderr), { key: `${idPrefix}${a.n}-err`, openSet, meta: "stderr" }) : null
    )
  );
}
