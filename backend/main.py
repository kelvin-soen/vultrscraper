"""FastAPI app: job API + static frontend.

Step 1: a job fetches the page (via sandbox screenshot), asks the AI for a scraper,
and stores the code as attempt 1. Running/verifying/retrying comes later.
"""
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


def _run_job(job_id: str, url: str) -> None:
    job = JOBS[job_id]
    try:
        shot = sandbox_client.screenshot(url)
        job["screenshot_base64"] = shot.get("image_base64")
        code = ai_client.write_scraper(url, shot.get("html") or "")
        job["attempts"].append({
            "n": 1, "code": code, "stdout": "", "stderr": "",
            "exit_code": None, "verdict": "pending", "reason": "generated (not run yet)",
        })
        job["status"] = "done"
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
