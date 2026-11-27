"""Additive, read-only routes for the intelligence layer. Existing routes are unchanged."""
from fastapi import APIRouter, HTTPException

from . import history, registry

router = APIRouter(prefix="/api/intel", tags=["intelligence"])


def _check(url: str) -> None:
    if not url.startswith(("http://", "https://")):
        raise HTTPException(400, "url must start with http:// or https://")


@router.get("/scrapers")
def list_sites():
    """Every site with a scraper registry entry."""
    return {"sites": registry.sites()}


@router.get("/scrapers/versions")
def scraper_versions(url: str, include_code: bool = False):
    """Version history of the scraper for a site (code only when asked; shown as text)."""
    _check(url)
    vs = registry.versions(url)
    out = []
    for v in reversed(vs):
        s = registry.summary(v)
        if include_code:
            s["code"] = v["code"]
        out.append(s)
    return {"site": registry.site_key(url), "versions": out}


@router.get("/history")
def site_history(url: str):
    """Earlier verified runs on a site (observation counts per job)."""
    _check(url)
    site = registry.site_key(url)
    return {"site": site, "runs": history.runs(site, limit=20)}
