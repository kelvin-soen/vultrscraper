"""Vultr Agent Runtime: authenticated REST API in front of the sandbox controller."""
import asyncio
import base64
import json
import logging
import os
import time
from contextlib import asynccontextmanager

from fastapi import Depends, FastAPI, HTTPException, Query
from fastapi.responses import FileResponse, JSONResponse

from .auth import require_principal
from .config import PROFILES, settings
from .events import list_events
from .jobs import TERMINAL, JobManager, PolicyViolation
from .models import JobCreate, RunRequest, ScreenshotRequest

VERSION = "1.0.0"
logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s %(message)s")
manager: JobManager = None  # type: ignore


@asynccontextmanager
async def lifespan(_app):
    global manager
    manager = JobManager()
    await manager.start()
    yield


app = FastAPI(
    title="Vultr Agent Runtime",
    version=VERSION,
    description=(
        "Secure sandbox runtime for backend AI agents. Executes generated Python code and Playwright "
        "browser automation in disposable gVisor containers with default-deny networking, an "
        "SSRF-filtering egress proxy, resource limits and verifiable telemetry.\n\n"
        "Authenticate every request (except /health) with `Authorization: Bearer <api key>`."),
    lifespan=lifespan,
)


def _err(pv: PolicyViolation):
    return JSONResponse(status_code=pv.status, content={"error": pv.code, "detail": pv.message})


def _job_or_404(job_id, principal):
    job = manager.get(job_id, principal)
    if job is None:
        raise HTTPException(status_code=404, detail="job not found")
    return job


# ------------------------------------------------------------------ public
@app.get("/health", tags=["system"])
def health():
    return {"ok": True, "status": "ok", "version": VERSION, "oci_runtime": manager.executor.oci_runtime,
            "egress_proxy": "up" if manager.executor.proxy_running() else "down", **manager.stats()}


# ---------------------------------------------------------------- v1 jobs
@app.post("/v1/jobs", status_code=202, tags=["jobs"])
def create_job(req: JobCreate, principal: str = Depends(require_principal)):
    """Queue a sandbox job. Returns immediately; poll `GET /v1/jobs/{id}`."""
    try:
        job = manager.submit(principal, req)
    except PolicyViolation as pv:
        return _err(pv)
    return job.view()


@app.get("/v1/jobs/{job_id}", tags=["jobs"])
def get_job(job_id: str, principal: str = Depends(require_principal)):
    return _job_or_404(job_id, principal).view()


@app.get("/v1/jobs/{job_id}/result", tags=["jobs"])
def get_result(job_id: str, principal: str = Depends(require_principal)):
    job = _job_or_404(job_id, principal)
    if job.status not in TERMINAL:
        return JSONResponse(status_code=409, content={"error": "not_finished", "status": job.status})
    r = manager.load_result(job) or {}
    return {
        "job_id": job.id, "status": job.status, "error": job.error,
        "exit_code": r.get("exit_code"), "timed_out": job.telemetry.get("timed_out", False),
        "stdout": r.get("stdout", ""), "stderr": r.get("stderr", ""),
        "stdout_truncated": r.get("stdout_truncated", False), "stderr_truncated": r.get("stderr_truncated", False),
        "output": r.get("output"), "output_error": r.get("output_error"),
        "tests": r.get("tests"), "browser": r.get("browser"),
        "artifacts": job.artifacts, "artifacts_skipped": r.get("artifacts_skipped", []),
        "runner_error": r.get("runner_error"), "telemetry": job.telemetry,
    }


@app.get("/v1/jobs/{job_id}/artifacts", tags=["jobs"])
def list_artifacts(job_id: str, principal: str = Depends(require_principal)):
    job = _job_or_404(job_id, principal)
    return {"job_id": job.id, "status": job.status,
            "artifacts": [dict(a, url=f"/v1/jobs/{job.id}/artifacts/{a['name']}") for a in job.artifacts]}


@app.get("/v1/jobs/{job_id}/artifacts/{name}", tags=["jobs"])
def get_artifact(job_id: str, name: str, principal: str = Depends(require_principal)):
    """Download an artifact. Artifacts are untrusted sandbox output: always served
    as attachments with nosniff and a sandboxing CSP, never rendered inline."""
    job = _job_or_404(job_id, principal)
    path = manager.artifact_path(job, name)
    if not path or not os.path.isfile(path):
        raise HTTPException(status_code=404, detail="artifact not found")
    meta = next(a for a in job.artifacts if a["name"] == name)
    return FileResponse(path, media_type=meta["content_type"], filename=name, headers={
        "X-Content-Type-Options": "nosniff", "Content-Security-Policy": "sandbox; default-src 'none'",
        "Content-Disposition": f'attachment; filename="{name}"'})


@app.delete("/v1/jobs/{job_id}", status_code=202, tags=["jobs"])
def cancel_job(job_id: str, purge: bool = Query(False, description="Also delete stored results/artifacts of a finished job."),
               principal: str = Depends(require_principal)):
    """Cancel a queued or running job. The sandbox is killed and destroyed."""
    job = _job_or_404(job_id, principal)
    if purge and job.status in TERMINAL:
        manager.purge(job)
        return {"id": job.id, "status": job.status, "purged": True}
    return manager.cancel(job).view()


# --------------------------------------------------------- security/info
@app.get("/v1/profiles", tags=["system"])
def profiles(principal: str = Depends(require_principal)):
    return {name: {"networked": p.networked, "default_timeout_s": p.default_timeout_s, "max_timeout_s": p.max_timeout_s,
                   "memory_mb": p.memory_mb, "cpus": p.cpus, "pids_limit": p.pids} for name, p in PROFILES.items()}


@app.get("/v1/security/events", tags=["security"])
def security_events(since: int = 0, limit: int = Query(200, le=1000), principal: str = Depends(require_principal)):
    """Security events for the calling principal (policy violations, blocked egress, timeouts, OOM, ...)."""
    return {"events": list_events(principal=principal, since_seq=since, limit=limit)}


@app.get("/v1/security/benchmark", tags=["security"])
def benchmark(principal: str = Depends(require_principal)):
    """Latest machine-readable security benchmark results produced on this host."""
    try:
        with open(settings.benchmark_file) as f:
            return json.load(f)
    except FileNotFoundError:
        raise HTTPException(status_code=404, detail="no benchmark results yet")


# -------------------------------------------- compatibility (backend v0)
async def _wait(job, timeout):
    try:
        await asyncio.wait_for(job.done_event.wait(), timeout=timeout)
    except asyncio.TimeoutError:
        manager.cancel(job)
        await asyncio.wait_for(job.done_event.wait(), timeout=30)


def _compat_domains():
    return [d.strip() for d in settings.compat_allowed_domains.split(",") if d.strip()]


@app.post("/run", tags=["compat"])
async def compat_run(req: RunRequest, principal: str = Depends(require_principal)):
    """Backend v0 contract: run generated code synchronously.
    `network: true` uses the python-net profile (egress proxy, compat allowlist + trusted demo targets)."""
    body = {"profile": "python-net" if req.network else "python", "code": req.code,
            "limits": {"timeout_s": req.timeout}, "metadata": {"via": "compat/run"}}
    if req.network:
        body["network"] = {"allowed_domains": _compat_domains(), "allow_trusted_targets": True}
    try:
        job = manager.submit(principal, JobCreate(**body))
    except PolicyViolation as pv:
        return _err(pv)
    await _wait(job, req.timeout + 60)
    r = manager.load_result(job) or {}
    return {"stdout": r.get("stdout", ""), "stderr": r.get("stderr", "") or (job.error or ""),
            "exit_code": r.get("exit_code", -1 if job.status != "succeeded" else 0),
            "timed_out": job.status == "timeout", "duration_ms": job.telemetry.get("duration_ms"),
            "job_id": job.id, "status": job.status}


@app.post("/screenshot", tags=["compat"])
async def compat_screenshot(req: ScreenshotRequest, principal: str = Depends(require_principal)):
    """Backend v0 contract: load a URL in the sandboxed browser, return screenshot and HTML."""
    body = {"profile": "browser", "browser": {"url": req.url, "full_page": req.full_page},
            "network": {"allowed_domains": _compat_domains(), "allow_trusted_targets": True},
            "limits": {"timeout_s": req.timeout}, "metadata": {"via": "compat/screenshot"}}
    try:
        job = manager.submit(principal, JobCreate(**body))
    except PolicyViolation as pv:
        return _err(pv)
    await _wait(job, req.timeout + 60)
    r = manager.load_result(job) or {}
    br = r.get("browser") or {}
    image_b64, html = None, None
    for a in job.artifacts:
        path = manager.artifact_path(job, a["name"])
        if a["name"] == "screenshot.png":
            with open(path, "rb") as f:
                image_b64 = base64.b64encode(f.read()).decode()
        elif a["name"] == "page.html":
            with open(path, encoding="utf-8", errors="replace") as f:
                html = f.read()
    return {"image_base64": image_b64, "html": html, "status": br.get("status"),
            "final_url": br.get("final_url"), "error": job.error, "job_id": job.id, "job_status": job.status,
            "blocked_requests": br.get("blocked_requests", [])}


def run():
    import uvicorn
    if not settings.is_loopback_bind():
        # Public exposure gate: only after the six core containment tests passed on this host.
        try:
            with open(settings.benchmark_file) as f:
                bench = json.load(f)
            ok = bench.get("core_passed") is True and time.time() - bench.get("finished_at", 0) < 7 * 86400
        except (OSError, ValueError):
            ok = False
        if not ok:
            raise SystemExit("refusing non-loopback bind: core containment benchmark has not passed on this host "
                             "in the last 7 days (run runtime/benchmark/run_benchmark.py)")
    uvicorn.run(app, host=settings.bind, port=settings.port, log_level="info", proxy_headers=False,
                server_header=False)


if __name__ == "__main__":
    run()
