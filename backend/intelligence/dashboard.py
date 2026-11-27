"""Adaptive dashboard SPECIFICATION (data, not code).

The backend decides WHAT to show; the frontend renders it with a fixed registry of
predefined components (frontend/js/dashboard/registry.js). Unknown block types are
ignored by the frontend, so the spec can never execute anything.

Spec: {"spec_version": 1, "views": [{"id", "label", "blocks": [{"type", ...props}]}]}
Allowed block types: kpis, findings, chart, anomalies, quality, table, evidence,
history, scraper, agent (see FRONTEND_BLOCKS).
Chart kinds: price_strip, category_bars, price_change.
"""
FRONTEND_BLOCKS = {"kpis", "findings", "chart", "anomalies", "quality", "table", "evidence",
                   "history", "scraper", "agent"}
CHART_KINDS = {"price_strip", "category_bars", "price_change"}


def _fmt(n) -> str:
    return f"{round(n):,}".replace(",", " ") + " kr"


def _pct(r: float) -> str:
    d = (r - 1) * 100
    return f"{'+' if d > 0 else '−' if d < 0 else ''}{abs(d):.0f}%"


def key_findings(analysis: dict, findings: list[dict], verdict: str, drift: dict | None) -> list[dict]:
    recs, stats = analysis["records"], analysis["stats"]
    out = []
    n = stats["count"]
    if verdict == "pass":
        out.append({"kind": "verified", "text": f"All {n} prices were found on the page and confirmed on its screenshot."})
    else:
        out.append({"kind": "verified", "text": f"All {n} prices were found in the page text; the screenshot check was unavailable."})
    for f in findings:
        out.append({"kind": "attention", "ref": f["id"],
                    "text": f"{f['name']} is listed at {_fmt(f['original_value'])}. {f['assessment_label']}"
                            f" ({f['confidence']} confidence). Kept as listed and flagged for review."})
    cats = [c for c in stats["categories"] if c["key"] != "uncategorised" and c["count"] >= 2]
    if len(cats) >= 2:
        top = cats[0]
        out.append({"kind": "insight", "text": f"{top['label']}s are the most expensive category, "
                                               f"median {_fmt(top['median'])} across {top['count']} listings."})
    compared = [r for r in recs if r.get("previous")]
    if compared:
        changed = [r for r in compared if r["price_sek"] != r["previous"]["price"]]
        unflagged = [r for r in changed if not r["flagged"]]
        if not changed:
            out.append({"kind": "change", "text": f"All {len(compared)} known products kept their price since the last run."})
        else:
            big = max(unflagged or changed, key=lambda r: abs(r["price_sek"] / r["previous"]["price"] - 1))
            out.append({"kind": "change", "text": f"{len(changed)} of {len(compared)} known products changed price since the "
                                                  f"last run; largest: {big['name']} {_pct(big['price_sek'] / big['previous']['price'])}."})
        new = n - len(compared)
        if new:
            out.append({"kind": "change", "text": f"{new} product{'s' if new != 1 else ''} appear for the first time."})
    if drift and drift["status"] == "drift":
        out.append({"kind": "attention", "text": drift["reason"] or "The output drifted from the saved scraper's baseline."})
    return out[:6]


def build(job: dict, analysis: dict, findings: list[dict], scraper: dict | None,
          drift: dict | None, verdict: str) -> dict:
    recs, stats = analysis["records"], analysis["stats"]
    n, flagged = stats["count"], len(findings)
    outcome = ("Self-healed" if len(job.get("attempts") or []) > 1 else "Verified") if verdict == "pass" else "Evidence only"
    kpis = [
        {"id": "records", "label": "Records", "value": str(n)},
        {"id": "median", "label": "Median price", "value": _fmt(stats["median"])} if stats["median"] is not None else None,
        {"id": "range", "label": "Price range", "value": f"{_fmt(stats['min'])} – {_fmt(stats['max'])}"} if n else None,
        {"id": "verification", "label": "Extraction", "value": outcome,
         "caption": "page text + screenshot" if verdict == "pass" else "page text only"},
        {"id": "plausibility", "label": "Plausibility", "value": f"{n - flagged}/{n}",
         "caption": f"{flagged} flagged for review" if flagged else "no unusual values",
         "tone": "attention" if flagged else "default"},
    ]
    if scraper:
        kpis.append({"id": "scraper", "label": "Scraper", "value": f"v{scraper['version']}",
                     "caption": "reused, no AI code call" if scraper.get("reused_code") else
                     ("repaired this run" if scraper.get("source") == "repaired" else "new this run")})
    kpis = [k for k in kpis if k]

    points = [{"i": r["index"], "name": r["name"], "value": r["price_sek"], "group": r["category"]["label"],
               "flagged": r["flagged"], "band": r["category"]["band"]} for r in recs]
    charts = []
    if n >= 3:
        charts.append({"type": "chart", "kind": "price_strip", "title": "Where each price sits",
                       "subtitle": "One dot per product, grouped by category. Ringed dots are flagged.",
                       "points": points, "scale": "log" if stats["max"] / max(stats["min"], 1) > 20 else "linear"})
    cats = [c for c in stats["categories"] if c["count"] >= 1]
    if len(cats) >= 2:
        charts.append({"type": "chart", "kind": "category_bars", "title": "Median price by category",
                       "subtitle": "Line: typical retail range for the category (reference prior).",
                       "bars": [{"label": c["label"], "value": c["median"], "count": c["count"], "band": c["band"]} for c in cats]})
    changes = [{"i": r["index"], "name": r["name"], "before": r["previous"]["price"], "after": r["price_sek"],
                "flagged": r["flagged"]} for r in recs if r.get("previous")]
    if changes and any(c["before"] != c["after"] for c in changes):
        prev_at = max(r["previous"]["at"] for r in recs if r.get("previous"))
        charts.append({"type": "chart", "kind": "price_change", "title": "Change since the last run",
                       "subtitle": f"Each product's price now vs the last verified run ({prev_at[11:16]} UTC).",
                       "rows": changes})

    overview = [{"type": "kpis", "items": kpis},
                {"type": "findings", "title": "Key findings",
                 "items": key_findings(analysis, findings, verdict, drift)}]
    if findings:
        overview.append({"type": "anomalies", "title": "Needs review", "refs": [f["id"] for f in findings]})
    overview += charts[:3]
    overview.append({"type": "quality", "title": "Data quality", "checks": analysis["checks"]})

    data_view = [{"type": "table", "title": "Extracted records", "flags": [f["record_index"] for f in findings]},
                 {"type": "evidence", "title": "Evidence"}]
    if changes:
        data_view.append({"type": "history", "title": "Compared with the last run", "rows": changes})
    agent_view = [{"type": "agent", "title": "Run"}]
    if scraper:
        agent_view.insert(0, {"type": "scraper", "title": "Scraper", "site": scraper.get("site")})

    return {"spec_version": 1, "views": [
        {"id": "overview", "label": "Overview", "blocks": overview},
        {"id": "data", "label": "Data & Evidence", "blocks": data_view},
        {"id": "agent", "label": "Agent & Infrastructure", "blocks": agent_view},
    ]}
