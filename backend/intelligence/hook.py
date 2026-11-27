"""The only surface main.py touches. Every function is safe to call: failures in the
intelligence layer are recorded in the job and never break an extraction.

Feature flag: INTELLIGENCE=0 turns the whole layer off (main behaves exactly as before).
"""
import logging
import os
import traceback

log = logging.getLogger("uvicorn.error")
ENABLED = os.getenv("INTELLIGENCE", "1") == "1"


def saved_scraper(url: str) -> dict | None:
    """Last verified scraper version for this site, or None."""
    if not ENABLED:
        return None
    try:
        from . import registry
        return registry.active(url)
    except Exception:
        traceback.print_exc()
        return None


def drift_check(job: dict, url: str, items: list[dict], source: str) -> str | None:
    """For a REUSED scraper whose output passed verification: compare with the saved
    criteria. Returns a failure reason when self-healing is appropriate, else None."""
    if not ENABLED or source != "saved":
        return None
    try:
        from . import registry
        d = registry.drift(url, items)
        job.setdefault("intel_drift", []).append(d)
        return d["reason"] if d and d["heal"] else None
    except Exception:
        traceback.print_exc()
        return None


def after_success(job: dict, job_id: str, url: str, html: str, items: list[dict], code: str,
                  source: str, verdict: str) -> None:
    """Run the intelligence layer on a verified result. Fills job["intelligence"]."""
    if not ENABLED:
        return
    job["phase"] = "analyzing"
    job["intelligence"] = {"status": "running"}
    try:
        import ai_client
        import config
        import sandbox_client
        from . import pipeline

        def chat(messages):
            return ai_client._chat(messages, model=config.CODE_MODEL, max_tokens=config.CODE_MAX_TOKENS)

        drifts = job.get("intel_drift") or []
        intel = pipeline.analyze(job=job, job_id=job_id, url=url, html=html, items=items,
                                 code=code, source=source, verdict=verdict,
                                 fetch=sandbox_client.screenshot,
                                 chat=None if os.getenv("INTEL_AI", "1") == "0" else chat,
                                 model=config.CODE_MODEL, drift=drifts[-1] if drifts else None)
        job["security"]["events"][:0] = intel.pop("security_events")  # this-run events first
        job["intelligence"] = intel
    except Exception as e:
        traceback.print_exc()
        job["intelligence"] = {"status": "error", "error": f"{type(e).__name__}: {str(e)[:300]}"}
    finally:
        job["phase"] = None


def on_reset() -> int:
    if not ENABLED:
        return 0
    try:
        from . import registry
        return registry.retire_all()
    except Exception:
        traceback.print_exc()
        return 0
