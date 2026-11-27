/**
 * State 3 — website-specific report.
 *
 * An editorial, schema-driven publication about the extracted data. Every
 * figure on this page is either a backend value or computed directly from
 * extracted records; absent data produces an explicit empty state.
 */

import { h, icon } from "../dom.js";
import { displayUrl, hostOf, safeHref } from "../url.js";
import { formatDuration, formatTime, pluralize } from "../model/format.js";
import { inferColumns, primaryColumn, summarize } from "../model/schema.js";
import { dataTable } from "../components/table.js";
import { evidenceViewer } from "../components/evidence.js";
import { healingSection } from "../components/healing.js";
import { securitySection } from "../components/security.js";
import { button, codeView, emptyState, mark } from "../components/ui.js";

export function reportView(job, { onNew, onRerun, observedMs }) {
  const openSet = new Set();
  const host = hostOf(job.url) || job.url;
  const href = safeHref(job.url);
  const columns = inferColumns(job.results);
  const primary = primaryColumn(columns);
  const stats = job.results.length ? summarize(job.results, columns) : [];
  const o = job.outcome;
  const ok = o.kind === "verified" || o.kind === "repaired";
  const outcomeStatus = ok ? "done" : o.kind === "unverified" ? "skipped" : "failed";

  const sections = [
    { id: "data", title: "Extracted data", render: () => dataSection(job, columns) },
    { id: "evidence", title: "Evidence", render: () => evidenceViewer(job, columns, primary) },
    { id: "recovery", title: "Self-healing & history", render: () => healingSection(job, { openSet }) },
    { id: "method", title: "Methodology", render: () => methodSection(job) },
    { id: "containment", title: "Containment", render: () => securitySection(job) },
    { id: "scraper", title: "Scraper", render: () => scraperSection(job) },
  ];

  const metaBits = [];
  metaBits.push(pluralize(job.attempts.length, "attempt"));
  const duration = job.durationMs ?? observedMs ?? null;
  if (duration != null) metaBits.push(`${formatDuration(duration)}${job.durationMs == null ? " observed" : ""}`);
  if (job.finishedAt) metaBits.push(formatTime(job.finishedAt));

  const rerunMsg = h("p", { class: "report__notice t-small c-2", role: "status", "aria-live": "polite", hidden: true });

  const view = h(
    "article",
    { class: "view report", "aria-labelledby": "report-title" },
    h("div", { class: "art-layer", "aria-hidden": "true" }),
    h(
      "header",
      { class: "report__head" },
      h(
        "div",
        { class: "report__identity" },
        h("span", { class: "monogram", "aria-hidden": "true", text: /^[a-z]/i.test(host.replace(/^www\./, "")) ? host.replace(/^www\./, "")[0].toUpperCase() : "" }),
        h("div", { class: "report__identity-text" }, h("p", { class: "t-eyebrow", text: "Extraction report" }), h("h1", { id: "report-title", class: "t-display report__title", text: job.title || host.replace(/^www\./, "") }))
      ),
      h(
        "div",
        { class: "report__byline" },
        href ? h("a", { class: "report__source t-mono", href, target: "_blank", rel: "noopener noreferrer nofollow" }, h("span", { class: "truncate", text: displayUrl(job.url) }), icon("external", { size: 12 })) : h("span", { class: "t-mono", text: job.url }),
        h("span", { class: "report__meta t-small c-3 t-num", text: metaBits.join("  ·  ") })
      ),
      h(
        "div",
        { class: `verdict verdict--${o.kind}` },
        mark(outcomeStatus, { size: "lg" }),
        h("div", { class: "verdict__text" }, h("p", { class: "verdict__title", text: o.title }), h("p", { class: "verdict__detail t-small c-2", text: o.detail }))
      ),
      stats.length
        ? h(
            "dl",
            { class: "stats" },
            stats.map((s) => h("div", { class: "stat" }, h("dt", { class: "stat__label", text: s.label }), h("dd", { class: "stat__value t-num", text: s.value })))
          )
        : null,
      h(
        "div",
        { class: "report__actions" },
        button("New extraction", { variant: "primary", iconName: "arrowLeft", onClick: onNew }),
        button("Run again", {
          variant: "secondary",
          iconName: "refresh",
          onClick: async (e) => {
            const btn = e.currentTarget;
            btn.disabled = true;
            rerunMsg.hidden = true;
            try {
              await onRerun();
            } catch (err) {
              rerunMsg.hidden = false;
              rerunMsg.textContent = err?.message || "Couldn’t start a new run.";
            } finally {
              btn.disabled = false;
            }
          },
        }),
        rerunMsg
      )
    ),
    h(
      "nav",
      { class: "toc", "aria-label": "Report sections" },
      h(
        "ol",
        null,
        sections.map((s, i) => h("li", null, h("a", { href: `#${s.id}`, onClick: (e) => jump(e, s.id) }, h("span", { class: "toc__n t-num", text: String(i + 1).padStart(2, "0") }), h("span", { text: s.title }))))
      )
    ),
    h(
      "div",
      { class: "report__body" },
      sections.map((s, i) =>
        h(
          "section",
          { id: s.id, class: "rsec", "aria-labelledby": `${s.id}-h` },
          h("header", { class: "rsec__head" }, h("span", { class: "rsec__n t-num", text: String(i + 1).padStart(2, "0") }), h("h2", { id: `${s.id}-h`, class: "t-heading", text: s.title })),
          h("div", { class: "rsec__body" }, s.render())
        )
      )
    )
  );

  return { el: view };
}

function jump(e, id) {
  const el = document.getElementById(id);
  if (!el) return;
  e.preventDefault();
  el.scrollIntoView({ behavior: "smooth", block: "start" });
  history.replaceState(history.state, "", `${location.pathname}${location.search}#${id}`);
}

function dataSection(job, columns) {
  if (!job.results.length) {
    const a = job.finalAttempt;
    const body = !a
      ? "The backend did not report any scraper attempts."
      : !a.ran
        ? "A scraper was generated, but the backend did not report executing it, so there are no results yet."
        : a.failure
          ? `The final attempt did not produce usable records: ${a.failure.message}`
          : "The backend returned no records for this page.";
    return emptyState("No records extracted", body);
  }
  const verdict = job.finalAttempt?.verdict;
  return h(
    "div",
    { class: "data" },
    h(
      "p",
      { class: "data__note t-small c-2" },
      mark(verdict === "verified" ? "done" : verdict === "rejected" ? "failed" : "pending", { size: "sm" }),
      h("span", {
        text:
          verdict === "verified"
            ? `${pluralize(job.results.length, "record")} verified against the page screenshot.`
            : verdict === "rejected"
              ? "These records were rejected by visual verification."
              : "These records have not been visually verified.",
      })
    ),
    dataTable(job.results, columns, { caption: "Extracted records" })
  );
}

function methodSection(job) {
  const models = job.models;
  const facts = [
    ["Target", displayUrl(job.url)],
    ["Pipeline", job.hasBackendSteps ? "Reported by backend" : "Derived from reported attempts"],
    ["Attempts", String(job.attempts.length)],
    ["Records", String(job.results.length)],
    ["Screenshot", job.screenshot ? "Captured" : "Not returned"],
    ["Verification", job.finalAttempt ? verdictLabel(job.finalAttempt.verdict) : "—"],
  ];
  if (models?.code) facts.push(["Code model", models.code]);
  if (models?.vision) facts.push(["Vision model", models.vision]);

  return h(
    "div",
    { class: "method" },
    h(
      "ol",
      { class: "method__steps" },
      job.stages.map((s) =>
        h(
          "li",
          { class: `method__step method__step--${s.status}` },
          mark(s.status, { size: "sm" }),
          h("div", null, h("p", { class: "method__label", text: s.label }), h("p", { class: "t-small c-3", text: s.detail || s.description }))
        )
      )
    ),
    h(
      "dl",
      { class: "facts" },
      facts.map(([k, v]) => h("div", { class: "fact" }, h("dt", { class: "t-small c-3", text: k }), h("dd", { class: "t-small", text: v })))
    )
  );
}

function verdictLabel(v) {
  return v === "verified" ? "Verified" : v === "rejected" ? "Rejected" : v === "unknown" ? "Unrecognised verdict" : "Not reported";
}

function scraperSection(job) {
  const a = [...job.attempts].reverse().find((x) => x.succeeded) || job.finalAttempt;
  if (!a || !a.code) return emptyState("No scraper code", "The backend did not return any generated code.");
  return h(
    "div",
    { class: "scraper" },
    h("p", { class: "t-small c-2 scraper__note", text: a.succeeded ? `The verified scraper from attempt ${a.n}. Shown as text; it is never executed in the browser.` : `The latest scraper (attempt ${a.n}). Shown as text; it is never executed in the browser.` }),
    codeView(a.code, { filename: `attempt_${a.n}.py`, maxHeight: "32rem" })
  );
}
