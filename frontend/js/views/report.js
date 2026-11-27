/**
 * State 3 — the intelligence dashboard.
 *
 * Three views: Overview, Data & Evidence, Agent & Infrastructure. Their content is a
 * declarative spec (from the backend's intelligence layer, or derived locally when the
 * backend has none) rendered by predefined components (js/dashboard/registry.js).
 * Every figure is a backend value or computed from extracted records; technical depth
 * (methodology, code, attempts, containment telemetry) sits in expandable sections.
 */

import { h, icon } from "../dom.js";
import { displayUrl, hostOf, safeHref } from "../url.js";
import { formatDuration, formatTime, pluralize } from "../model/format.js";
import { fallbackViews, VIEW_IDS } from "../model/intel.js";
import { renderBlock } from "../dashboard/registry.js";
import { mark } from "../components/ui.js";
import { favicon } from "../components/menu.js";
import { reportActions } from "../components/report-actions.js";
import { compareRecords, previousSnapshot } from "../model/history.js";
import { reportTimes } from "../model/export.js";
import { relativeTime } from "../model/format.js";

const TAB_HINT = {
  overview: "Results at a glance",
  data: "Records, screenshot, history",
  agent: "Scraper, attempts, sandbox",
};

export function reportView(job, { onRerun, observedMs, observed = {}, fromSnapshot = false, isMock = false }) {
  const openSet = new Set();
  const intel = job.intel;
  const views = intel.status === "done" ? intel.views : fallbackViews(job);
  const comparison = intel.status === "done" && intel.history ? null : localComparison(job, observed);
  if (comparison) addComparison(views, comparison);
  const host = (hostOf(job.url) || job.url).replace(/^www\./, "");
  const href = safeHref(job.url);
  const o = job.outcome;
  const ok = o.kind === "verified" || o.kind === "repaired";
  const flaggedCount = intel.status === "done" ? intel.findings.length : 0;

  const ctx = { job, intel, openSet, verdict: job.finalAttempt?.verdict, jump };

  /* ---- header ---------------------------------------------------------- */
  const times = reportTimes(job, observed);
  const metaBits = [pluralize(job.results.length, "record"), pluralize(job.attempts.length, "attempt")];
  if (job.attempts[0]?.source === "saved") metaBits.push("saved scraper");
  const duration = job.durationMs ?? observedMs ?? null;
  if (duration != null) metaBits.push(formatDuration(duration));
  const when = times.finished
    ? h("time", { class: "report__when", datetime: times.finished.toISOString(), title: `${formatTime(times.finished)}${times.source === "browser" ? " (as observed in this browser)" : ""}`, text: relativeTime(times.finished) })
    : null;

  const actions = reportActions(job, { onRerun, observed, isMock, fromSnapshot, onBeforePrint: () => renderAllForPrint() });
  const rerunMsg = actions.notice;
  const status = h(
    "div",
    { class: "report__status" },
    h("span", { class: `statuspill statuspill--${ok ? "ok" : o.kind}` }, mark(ok ? "done" : o.kind === "unverified" ? "skipped" : "failed", { size: "sm" }), h("span", { text: o.title })),
    flaggedCount
      ? h("a", { class: "statuspill statuspill--flag", href: "#needs-review", onClick: (e) => { select("overview"); jump(e, "needs-review"); } }, mark("flag", { size: "sm" }), h("span", { text: `${flaggedCount} value${flaggedCount === 1 ? "" : "s"} need${flaggedCount === 1 ? "s" : ""} review` }))
      : intel.status === "done"
        ? h("span", { class: "statuspill" }, mark("done", { size: "sm" }), h("span", { text: "All values plausible" }))
        : null
  );

  const head = h(
    "header",
    { class: "report__head" },
    h(
      "div",
      { class: "report__top" },
      h(
        "div",
        { class: "report__identity" },
        favicon(job.url, { size: 40, name: job.title }),
        h(
          "div",
          { class: "report__identity-text" },
          h("p", { class: "t-eyebrow", text: fromSnapshot ? "Saved report" : "Report" }),
          h("h1", { id: "report-title", class: "report__title", text: job.title || host }),
          h(
            "p",
            { class: "report__byline" },
            href ? h("a", { class: "report__source t-mono", href, target: "_blank", rel: "noopener noreferrer nofollow" }, h("span", { class: "truncate", text: displayUrl(job.url) }), icon("external", { size: 12 })) : h("span", { class: "t-mono", text: job.url }),
            h("span", { class: "report__meta t-num" }, metaBits.join("  ·  "), when ? "  ·  " : null, when)
          )
        )
      ),
      actions.el
    ),
    status,
    fromSnapshot
      ? h("p", { class: "report__saved t-small c-2" }, icon("clock", { size: 14 }), h("span", { text: `Saved copy from ${job.saved?.at ? formatTime(job.saved.at) : "this browser"}. The server no longer has this run (jobs live in server memory); the screenshot is not kept in saved copies.` }))
      : null,
    rerunMsg
  );

  /* ---- tabs ------------------------------------------------------------ */
  const tabs = [];
  const panels = [];
  views.forEach((v) => {
    const tab = h(
      "button",
      { class: "tab", type: "button", role: "tab", id: `tab-${v.id}`, "aria-controls": `panel-${v.id}`, "aria-selected": "false", tabindex: "-1", onClick: () => select(v.id, { focus: false }) },
      h("span", { class: "tab__label", text: v.label }),
      h("span", { class: "tab__hint", text: TAB_HINT[v.id] })
    );
    tabs.push(tab);
    const rendered = [];
    const panel = h("section", { class: `dview dview--${v.id}`, role: "tabpanel", id: `panel-${v.id}`, "aria-labelledby": `tab-${v.id}`, hidden: true, tabindex: "0" });
    panel._render = () => {
      if (rendered.length) return;
      for (const b of v.blocks) {
        const el = renderBlock(b, ctx);
        if (el) rendered.push(el);
      }
      if (!rendered.length) rendered.push(h("p", { class: "t-small c-3", text: "Nothing to show here for this run." }));
      panel.append(h("h2", { class: "dview__print-title", text: v.label }), ...rendered);
    };
    panels.push(panel);
  });

  const tablist = h(
    "div",
    { class: "tabs", role: "tablist", "aria-label": "Report views", onKeydown: onTabKey },
    tabs
  );

  function select(id, { focus = false, push = true } = {}) {
    const i = Math.max(0, VIEW_IDS.indexOf(id));
    tabs.forEach((t, k) => {
      const on = k === i;
      t.setAttribute("aria-selected", String(on));
      t.tabIndex = on ? 0 : -1;
      t.classList.toggle("is-active", on);
    });
    panels.forEach((p, k) => {
      if (k === i) p._render();
      p.hidden = k !== i;
    });
    if (focus) tabs[i].focus();
    if (push) history.replaceState(history.state, "", `${location.pathname}${location.search}#${VIEW_IDS[i]}`);
  }

  function onTabKey(e) {
    const i = tabs.indexOf(document.activeElement);
    if (i < 0) return;
    const n = tabs.length;
    const next = e.key === "ArrowRight" ? (i + 1) % n : e.key === "ArrowLeft" ? (i - 1 + n) % n : e.key === "Home" ? 0 : e.key === "End" ? n - 1 : -1;
    if (next < 0) return;
    e.preventDefault();
    select(VIEW_IDS[next], { focus: true });
  }

  const view = h(
    "article",
    { class: "view report", "aria-labelledby": "report-title" },
    h("div", { class: "art-layer", "aria-hidden": "true" }),
    head,
    tablist,
    h("div", { class: "report__panels" }, panels)
  );

  const initial = VIEW_IDS.includes(location.hash.slice(1)) ? location.hash.slice(1) : "overview";
  select(initial, { push: false });

  /* Print / PDF: every view, in order, with its own heading (CSS @media print). */
  function renderAllForPrint() {
    panels.forEach((p) => p._render());
    view.classList.add("is-printing");
  }
  const onBefore = () => renderAllForPrint();
  const onAfter = () => view.classList.remove("is-printing");
  window.addEventListener("beforeprint", onBefore);
  window.addEventListener("afterprint", onAfter);

  return {
    el: view,
    destroy() {
      window.removeEventListener("beforeprint", onBefore);
      window.removeEventListener("afterprint", onAfter);
    },
  };
}

/* ---- comparison with this browser's previous saved run on the same site ---- */

function localComparison(job, observed) {
  if (!job.results.length) return null;
  const prev = previousSnapshot({ ...job, finishedAtMs: observed.finishedAt || (job.finishedAt ? job.finishedAt.getTime() : null) });
  if (!prev) return null;
  const cmp = compareRecords(job.results, prev.snap.results);
  if (!cmp) return null;
  return { ...cmp, at: prev.entry.finishedAt ? new Date(prev.entry.finishedAt) : null, prevId: prev.entry.id };
}

function addComparison(views, cmp) {
  const when = cmp.at ? formatTime(cmp.at) : "an earlier run";
  const data = views.find((v) => v.id === "data");
  const overview = views.find((v) => v.id === "overview");
  if (data && cmp.rows.length) {
    data.blocks.push({ type: "history", title: `Compared with your run on ${when}`, rows: cmp.rows });
  }
  const parts = [];
  parts.push(cmp.changed.length ? `${pluralize(cmp.changed.length, "value")} changed` : "No values changed");
  if (cmp.added.length) parts.push(`${cmp.added.length} new`);
  if (cmp.removed.length) parts.push(`${cmp.removed.length} gone`);
  const text = `${parts.join(", ")} since your run on ${when} (saved in this browser).`;
  const f = overview?.blocks.find((b) => b.type === "findings");
  if (f) f.items = [...(f.items || []), { kind: "change", text }];
  else overview?.blocks.splice(1, 0, { type: "findings", title: "Key findings", items: [{ kind: "change", text }] });
}

function jump(e, id) {
  const el = document.getElementById(id);
  if (!el) return;
  e?.preventDefault();
  el.scrollIntoView({ behavior: "smooth", block: "start" });
  el.classList.remove("is-target");
  void el.offsetWidth;
  el.classList.add("is-target");
}
