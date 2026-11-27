"""Versioned scraper registry: reusable scrapers with saved extraction schemas and
verification criteria.

Per site (URL without query/fragment) a list of versions, newest last:
  {"version": 3, "code": "...", "code_sha256": "...", "source": "generated|repaired|saved",
   "parent": 2, "status": "active|superseded|retired", "created_at", "created_by_job",
   "last_verified_at", "last_job_id", "runs": 4, "verdict": "pass|unverified",
   "schema": {...}, "criteria": {...}, "baseline": {"count", "names": [...]}}

The scraper code is stored and shown as text only; it is executed exclusively by the
sandbox runtime, exactly like freshly generated code.
"""
import hashlib
import math
import re
from urllib.parse import urlsplit, urlunsplit

from .history import now_iso, product_key
from .store import JsonStore

_store = JsonStore("scrapers")
MAX_VERSIONS = 25


def site_key(url: str) -> str:
    p = urlsplit(url)
    return urlunsplit((p.scheme, p.netloc, p.path, "", ""))


_URL_LINE = re.compile(r"^URL\s*=\s*.*$", re.MULTILINE)


def _sha(code: str) -> str:
    """Identity of a scraper. The `URL = ...` line is normalised because the backend
    retargets a saved scraper at each run's URL (scrapers.set_url); that is reuse, not
    a new version."""
    norm = _URL_LINE.sub("URL = <target>", code.strip(), count=1)
    return hashlib.sha256(norm.encode("utf-8")).hexdigest()


def infer_schema(items: list[dict]) -> dict:
    """Field types and requiredness from verified output (JSON-Schema-like, declarative)."""
    fields: dict[str, dict] = {}
    for it in items:
        for k, v in it.items():
            t = ("integer" if isinstance(v, int) and not isinstance(v, bool) else
                 "number" if isinstance(v, float) else "boolean" if isinstance(v, bool) else
                 "string" if isinstance(v, str) else "object")
            f = fields.setdefault(k, {"type": t, "present": 0})
            if f["type"] != t:
                f["type"] = "mixed"
            f["present"] += 1
    out = {}
    for k, f in fields.items():
        spec = {"type": f["type"], "required": f["present"] == len(items)}
        if k == "price_sek":
            spec["minimum"] = 1
        out[k] = spec
    return {"type": "array", "items": out}


def derive_criteria(items: list[dict], schema: dict, verdict: str) -> dict:
    n = len(items)
    prices = [it["price_sek"] for it in items if isinstance(it.get("price_sek"), int)]
    return {
        "required_fields": sorted(k for k, s in schema["items"].items() if s["required"]),
        "min_records": max(1, math.floor(n * 0.5)),
        "max_records": n * 3 + 10,
        "min_name_overlap": 0.5 if n >= 3 else 0.0,
        "evidence_check": "required",
        "vision_check": "required" if verdict == "pass" else "attempted",
        "observed_price_range_sek": [min(prices), max(prices)] if prices else None,
    }


def active(url: str) -> dict | None:
    for v in reversed(_store.load().get(site_key(url), [])):
        if v["status"] == "active":
            return v
    return None


def versions(url: str) -> list[dict]:
    return list(_store.load().get(site_key(url), []))


def sites() -> list[dict]:
    out = []
    for site, vs in _store.load().items():
        act = next((v for v in reversed(vs) if v["status"] == "active"), None)
        out.append({"site": site, "versions": len(vs), "active_version": act["version"] if act else None,
                    "last_verified_at": act["last_verified_at"] if act else None})
    return sorted(out, key=lambda s: s["site"])


def record_verified(url: str, code: str, items: list[dict], job_id: str, source: str,
                    verdict: str) -> dict:
    """Store a verified scraper. Same code as the active version -> that version gets one
    more verified run. New code -> a new version; the old one is superseded.
    Returns {"version", "reused": bool, "new_version": bool, ...version summary}."""
    site, sha, at = site_key(url), _sha(code), now_iso()
    schema = infer_schema(items)

    def _do(data):
        vs = data.setdefault(site, [])
        act = next((v for v in reversed(vs) if v["status"] == "active"), None)
        baseline = {"count": len(items), "names": [product_key(it["name"]) for it in items][:500]}
        if act and act["code_sha256"] == sha:
            act.update(runs=act["runs"] + 1, last_verified_at=at, last_job_id=job_id, baseline=baseline)
            return summary(act, reused=True, new_version=False)
        if act:
            act["status"] = "superseded"
        v = {"version": (vs[-1]["version"] + 1) if vs else 1, "code": code, "code_sha256": sha,
             "source": source, "parent": act["version"] if act else None, "status": "active",
             "created_at": at, "created_by_job": job_id, "last_verified_at": at,
             "last_job_id": job_id, "runs": 1, "verdict": verdict, "schema": schema,
             "criteria": derive_criteria(items, schema, verdict), "baseline": baseline}
        vs.append(v)
        del vs[:-MAX_VERSIONS]
        return summary(v, reused=False, new_version=True)

    return _store.update(_do)


def summary(v: dict, **extra) -> dict:
    keys = ("version", "code_sha256", "source", "parent", "status", "created_at", "created_by_job",
            "last_verified_at", "last_job_id", "runs", "verdict", "schema", "criteria")
    return {**{k: v.get(k) for k in keys}, **extra}


def drift(url: str, items: list[dict]) -> dict | None:
    """Compare a verified result with the active version's saved criteria and baseline.
    -> None (no saved version) or {"status": "stable|changed|drift", "heal": bool,
       "reason": str|None, "checks": [{"id", "label", "ok", "detail"}], "version"}.
    "heal" means: the output still passed verification but no longer looks like what this
    scraper used to return (schema or volume collapsed), so a repair is appropriate."""
    act = active(url)
    if not act:
        return None
    crit, base = act["criteria"], act.get("baseline") or {}
    n = len(items)
    checks = []

    missing = [f for f in crit["required_fields"] if any(f not in it for it in items)]
    checks.append({"id": "schema", "label": "Saved extraction schema", "ok": not missing,
                   "detail": "all required fields present" if not missing
                   else f"missing required fields: {', '.join(missing)}"})

    vol_ok = crit["min_records"] <= n <= crit["max_records"]
    checks.append({"id": "volume", "label": "Record count", "ok": vol_ok,
                   "detail": f"{n} records (baseline {base.get('count', '?')}, accepted "
                             f"{crit['min_records']}–{crit['max_records']})"})

    names_now = {product_key(it["name"]) for it in items}
    names_before = set(base.get("names") or [])
    overlap = len(names_now & names_before) / len(names_before) if names_before else 1.0
    ov_ok = overlap >= crit.get("min_name_overlap", 0)
    added, removed = len(names_now - names_before), len(names_before - names_now)
    checks.append({"id": "identity", "label": "Same products as before", "ok": ov_ok,
                   "detail": f"{round(overlap * 100)}% of previous products found; {added} new, "
                             f"{removed} no longer listed"})

    failed = [c for c in checks if not c["ok"]]
    heal = any(c["id"] in ("schema", "volume") for c in failed)
    status = "drift" if failed else ("changed" if added or removed else "stable")
    reason = None
    if heal:
        reason = "result drift vs saved scraper v{}: {}".format(
            act["version"], "; ".join(c["detail"] for c in failed if c["id"] in ("schema", "volume")))
    return {"status": status, "heal": heal, "reason": reason, "checks": checks,
            "version": act["version"]}


def retire_all() -> int:
    """Demo reset: no active scraper anywhere; versions are kept for the audit trail."""
    def _do(data):
        n = 0
        for vs in data.values():
            for v in vs:
                if v["status"] == "active":
                    v["status"] = "retired"
                    n += 1
        return n

    return _store.update(_do)
