/**
 * Component registry: the ONLY way a dashboard spec becomes UI.
 *
 * Each validated block `{type, ...props}` maps to a predefined render function.
 * Unknown types never reach this file (js/model/intel.js validates the spec), and
 * a block that has no data renders nothing rather than a placeholder claim.
 */

import { h, icon } from "../dom.js";
import { displayUrl, safeHref } from "../url.js";
import { formatDuration, formatMoney, formatTime, pluralize } from "../model/format.js";
import { inferColumns, primaryColumn } from "../model/schema.js";
import { dataTable } from "../components/table.js";
import { evidenceViewer } from "../components/evidence.js";
import { healingSection } from "../components/healing.js";
import { securitySection } from "../components/security.js";
import { codeView, disclosure, emptyState, mark } from "../components/ui.js";
import { CHARTS } from "./charts.js";

const kr = (n) => formatMoney(n, "SEK");

function blockShell(block, body, { wide = false, id } = {}) {
  if (!body) return null;
  return h(
    "section",
    { class: `dblock dblock--${block.type}${block.kind ? ` dblock--${block.kind}` : ""}${wide ? " dblock--wide" : ""}`, id },
    block.title && block.type !== "chart" ? h("h2", { class: "dblock__title", text: block.title }) : null,
    body
  );
}

/* ---- KPIs ------------------------------------------------------------- */

function kpis(block) {
  const items = (block.items || []).filter((k) => k && k.label && k.value);
  if (!items.length) return null;
  return h(
    "dl",
    { class: "kpis", style: { "--kpi-n": String(Math.min(items.length, 6)) } },
    items.map((k) =>
      h(
        "div",
        { class: `kpi${k.tone === "attention" ? " kpi--attention" : ""}` },
        h("dt", { class: "kpi__label" }, k.tone === "attention" ? mark("flag", { size: "sm" }) : null, h("span", { text: k.label })),
        h("dd", { class: "kpi__value", text: k.value }),
        k.caption ? h("dd", { class: "kpi__caption", text: k.caption }) : null
      )
    )
  );
}

/* ---- key findings ------------------------------------------------------ */

const FINDING_GLYPH = { verified: "done", attention: "flag", insight: "pending", change: "pending" };

function findings(block, ctx) {
  const items = (block.items || []).filter((f) => f && f.text);
  if (!items.length) return null;
  return h(
    "ol",
    { class: "keyfindings" },
    items.map((f) =>
      h(
        "li",
        { class: `keyfinding keyfinding--${f.kind || "insight"}` },
        f.kind === "change" ? h("span", { class: "keyfinding__glyph", "aria-hidden": "true" }, icon("arrowUpRight", { size: 14 })) : mark(FINDING_GLYPH[f.kind] || "pending", { size: "sm", label: f.kind === "attention" ? "Needs review" : f.kind === "verified" ? "Verified" : "Insight" }),
        h("p", { class: "keyfinding__text", text: f.text }),
        f.ref && ctx.intel.findingsById?.has(f.ref)
          ? h("a", { class: "keyfinding__link", href: `#finding-${f.ref}`, onClick: (e) => ctx.jump(e, `finding-${f.ref}`) }, h("span", { text: "Details" }), icon("chevron", { size: 12 }))
          : null
      )
    )
  );
}

/* ---- anomaly investigation cards -------------------------------------- */

const EVIDENCE_KIND = { page: "Listing page", statistics: "Statistics", history: "History", research: "Research" };

function evidenceItem(e, used) {
  const href = e.url ? safeHref(e.url) : null;
  return h(
    "li",
    { class: `ev${used ? " ev--used" : ""}` },
    h("span", { class: "ev__id t-mono", text: e.id }),
    h(
      "div",
      { class: "ev__body" },
      h("p", { class: "ev__head" }, h("span", { class: "ev__kind", text: EVIDENCE_KIND[e.kind] || e.label }), e.kind === "research" && !e.skipped && !e.error ? h("span", { class: "ev__tag", text: "fetched in sandbox" }) : null, used ? h("span", { class: "ev__tag", text: "cited" }) : null),
      h("p", { class: "ev__fact", text: e.fact }),
      e.signals.length ? h("ul", { class: "ev__signals" }, e.signals.map((x) => h("li", { text: x }))) : null,
      e.excerpt ? h("blockquote", { class: "ev__quote", text: e.excerpt }) : null,
      href || e.fetchedAt
        ? h(
            "p",
            { class: "ev__meta t-micro c-3" },
            href ? h("a", { href, target: "_blank", rel: "noopener noreferrer nofollow", class: "t-mono" }, h("span", { text: displayUrl(e.url) }), icon("external", { size: 11 })) : null,
            e.fetchedAt ? h("span", { text: `${e.fetchedAt.replace("T", " ").slice(0, 19)} UTC${e.durationMs != null ? ` · ${formatDuration(e.durationMs)}` : ""}` }) : null
          )
        : null,
      e.error ? h("p", { class: "t-micro c-3", text: `Fetch failed: ${e.error}` }) : null
    )
  );
}

function anomalyCard(f, ctx) {
  const ext = f.extraction;
  const extOk = ext.onPage === true;
  const lanes = [
    {
      key: "extraction",
      label: "Extraction",
      status: extOk ? "done" : ext.onPage === false ? "failed" : "pending",
      title: extOk ? "Verified" : "Not confirmed",
      text: extOk
        ? `${kr(f.original)} is what the page says${ext.nextToName ? ", right next to the product name" : ""}${ctx.verdict === "verified" ? ", and the screenshot agrees." : "."}`
        : "The value could not be confirmed in the page text.",
    },
    {
      key: "plausibility",
      label: "Plausibility",
      status: "flag",
      title: "Unusual",
      list: f.signals.map((s) => s.detail),
    },
    {
      key: "investigation",
      label: "Investigation",
      status: f.assessment === "inconclusive" ? "pending" : "done",
      title: f.assessmentLabel,
      text: f.explanation,
      meta: `${f.confidence} confidence · ${f.method === "ai" ? `reasoned by ${f.model || "AI"}` : "rule-based"}${f.durationMs != null ? ` · ${formatDuration(f.durationMs)}` : ""}`,
    },
    {
      key: "outcome",
      label: "Outcome",
      status: "pending",
      title: "Value kept as listed",
      text: [`Original value preserved: ${kr(f.original)}.`, f.suggested != null ? `Suggested for review: ${kr(f.suggested)} (not applied).` : null, f.action || null].filter(Boolean).join(" "),
    },
  ];
  const used = new Set(f.evidenceUsed);
  return h(
    "article",
    { class: `anomaly anomaly--${f.assessment}`, id: `finding-${f.id}`, "aria-labelledby": `finding-${f.id}-t` },
    h(
      "header",
      { class: "anomaly__head" },
      mark("flag", { size: "lg" }),
      h("div", { class: "anomaly__id" }, h("h3", { id: `finding-${f.id}-t`, class: "anomaly__name", text: f.name }), h("p", { class: "anomaly__meta", text: `Listed at ${kr(f.original)}${f.category ? ` · ${f.category}` : ""}` })),
      h("p", { class: `anomaly__verdict anomaly__verdict--${f.assessment}` }, h("span", { class: "anomaly__verdict-label", text: f.assessmentLabel }), h("span", { class: "anomaly__verdict-conf", text: `${f.confidence} confidence` }))
    ),
    h(
      "ol",
      { class: "lanes" },
      lanes.map((l) =>
        h(
          "li",
          { class: `lane lane--${l.key}` },
          h("p", { class: "lane__label", text: l.label }),
          h(
            "div",
            { class: "lane__body" },
            h("p", { class: "lane__title" }, mark(l.status, { size: "sm" }), h("span", { text: l.title })),
            l.text ? h("p", { class: "lane__text", text: l.text }) : null,
            l.list ? h("ul", { class: "lane__list" }, l.list.map((x) => h("li", { text: x }))) : null,
            l.meta ? h("p", { class: "lane__meta", text: l.meta }) : null
          )
        )
      )
    ),
    f.hint ? h("p", { class: "anomaly__hint t-micro c-3", text: `Pattern check: ${f.hint}.` }) : null,
    f.note ? h("p", { class: "anomaly__hint t-micro c-3", text: f.note }) : null,
    disclosure(`Evidence · ${pluralize(f.evidence.length, "source")}`, () => h("ol", { class: "evlist" }, f.evidence.map((e) => evidenceItem(e, used.has(e.id)))), { key: `ev-${f.id}`, openSet: ctx.openSet, className: "anomaly__evidence" })
  );
}

function anomalies(block, ctx) {
  const list = (block.refs || []).map((id) => ctx.intel.findingsById?.get(id)).filter(Boolean);
  if (!list.length) return null;
  const extra = ctx.intel.uninvestigated?.length || 0;
  return h(
    "div",
    { class: "anomalies" },
    h("p", { class: "dblock__lede", text: "Each value below was extracted correctly, then judged separately for plausibility. Nothing was changed: the agent investigated and explains what it found." }),
    list.map((f) => anomalyCard(f, ctx)),
    extra ? h("p", { class: "t-small c-3", text: `${extra} more flagged value${extra === 1 ? " was" : "s were"} not investigated (budget: ${ctx.intel.research?.investigation_budget ?? "?"} per run).` }) : null
  );
}

/* ---- data quality: two lanes ------------------------------------------ */

function check(c) {
  return h("li", { class: "qcheck" }, mark(c.ok === true ? "done" : c.ok === false ? "flag" : "skipped", { size: "sm", label: c.ok === true ? "Passed" : c.ok === false ? "Needs attention" : "Not applicable" }), h("div", null, h("p", { class: "qcheck__label", text: c.label }), h("p", { class: "qcheck__detail", text: c.detail })));
}

function quality(block, ctx) {
  const intel = ctx.intel;
  let extraction;
  let plausibility;
  if (intel.status === "done") {
    extraction = intel.checks.filter((c) => c.lane === "extraction");
    plausibility = intel.checks.filter((c) => c.lane === "plausibility");
    const s = intel.summary || {};
    plausibility.unshift({ label: "Values plausible", ok: !s.flagged, detail: s.flagged ? `${s.flagged} of ${s.records} values flagged and investigated` : `all ${s.records} values within expected ranges` });
  } else {
    const a = ctx.job.finalAttempt;
    extraction = a ? [{ label: "Verification", ok: a.verdict === "verified" ? true : a.verdict === "rejected" ? false : null, detail: a.reason || "No verification detail reported." }] : [];
    plausibility = [{ label: "Plausibility analysis", ok: null, detail: intel.status === "running" ? "Running…" : intel.status === "error" ? `Failed: ${intel.error || "unknown error"}. Extraction results are unaffected.` : "Not available on this backend." }];
  }
  return h(
    "div",
    { class: "quality" },
    h("div", { class: "quality__lane" }, h("p", { class: "quality__q", text: "Extraction verification" }), h("p", { class: "quality__sub", text: "Is each value exactly what the page says?" }), h("ul", { class: "qchecks" }, extraction.map(check))),
    h("div", { class: "quality__lane" }, h("p", { class: "quality__q", text: "Semantic plausibility" }), h("p", { class: "quality__sub", text: "Is what the page says believable?" }), h("ul", { class: "qchecks" }, plausibility.map(check)))
  );
}

/* ---- data table -------------------------------------------------------- */

function table(block, ctx) {
  const { job, intel } = ctx;
  if (!job.results.length) {
    const a = job.finalAttempt;
    return emptyState("No records extracted", a?.failure ? `The final attempt did not produce usable records: ${a.failure.message}` : "The backend returned no records for this page.");
  }
  const rows = job.results.map((r, i) => {
    const rec = intel.recordsByIndex?.get(i);
    const out = r && typeof r === "object" ? { ...r } : { value: r };
    if (rec && out.category === undefined && rec.category && rec.category !== "Uncategorised") out.category = rec.category;
    if (rec && rec.previous_price != null) out.last_run_sek = rec.previous_price;
    Object.defineProperty(out, "__i", { value: i, enumerable: false });
    return out;
  });
  const columns = inferColumns(rows).map((c) => (c.key === "last_run_sek" ? { ...c, label: "Last run" } : c));
  const flagged = intel.flagged || new Set();
  return h(
    "div",
    { class: "data" },
    flagged.size ? h("p", { class: "data__note t-small c-2" }, mark("flag", { size: "sm" }), h("span", { text: `${pluralize(flagged.size, "record")} flagged for review. Values are shown exactly as extracted.` })) : null,
    dataTable(rows, columns, { caption: "Extracted records", rowMarker: flagged.size ? (r) => (flagged.has(r.__i) ? mark("flag", { size: "sm" }) : null) : null, markerLabel: "Review" })
  );
}

function evidence(block, ctx) {
  const columns = inferColumns(ctx.job.results);
  return evidenceViewer(ctx.job, columns, primaryColumn(columns));
}

/* ---- history ----------------------------------------------------------- */

function history(block) {
  const rows = block.rows || [];
  if (!rows.length) return null;
  return h(
    "div",
    { class: "table__scroll", tabindex: "0", role: "region", "aria-label": block.title },
    h(
      "table",
      { class: "ledger ledger--compact" },
      h("thead", null, h("tr", null, ["Product", "Last run", "Now", "Change"].map((t, i) => h("th", { scope: "col", class: i ? "align-end" : "align-start", text: t })))),
      h(
        "tbody",
        null,
        rows.map((r) => {
          const d = r.after / r.before - 1;
          return h(
            "tr",
            { class: r.flagged ? "is-flagged" : null },
            h("td", null, r.flagged ? mark("flag", { size: "sm" }) : null, h("span", { text: r.name })),
            h("td", { class: "align-end t-num", text: kr(r.before) }),
            h("td", { class: "align-end t-num", text: kr(r.after) }),
            h("td", { class: "align-end t-num", text: d === 0 ? "—" : `${d > 0 ? "+" : "−"}${Math.abs(d * 100).toFixed(Math.abs(d) >= 1 ? 0 : 1)}%` })
          );
        })
      )
    )
  );
}

/* ---- scraper registry -------------------------------------------------- */

function scraper(block, ctx) {
  const sc = ctx.intel.scraper;
  if (!sc) return null;
  const drift = ctx.intel.drift;
  const facts = [
    ["Version", `v${sc.version}${sc.parent ? ` (from v${sc.parent})` : ""}`],
    ["This run", sc.reused_code ? "Reused the saved scraper, no AI code call" : sc.source === "repaired" ? "Repaired and saved as a new version" : "Generated and saved"],
    ["Verified runs", String(sc.runs ?? "—")],
    ["Created", sc.created_at ? formatTime(new Date(sc.created_at)) : "—"],
    ["Code fingerprint", sc.code_sha256 ? `sha256 ${sc.code_sha256.slice(0, 12)}…` : "—"],
  ];
  const schema = sc.schema?.items || {};
  const crit = sc.criteria || {};
  return h(
    "div",
    { class: "scraperreg" },
    h("dl", { class: "facts" }, facts.map(([k, v]) => h("div", { class: "fact" }, h("dt", { class: "t-small c-3", text: k }), h("dd", { class: "t-small", text: v })))),
    h(
      "div",
      { class: "scraperreg__cols" },
      h(
        "div",
        null,
        h("p", { class: "t-eyebrow", text: "Saved extraction schema" }),
        h("ul", { class: "schema" }, Object.entries(schema).map(([k, v]) => h("li", null, h("code", { text: k }), h("span", { class: "c-3", text: ` ${v.type}${v.required ? ", required" : ""}${v.minimum ? `, ≥ ${v.minimum}` : ""}` }))))
      ),
      h(
        "div",
        null,
        h("p", { class: "t-eyebrow", text: "Verification criteria" }),
        h(
          "ul",
          { class: "schema" },
          [
            crit.min_records != null ? `${crit.min_records}–${crit.max_records} records` : null,
            crit.min_name_overlap ? `≥ ${Math.round(crit.min_name_overlap * 100)}% of known products present` : null,
            crit.evidence_check ? `Evidence check: ${crit.evidence_check}` : null,
            crit.vision_check ? `Screenshot check: ${crit.vision_check}` : null,
          ]
            .filter(Boolean)
            .map((t) => h("li", { text: t }))
        )
      )
    ),
    drift
      ? h(
          "div",
          { class: "drift" },
          h("p", { class: "t-eyebrow", text: `Compared with saved v${drift.version}: ${drift.status}` }),
          h("ul", { class: "qchecks" }, (drift.checks || []).map((c) => check({ label: c.label, ok: c.ok, detail: c.detail }))),
          drift.heal ? h("p", { class: "t-small c-2", text: `Self-healing triggered: ${drift.reason}` }) : null
        )
      : null
  );
}

/* ---- agent run + technical sections ----------------------------------- */

function methodSteps(job) {
  return h(
    "ol",
    { class: "method__steps" },
    job.stages.map((s) => h("li", { class: `method__step method__step--${s.status}` }, mark(s.status, { size: "sm" }), h("div", null, h("p", { class: "method__label", text: s.label }), h("p", { class: "t-small c-3", text: s.detail || s.description }))))
  );
}

function scraperCode(job) {
  const a = [...job.attempts].reverse().find((x) => x.succeeded) || job.finalAttempt;
  if (!a || !a.code) return emptyState("No scraper code", "The backend did not return any generated code.");
  return h("div", { class: "scraper" }, h("p", { class: "t-small c-2 scraper__note", text: `${a.succeeded ? `The verified scraper from attempt ${a.n}` : `The latest scraper (attempt ${a.n})`}. Shown as text; it only ever runs in the sandbox.` }), codeView(a.code, { filename: `attempt_${a.n}.py`, maxHeight: "32rem" }));
}

function agent(block, ctx) {
  const { job, intel, openSet } = ctx;
  const ran = job.attempts.filter((a) => a.ran);
  const sandboxMs = job.security.totalMs;
  const facts = [
    ["Attempts", String(job.attempts.length)],
    ["Repairs", String(Math.max(0, job.attempts.length - 1))],
    job.codeModelCalls != null ? ["AI code calls", String(job.codeModelCalls)] : null,
    job.visionCalls != null ? ["Vision checks", String(job.visionCalls)] : null,
    ["Sandbox runs", `${ran.length}${sandboxMs != null ? ` · ${formatDuration(sandboxMs)}` : ""}`],
    intel.research ? ["Research fetches", `${intel.research.fetches_used} of ${intel.research.fetch_budget} allowed`] : null,
    intel.durationMs != null ? ["Plausibility analysis", formatDuration(intel.durationMs)] : null,
  ].filter(Boolean);
  const caps = job.security.capabilities;
  const observed = caps.filter((c) => c.evidence === "run").length;
  const bench = caps.filter((c) => c.evidence === "benchmark" && c.status === "passed").length;
  return h(
    "div",
    { class: "agentrun" },
    h("dl", { class: "runfacts" }, facts.map(([k, v]) => h("div", { class: "runfact" }, h("dt", { text: k }), h("dd", { text: v })))),
    h(
      "div",
      { class: "tech" },
      disclosure("Self-healing & attempts", () => healingSection(job, { openSet }), { key: "t-heal", openSet, meta: pluralize(job.attempts.length, "attempt") }),
      disclosure("Methodology", () => methodSteps(job), { key: "t-method", openSet, meta: `${job.stages.length} stages` }),
      disclosure("Scraper code", () => scraperCode(job), { key: "t-code", openSet, meta: "Python" }),
      disclosure("Containment telemetry", () => securitySection(job), { key: "t-sec", openSet, meta: `${observed} observed this run · ${bench} by benchmark` })
    )
  );
}

/* ---- registry ---------------------------------------------------------- */

const RENDER = {
  kpis: (b) => blockShell(b, kpis(b), { wide: true }),
  findings: (b, c) => blockShell(b, findings(b, c)),
  anomalies: (b, c) => blockShell(b, anomalies(b, c), { wide: true, id: "needs-review" }),
  quality: (b, c) => blockShell(b, quality(b, c)),
  chart: (b) => blockShell(b, CHARTS[b.kind]?.(b)),
  table: (b, c) => blockShell(b, table(b, c), { wide: true }),
  evidence: (b, c) => blockShell(b, evidence(b, c), { wide: true }),
  history: (b) => blockShell(b, history(b)),
  scraper: (b, c) => blockShell(b, scraper(b, c), { wide: true }),
  agent: (b, c) => blockShell(b, agent(b, c), { wide: true }),
};

export function renderBlock(block, ctx) {
  const fn = RENDER[block.type];
  if (!fn) return null;
  try {
    return fn(block, ctx);
  } catch (err) {
    console.error("dashboard block failed", block.type, err);
    return null;
  }
}
