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
        match, why = ai_client.vision_check(job["screenshot_base64"], items)
    except Exception as e:
        # Vision model down/garbled: accept parsed data but say it is unverified.
        return True, "unverified", f"{len(items)} items parsed; vision check error: {e}", items
    if match:
        return True, "pass", f"{len(items)} items; vision check agrees: {why}", items
    return False, "fail", f"vision check disagrees: {why}", items


def _run_job(job_id: str, url: str) -> None:
    job = JOBS[job_id]
    try:
        shot = sandbox_client.screenshot(url)
        job["screenshot_base64"] = shot.get("image_base64")
        html = shot.get("html") or ""
        code = ai_client.write_scraper(url, html)

        for n in range(1, config.MAX_ATTEMPTS + 1):
            attempt = {"n": n, "code": code, "stdout": "", "stderr": "",
                       "exit_code": None, "verdict": "running", "reason": "running in sandbox"}
            job["attempts"].append(attempt)

            res = sandbox_client.run(code, timeout=30)
            attempt.update(stdout=res.get("stdout", ""), stderr=res.get("stderr", ""),
                           exit_code=res.get("exit_code"))
            attempt["reason"] = "checking output"
            ok, verdict, reason, items = _check_attempt(job, res)
            attempt.update(verdict=verdict, reason=reason)

            if ok:
                job["results"] = items
                job["status"] = "done"
                return
            if n < config.MAX_ATTEMPTS:
                code = ai_client.fix_scraper(url, html, code, reason,
                                             attempt["stderr"], attempt["stdout"])

        job["status"] = "failed"
        job["error"] = f"no working scraper after {config.MAX_ATTEMPTS} attempts"
    except Exception as e:  # keep the error visible in the job, never crash the server
        traceback.print_exc()
        job["status"] = "failed"
        job["error"] = f"{type(e).__name__}: {e}"


@app.post("/api/jobs")
def create_job(body: JobIn):
    if not body.url.startswith(("http://", "https://")):
        raise HTTPException(400, "url must start with http:// or https://")
    job_id = uuid.uuid4().hex[:12]
    with _lock:
        JOBS[job_id] = {
            "status": "running", "url": body.url, "attempts": [],
            "results": [], "screenshot_base64": None, "error": None,
        }
    threading.Thread(target=_run_job, args=(job_id, body.url), daemon=True).start()
    return {"id": job_id}


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
