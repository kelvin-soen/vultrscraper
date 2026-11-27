"""FastAPI app: job API + static frontend.

Job loop: screenshot+HTML -> AI writes scraper -> sandbox run -> parse JSON ->
vision check vs screenshot -> on failure AI fixes the scraper -> retry (max 3).
"""
import json
import threading
import traceback
import uuid
from pathlib import Path

from fastapi import FastAPI, HTTPException
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

import ai_client
import config
import sandbox_client
import scrapers

app = FastAPI(title="Self-healing scraper")

JOBS: dict[str, dict] = {}
_lock = threading.Lock()


class JobIn(BaseModel):
    url: str


def parse_items(stdout: str) -> list[dict]:
    """Parse and validate scraper output. Raises ValueError with a readable reason."""
    text = stdout.strip()
    if not text:
        raise ValueError("scraper printed nothing to stdout")
    try:
        data = json.loads(text)
    except json.JSONDecodeError:
        # tolerate log lines before the JSON: try the last line
        try:
            data = json.loads(text.splitlines()[-1])
        except json.JSONDecodeError as e:
            raise ValueError(f"stdout is not valid JSON: {e}") from None
    if not isinstance(data, list):
        raise ValueError(f"expected a JSON array, got {type(data).__name__}")
    if not data:
        raise ValueError("scraper returned an empty list (no products found)")
    items = []
    for i, it in enumerate(data):
        if not isinstance(it, dict):
            raise ValueError(f"item {i} is not an object")
        name, price = it.get("name"), it.get("price_sek")
        if not isinstance(name, str) or not name.strip():
            raise ValueError(f"item {i} has missing/empty 'name'")
        if not isinstance(price, int) or isinstance(price, bool) or price <= 0:
            raise ValueError(f"item {i} ({name!r}) has invalid 'price_sek': {price!r}")
        items.append({"name": name.strip(), "price_sek": price})
    return items


def _check_attempt(job: dict, res: dict) -> tuple[bool, str, str, list[dict]]:
    """Returns (ok, verdict, reason, items)."""
    if res.get("timed_out"):
        return False, "fail", "scraper timed out", []
    if res.get("exit_code") != 0:
        last = (res.get("stderr") or "").strip().splitlines()[-1:] or ["(no stderr)"]
        return False, "fail", f"exit code {res.get('exit_code')}: {last[0][:300]}", []
    try:
        items = parse_items(res.get("stdout") or "")
    except ValueError as e:
        return False, "fail", str(e), []
    if not job["screenshot_base64"]:
        return True, "unverified", f"{len(items)} items parsed; no screenshot to verify against", items
    try:
        job["vision_calls"] += 1
        match, why = ai_client.vision_check(job["screenshot_base64"], items)
    except Exception as e:
        # Vision model down/garbled: accept parsed data but say it is unverified.
        return True, "unverified", f"{len(items)} items parsed; vision check error: {e}", items
    if match:
        return True, "pass", f"{len(items)} items; vision check agrees: {why}", items
    return False, "fail", f"vision check disagrees: {why}", items


def _run_job(job_id: str, url: str, saved_code: str | None = None) -> None:
    """Run the scrape loop. With `saved_code`, attempt 1 reuses it (no code-model call)."""
    job = JOBS[job_id]
    try:
        shot = sandbox_client.screenshot(url)
        job["screenshot_base64"] = shot.get("image_base64")
        html = shot.get("html") or ""

        source, retarget_error = "generated", None
        if saved_code is not None:
            source = "saved"
            try:
                code = scrapers.set_url(saved_code, url)
            except ValueError as e:
                code, retarget_error = saved_code, str(e)
        else:
            job["code_model_calls"] += 1
            code = ai_client.write_scraper(url, html)

        for n in range(1, config.MAX_ATTEMPTS + 1):
            attempt = {"n": n, "source": source, "code": code, "stdout": "", "stderr": "",
                       "exit_code": None, "verdict": "running", "reason": "running in sandbox"}
            job["attempts"].append(attempt)

            if retarget_error:  # can't safely point it at the new URL: don't run it
                ok, verdict, reason, items = False, "fail", retarget_error, []
                retarget_error = None
            else:
                res = sandbox_client.run(code, timeout=30)
                attempt.update(stdout=res.get("stdout", ""), stderr=res.get("stderr", ""),
                               exit_code=res.get("exit_code"))
                attempt["reason"] = "checking output"
                ok, verdict, reason, items = _check_attempt(job, res)
            if ok and source == "saved":
                reason = "saved scraper, still works; " + reason
            attempt.update(verdict=verdict, reason=reason)

            if ok:
                scrapers.save(url, code)
                job.update(results=items, final_code=code, status="done")
                return
            if n < config.MAX_ATTEMPTS:
                job["code_model_calls"] += 1
                code = ai_client.fix_scraper(url, html, code, reason,
                                             attempt["stderr"], attempt["stdout"])
                source = "repaired"

        job["status"] = "failed"
        job["error"] = f"no working scraper after {config.MAX_ATTEMPTS} attempts"
    except Exception as e:  # keep the error visible in the job, never crash the server
        traceback.print_exc()
        job["status"] = "failed"
        job["error"] = f"{type(e).__name__}: {e}"


def _check_url(url: str) -> None:
    if not url.startswith(("http://", "https://")):
        raise HTTPException(400, "url must start with http:// or https://")


def _start_job(url: str, saved_code: str | None = None, parent: str | None = None) -> str:
    job_id = uuid.uuid4().hex[:12]
    with _lock:
        JOBS[job_id] = {
            "status": "running", "url": url, "mode": "rerun" if saved_code else "new",
            "parent": parent, "attempts": [], "results": [], "screenshot_base64": None,
            "error": None, "final_code": None, "code_model_calls": 0, "vision_calls": 0,
        }
    threading.Thread(target=_run_job, args=(job_id, url, saved_code), daemon=True).start()
    return job_id


@app.post("/api/jobs")
def create_job(body: JobIn):
    _check_url(body.url)
    return {"id": _start_job(body.url)}


@app.post("/api/jobs/{job_id}/rerun")
def rerun_job(job_id: str, body: JobIn):
    """Re-scrape with the saved scraper for this site; repair only if it breaks.
    Returns a NEW job id to poll."""
    _check_url(body.url)
    parent = JOBS.get(job_id)
    if parent is None:
        raise HTTPException(404, "job not found")
    saved = scrapers.get(body.url) or parent.get("final_code")
    if not saved:
        raise HTTPException(409, "no saved scraper for this site yet; run a normal job first")
    return {"id": _start_job(body.url, saved_code=saved, parent=job_id)}


@app.get("/api/scrapers")
def list_scrapers():
    return {"sites": scrapers.all_keys()}


@app.get("/api/jobs/{job_id}")
def get_job(job_id: str):
    job = JOBS.get(job_id)
    if job is None:
        raise HTTPException(404, "job not found")
    return job


@app.get("/api/health")
def health():
    return {"ok": True, "mock_sandbox": config.MOCK_SANDBOX}


# Static frontend last, so /api routes win.
_frontend = Path(__file__).resolve().parent.parent / "frontend"
if _frontend.is_dir():
    app.mount("/", StaticFiles(directory=_frontend, html=True), name="frontend")
