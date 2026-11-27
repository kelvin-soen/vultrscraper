"""siftform MCP server (stdio).

Exposes two tools that call the public siftform API, nothing else:
  extract_data(url)  start a scrape job and wait for it (max 200 s)
  get_job(job_id)    summarize an existing job

The API base URL comes from SIFTFORM_URL (default http://70.34.217.56:8000).
stdout is the MCP channel, so all logging goes to stderr.
"""
from __future__ import annotations

import asyncio
import logging
import os
import sys
import time
from typing import Any
from urllib.parse import quote

import httpx
from mcp.server.fastmcp import FastMCP

BASE_URL = os.environ.get("SIFTFORM_URL", "http://70.34.217.56:8000").rstrip("/")
POLL_INTERVAL_S = 2.0
MAX_WAIT_S = 200.0
HTTP_TIMEOUT_S = 30.0

logging.basicConfig(stream=sys.stderr, level=logging.INFO, format="%(asctime)s siftform-mcp %(levelname)s %(message)s")
log = logging.getLogger("siftform-mcp")

mcp = FastMCP("siftform")


class SiftformError(RuntimeError):
    """Raised with a message that is safe and useful to show to the model."""


def _check(resp: httpx.Response, what: str) -> Any:
    if resp.status_code == 404:
        raise SiftformError(f"{what}: job not found (404). Jobs are kept in memory and disappear when the siftform backend restarts.")
    if resp.status_code >= 400:
        detail = resp.text[:300]
        try:
            body = resp.json()
            if isinstance(body, dict) and body.get("detail"):
                detail = str(body["detail"])[:300]
        except ValueError:
            pass
        raise SiftformError(f"{what}: siftform API returned HTTP {resp.status_code}: {detail}")
    try:
        return resp.json()
    except ValueError as exc:
        raise SiftformError(f"{what}: siftform API did not return JSON") from exc


def _result_row(r: Any) -> dict[str, Any]:
    if not isinstance(r, dict):
        return {"name": str(r), "price_sek": None}
    return {"name": r.get("name", r.get("title")), "price_sek": r.get("price_sek", r.get("price"))}


def summarize(job_id: str, job: dict[str, Any]) -> dict[str, Any]:
    """The compact view both tools return."""
    attempts = job.get("attempts") if isinstance(job.get("attempts"), list) else []
    last = attempts[-1] if attempts and isinstance(attempts[-1], dict) else {}
    security = job.get("security") if isinstance(job.get("security"), dict) else {}
    events = security.get("events") if isinstance(security.get("events"), list) else []
    results = job.get("results") if isinstance(job.get("results"), list) else []
    return {
        "job_id": job_id,
        "status": job.get("status"),
        "url": job.get("url"),
        "title": job.get("title"),
        "error": job.get("error"),
        "result_count": len(results),
        "results": [_result_row(r) for r in results],
        "verification": {
            "verdict": last.get("verdict"),
            "reason": last.get("reason"),
            "attempts": len(attempts),
        },
        "security_events": [
            {
                "kind": e.get("kind"),
                "status": e.get("status"),
                "source": e.get("source", "this_job"),
                "detail": e.get("detail"),
            }
            for e in events
            if isinstance(e, dict)
        ],
        "view_url": f"{BASE_URL}/?job={quote(job_id, safe='')}",
    }


async def _fetch_job(client: httpx.AsyncClient, job_id: str) -> dict[str, Any]:
    resp = await client.get(f"{BASE_URL}/api/jobs/{quote(job_id, safe='')}")
    job = _check(resp, f"GET job {job_id}")
    if not isinstance(job, dict):
        raise SiftformError(f"GET job {job_id}: unexpected response shape")
    return job


@mcp.tool()
async def extract_data(url: str) -> dict[str, Any]:
    """Scrape structured product data (name, price_sek) from a web page with siftform.

    Starts a siftform job for `url`, polls it every 2 s for up to 200 s, and returns
    the job status, page title, extracted results, the verification reason and any
    security events (blocked requests, detected prompt injection, runtime benchmark).
    If the job is still running after 200 s, status is "running": call get_job later.
    """
    if not url.startswith(("http://", "https://")):
        raise SiftformError("url must start with http:// or https://")
    async with httpx.AsyncClient(timeout=HTTP_TIMEOUT_S) as client:
        resp = await client.post(f"{BASE_URL}/api/jobs", json={"url": url})
        created = _check(resp, "POST /api/jobs")
        job_id = str(created.get("id") or "") if isinstance(created, dict) else ""
        if not job_id:
            raise SiftformError("POST /api/jobs: response had no job id")
        log.info("started job %s for %s", job_id, url)

        deadline = time.monotonic() + MAX_WAIT_S
        while True:
            job = await _fetch_job(client, job_id)
            if job.get("status") not in ("running", "pending", "queued", None):
                return summarize(job_id, job)
            if time.monotonic() + POLL_INTERVAL_S > deadline:
                summary = summarize(job_id, job)
                summary["note"] = f"Still running after {int(MAX_WAIT_S)} s; call get_job('{job_id}') later."
                return summary
            await asyncio.sleep(POLL_INTERVAL_S)


@mcp.tool()
async def get_job(job_id: str) -> dict[str, Any]:
    """Return the summary (status, title, results, verification reason, security events) of an existing siftform job."""
    job_id = job_id.strip()
    if not job_id:
        raise SiftformError("job_id is empty")
    async with httpx.AsyncClient(timeout=HTTP_TIMEOUT_S) as client:
        return summarize(job_id, await _fetch_job(client, job_id))


def main() -> None:
    log.info("using siftform API at %s", BASE_URL)
    mcp.run(transport="stdio")


if __name__ == "__main__":
    main()
