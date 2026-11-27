"""Orchestration: verified extraction -> intelligence payload (job["intelligence"])."""
import time
from concurrent.futures import ThreadPoolExecutor

from . import SCHEMA_VERSION, dashboard, history, investigate, quality, registry


def analyze(*, job: dict, job_id: str, url: str, html: str, items: list[dict], code: str,
            source: str, verdict: str, fetch, chat, model: str | None,
            drift: dict | None = None) -> dict:
    t0, started = time.monotonic(), history.now_iso()
    site = registry.site_key(url)
    prev = history.previous(site, job_id)
    if drift is None:
        drift = registry.drift(url, items)  # before this run is recorded
    analysis = quality.analyze(items, html, prev, verdict=verdict)

    flagged = sorted((r for r in analysis["records"] if r["flagged"]), key=lambda r: -r["score"])
    to_check = flagged[:investigate.MAX_INVESTIGATIONS]
    budget = investigate.Budget()
    events: list[dict] = []
    findings = []
    if to_check:
        with ThreadPoolExecutor(max_workers=len(to_check)) as pool:
            futs = [pool.submit(investigate.investigate, r, analysis, url, html, fetch=fetch, chat=chat,
                                model=model, budget=budget, security_events=events) for r in to_check]
            findings = [f.result() for f in futs]
        findings.sort(key=lambda f: f["record_index"])
    uninvestigated = [r["index"] for r in flagged[investigate.MAX_INVESTIGATIONS:]]

    scraper = registry.record_verified(url, code, items, job_id, source, verdict)
    scraper.update(site=site, reused_code=(source == "saved"))
    history.record(site, job_id, items, scraper["version"], {r["index"] for r in flagged})

    spec = dashboard.build(job, analysis, findings, scraper, drift, verdict)
    records = [{"index": r["index"], "category": r["category"]["label"],
                "category_source": r["category"]["source"], "flagged": r["flagged"],
                "severity": r["severity"], "signals": [s["detail"] for s in r["signals"]],
                "previous_price": r["previous"]["price"] if r.get("previous") else None,
                "on_page": r["on_page"], "next_to_name": r["location"].get("price_near_name"),
                "excerpt": r["location"].get("excerpt")} for r in analysis["records"]]
    return {
        "version": SCHEMA_VERSION, "status": "done", "started_at": started, "finished_at": history.now_iso(),
        "duration_ms": round((time.monotonic() - t0) * 1000),
        "quality": {"checks": analysis["checks"], "summary": analysis["summary"], "stats": analysis["stats"]},
        "records": records, "findings": findings, "uninvestigated": uninvestigated,
        "scraper": scraper, "drift": drift,
        "history": {"site": site, "runs": history.runs(site), "compared": sum(1 for r in records if r["previous_price"])},
        "research": {"fetches_used": investigate.MAX_FETCHES - budget.fetches, "fetch_budget": investigate.MAX_FETCHES,
                     "investigation_budget": investigate.MAX_INVESTIGATIONS},
        "security_events": events,
        "dashboard": spec,
    }
