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
import { button, mark } from "../components/ui.js";

const TAB_HINT = {
  overview: "Results at a glance",
  data: "Records, screenshot, history",
  agent: "Scraper, attempts, sandbox",
};

export function reportView(job, { onNew, onRerun, observedMs }) {
  const openSet = new Set();
  const intel = job.intel;
  const views = intel.status === "done" ? intel.views : fallbackViews(job);
  const host = (hostOf(job.url) || job.url).replace(/^www\./, "");
  const href = safeHref(job.url);
  const o = job.outcome;
  const ok = o.kind === "verified" || o.kind === "repaired";
  const flaggedCount = intel.status === "done" ? intel.findings.length : 0;

  const ctx = { job, intel, openSet, verdict: job.finalAttempt?.verdict, jump };

  /* ---- header ---------------------------------------------------------- */
  const metaBits = [pluralize(job.attempts.length, "attempt")];
  const duration = job.durationMs ?? observedMs ?? null;
  if (duration != null) metaBits.push(formatDuration(duration));
  if (job.finishedAt) metaBits.push(formatTime(job.finishedAt));

  const rerunMsg = h("p", { class: "report__notice t-small c-2", role: "status", "aria-live": "polite", hidden: true });
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
        h("span", { class: "monogram", "aria-hidden": "true", text: /^[a-z]/i.test(host) ? host[0].toUpperCase() : "" }),
        h(
          "div",
          { class: "report__identity-text" },
          h("p", { class: "t-eyebrow", text: "Intelligence report" }),
          h("h1", { id: "report-title", class: "report__title", text: job.title || host }),
          h(
            "p",
            { class: "report__byline" },
            href ? h("a", { class: "report__source t-mono", href, target: "_blank", rel: "noopener noreferrer nofollow" }, h("span", { class: "truncate", text: displayUrl(job.url) }), icon("external", { size: 12 })) : h("span", { class: "t-mono", text: job.url }),
            h("span", { class: "report__meta t-num", text: metaBits.join("  ·  ") })
          )
        )
      ),
      h(
        "div",
        { class: "report__actions" },
        button("Run again", {
          variant: "secondary",
          size: "sm",
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
        button("New extraction", { variant: "primary", size: "sm", iconName: "arrowLeft", onClick: onNew })
      )
    ),
    status,
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
      panel.append(...rendered);
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

  return { el: view };
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
