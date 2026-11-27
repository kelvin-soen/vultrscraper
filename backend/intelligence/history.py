"""Historical observations: every verified record, per site and product.

Layout: {site_key: {product_key: [{"price", "name", "job_id", "at", "scraper_version",
                                   "flagged"}, ...newest last]}}
Comparisons use the newest UNFLAGGED observation from another job, so one anomalous
value never becomes the baseline for the next run.
"""
import re
import time

from .store import JsonStore

MAX_PER_PRODUCT = 20
_store = JsonStore("observations")


def product_key(name: str) -> str:
    return re.sub(r"[^\w]+", " ", str(name).lower()).strip()


def now_iso() -> str:
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())


def previous(site: str, job_id: str) -> dict:
    """{product_key: last unflagged observation from another job} for one site."""
    data = _store.load().get(site, {})
    out = {}
    for key, obs in data.items():
        for o in reversed(obs):
            if o.get("job_id") != job_id and not o.get("flagged"):
                out[key] = o
                break
    return out


def runs(site: str, limit: int = 8) -> list[dict]:
    """Earlier jobs on this site, newest first: [{"job_id", "at", "records"}]."""
    data = _store.load().get(site, {})
    jobs: dict[str, dict] = {}
    for obs in data.values():
        for o in obs:
            j = jobs.setdefault(o["job_id"], {"job_id": o["job_id"], "at": o["at"], "records": 0})
            j["records"] += 1
    return sorted(jobs.values(), key=lambda j: j["at"], reverse=True)[:limit]


def record(site: str, job_id: str, items: list[dict], scraper_version: int | None,
           flagged: set[int]) -> int:
    at = now_iso()

    def _do(data):
        site_obs = data.setdefault(site, {})
        for i, it in enumerate(items):
            obs = site_obs.setdefault(product_key(it["name"]), [])
            obs.append({"price": it["price_sek"], "name": it["name"], "job_id": job_id, "at": at,
                        "scraper_version": scraper_version, "flagged": i in flagged})
            del obs[:-MAX_PER_PRODUCT]
        return len(items)

    return _store.update(_do)


def clear(site: str | None = None) -> int:
    def _do(data):
        if site is None:
            n = len(data)
            data.clear()
            return n
        return 1 if data.pop(site, None) is not None else 0

    return _store.update(_do)
