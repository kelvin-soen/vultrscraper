/**
 * Intelligence view-model: interprets the optional `intelligence` field of a job
 * (backend/intelligence/pipeline.py) and the dashboard specification inside it.
 *
 * The dashboard spec is DATA. It is validated here against a fixed whitelist of
 * block types and chart kinds; anything else is dropped. The frontend renders
 * validated blocks with predefined components only (js/dashboard/registry.js).
 *
 * Without an intelligence payload (older backends), a minimal spec is derived from
 * the extracted records so the report still works. It never claims plausibility
 * checks that did not run.
 */

import { formatMoney } from "./format.js";
import { inferColumns, summarize } from "./schema.js";

export const BLOCK_TYPES = new Set(["kpis", "findings", "chart", "anomalies", "quality", "table", "evidence", "history", "scraper", "agent"]);
export const CHART_KINDS = new Set(["price_strip", "category_bars", "price_change"]);
export const VIEW_IDS = ["overview", "data", "agent"];
const VIEW_LABELS = { overview: "Overview", data: "Data & Evidence", agent: "Agent & Infrastructure" };

const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const arr = (v) => (Array.isArray(v) ? v : []);
const str = (v) => (v == null ? "" : String(v));
const num = (v) => (typeof v === "number" && Number.isFinite(v) ? v : null);

export const ASSESSMENT_LABELS = {
  likely_source_error: "Likely source error",
  plausible_unusual: "Unusual but plausible",
  extraction_error: "Likely extraction error",
  inconclusive: "Inconclusive",
};

function normFinding(f) {
  if (!isObj(f)) return null;
  const assessment = ASSESSMENT_LABELS[f.assessment] ? f.assessment : "inconclusive";
  return {
    id: str(f.id),
    index: num(f.record_index),
    name: str(f.name),
    original: num(f.original_value),
    valueChanged: f.value_changed === true,
    category: str(f.category),
    severity: str(f.severity) || "medium",
    signals: arr(f.signals).filter(isObj).map((s) => ({ id: str(s.id), detail: str(s.detail) })),
    hint: str(f.hint) || null,
    extraction: { onPage: f.extraction?.on_page ?? null, nextToName: f.extraction?.next_to_name ?? null },
    evidence: arr(f.evidence)
      .filter(isObj)
      .map((e) => ({
        id: str(e.id),
        kind: str(e.kind),
        label: str(e.label),
        fact: str(e.fact),
        url: str(e.url) || null,
        excerpt: str(e.excerpt) || null,
        fetchedAt: str(e.fetched_at) || null,
        durationMs: num(e.duration_ms),
        prices: arr(e.prices_found).filter((x) => typeof x === "number"),
        error: str(e.error) || null,
        skipped: e.skipped === true,
        signals: arr(e.signals).map(str),
      })),
    assessment,
    assessmentLabel: ASSESSMENT_LABELS[assessment],
    confidence: ["low", "medium", "high"].includes(f.confidence) ? f.confidence : "low",
    explanation: str(f.explanation),
    evidenceUsed: arr(f.evidence_used).map(str),
    suggested: num(f.suggested_value),
    action: str(f.recommended_action),
    method: f.method === "ai" ? "ai" : "rules",
    model: str(f.model) || null,
    note: str(f.note) || null,
    durationMs: num(f.duration_ms),
  };
}

function validBlock(b) {
  if (!isObj(b) || !BLOCK_TYPES.has(b.type)) return false;
  if (b.type === "chart" && !CHART_KINDS.has(b.kind)) return false;
  return true;
}

/** Keep only known views and whitelisted blocks; always return the three views. */
export function validateSpec(spec) {
  const views = new Map();
  if (isObj(spec) && spec.spec_version === 1) {
    for (const v of arr(spec.views)) {
      if (!isObj(v) || !VIEW_IDS.includes(v.id)) continue;
      views.set(v.id, { id: v.id, label: VIEW_LABELS[v.id], blocks: arr(v.blocks).filter(validBlock) });
    }
  }
  return VIEW_IDS.map((id) => views.get(id) || { id, label: VIEW_LABELS[id], blocks: [] });
}

export function normalizeIntel(raw) {
  const r = isObj(raw) ? raw : null;
  if (!r) return { status: "absent" };
  const status = ["running", "done", "error"].includes(r.status) ? r.status : "absent";
  if (status !== "done") return { status, error: str(r.error) || null };
  const q = isObj(r.quality) ? r.quality : {};
  const findings = arr(r.findings).map(normFinding).filter(Boolean);
  const records = arr(r.records).filter(isObj);
  return {
    status,
    durationMs: num(r.duration_ms),
    checks: arr(q.checks)
      .filter(isObj)
      .map((c) => ({ id: str(c.id), lane: c.lane === "plausibility" ? "plausibility" : "extraction", label: str(c.label), ok: c.ok === true ? true : c.ok === false ? false : null, detail: str(c.detail) })),
    summary: isObj(q.summary) ? q.summary : {},
    stats: isObj(q.stats) ? q.stats : {},
    records,
    recordsByIndex: new Map(records.map((x) => [x.index, x])),
    findings,
    findingsById: new Map(findings.map((f) => [f.id, f])),
    flagged: new Set(findings.map((f) => f.index).concat(records.filter((x) => x.flagged).map((x) => x.index))),
    uninvestigated: arr(r.uninvestigated),
    scraper: isObj(r.scraper) ? r.scraper : null,
    drift: isObj(r.drift) ? r.drift : null,
    history: isObj(r.history) ? r.history : null,
    research: isObj(r.research) ? r.research : null,
    views: validateSpec(r.dashboard),
    fromBackend: true,
  };
}

/** Minimal spec from the records alone (no plausibility layer on this backend). */
export function fallbackViews(job) {
  const columns = inferColumns(job.results);
  const money = columns.find((c) => c.type === "money");
  const name = columns.find((c) => /^(name|title|product)$/i.test(c.key)) || columns.find((c) => c.type === "text");
  const stats = job.results.length ? summarize(job.results, columns) : [];
  const ok = job.outcome.kind === "verified" || job.outcome.kind === "repaired";
  const kpis = stats.map((s) => ({ id: s.key, label: s.label, value: s.value }));
  kpis.push({ id: "verification", label: "Extraction", value: job.outcome.label, caption: ok ? "page text + screenshot" : "" });
  const overview = [{ type: "kpis", items: kpis }];
  if (job.results.length) {
    overview.push({
      type: "findings",
      title: "Key findings",
      items: [{ kind: ok ? "verified" : "insight", text: ok ? `${job.results.length} records were extracted and verified against the page.` : job.outcome.detail }],
    });
  }
  if (money && name && job.results.length >= 3) {
    overview.push({
      type: "chart",
      kind: "price_strip",
      title: "Where each price sits",
      subtitle: "One dot per record.",
      points: job.results.map((r, i) => ({ i, name: str(r?.[name.key]), value: num(r?.[money.key]), group: "All records", flagged: false, band: null })).filter((p) => p.value != null),
      scale: "linear",
      currency: money.currency,
    });
  }
  overview.push({ type: "quality", title: "Data quality" });
  return validateSpec({
    spec_version: 1,
    views: [
      { id: "overview", blocks: overview },
      { id: "data", blocks: [{ type: "table", title: "Extracted records" }, { type: "evidence", title: "Evidence" }] },
      { id: "agent", blocks: [{ type: "agent", title: "Run" }] },
    ],
  });
}

export const kr = (n) => formatMoney(n, "SEK");
