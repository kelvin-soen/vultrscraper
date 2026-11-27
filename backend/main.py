"""FastAPI app: job API + static frontend.

Job loop: screenshot+HTML -> AI writes scraper -> sandbox run -> parse JSON ->
vision check vs screenshot -> on failure AI fixes the scraper -> retry (max 3).
"""
import json
import threading
import time
import traceback
import uuid
from pathlib import Path

from fastapi import FastAPI, HTTPException
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

import ai_client
import config
import sandbox_client
import rendered
from intelligence import hook as intel_hook  # intelligence layer (INTELLIGENCE=0 disables)
from intelligence.api import router as intel_router
import scrapers
import verify

app = FastAPI(title="Self-healing scraper")
app.include_router(intel_router)

JOBS: dict[str, dict] = {}
RUN_TIMEOUT_S = 30
_lock = threading.Lock()


class JobIn(BaseModel):
    url: str


EMPTY_REASON = "scraper returned an empty list (no products found)"
JS_PAGE_MESSAGE = ("This site loads its products with JavaScript. siftform. currently scrapes HTML "
                   "pages; browser-based scraping is the next step.")


def _js_rendered(url: str, html: str) -> str | None:
    """If the rendered page has prices but the raw HTML (what requests gets) has almost
    none, return a technical explanation; else None."""
    rendered = verify.price_count(html)
    if rendered < 3:
        return None
    raw = sandbox_client.probe_raw_prices(url)
    if raw is None or raw.get("prices", 0) * 5 >= rendered:
        return None
    return (f"raw HTML (HTTP {raw.get('status')}, {raw.get('chars', 0):,} chars) has "
            f"{raw.get('prices')} prices, the browser-rendered page has {rendered}")


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
        raise ValueError(EMPTY_REASON)
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


def _check_attempt(job: dict, res: dict, html: str) -> tuple[bool, str, str, list[dict]]:
    """Returns (ok, verdict, reason, items).
    Order: run result -> JSON -> evidence check (page text, no AI) -> vision check."""
    if res.get("timed_out"):
        return False, "fail", "scraper timed out", []
    if res.get("exit_code") != 0:
        last = (res.get("stderr") or "").strip().splitlines()[-1:] or ["(no stderr)"]
        return False, "fail", f"exit code {res.get('exit_code')}: {last[0][:300]}", []
    try:
        items = parse_items(res.get("stdout") or "")
    except ValueError as e:
        return False, "fail", str(e), []

    ev_ok, ev_reason, items = verify.evidence_check(items, html)  # may drop unverified items
    if not ev_ok:
        return False, "fail", ev_reason, items
    head = f"{len(items)} items; {ev_reason}"

    if not job["screenshot_base64"]:
        return True, "unverified", f"{head}; no screenshot for vision check", items
    try:
        job["vision_calls"] += 1
        seen, cropped, vmodel = ai_client.vision_prices(job["screenshot_base64"])
        job["models"]["vision"] = vmodel
        match, why = verify.compare_prices(items, seen, cropped)
        why = f"{why} [{vmodel}]"
    except Exception as e:
        # Vision unavailable/garbled: evidence check passed, so accept but mark unverified.
        return True, "unverified", f"{head}; vision check error: {str(e)[:200]}", items
    if match:
        return True, "pass", f"{head}; {why}", items
    return False, "fail", why, items


MAX_SECURITY_EVENTS = 50


def _blocked_to_events(blocked: list[dict]) -> list[dict]:
    """/screenshot blocked_requests -> security.events (HANDOFF section 7.2).
    These are requests the page itself tried to make (e.g. exfiltration from a hostile
    page) that the runtime's egress proxy refused. URL/reason are untrusted page data."""
    events = []
    for b in blocked[:MAX_SECURITY_EVENTS]:
        reason = str(b.get("reason") or "blocked")[:100]
        target = str(b.get("url") or "?")[:200]
        events.append({"kind": "ssrf", "status": "blocked",
                       "detail": f"page request blocked by egress proxy ({reason}): {target}"})
    return events


def _injection_events(html: str) -> list[dict]:
    """Hidden instruction-like page text -> prompt_injection "detected" events.
    Detection only: the HTML is always passed to the model as untrusted data anyway."""
    events = []
    for f in verify.injection_findings(html):
        phrases = ", ".join(f'"{p[:60]}"' for p in f["phrases"])
        events.append({"kind": "prompt_injection", "status": "detected",
                       "detail": f"hidden page text with instruction-like phrases {phrases}: "
                                 f"\"{f['snippet']}\""})
    return events


# Runtime benchmark core test id -> frontend capability kind (js/model/job.js CAPABILITIES).
_BENCH_KIND = {"infinite_loop": "timeout", "sandbox_isolation": "filesystem", "ssrf": "ssrf",
               "prompt_injection": "prompt_injection", "secret_hygiene": "secrets",
               "lifecycle": "cleanup"}


def _benchmark_events(bench: dict | None) -> list[dict]:
    """Core benchmark results as events. Runtime-wide evidence, labelled as such."""
    if not bench:
        return []
    when = (bench.get("finished_at") or "unknown time").replace("T", " ").replace("Z", " UTC")
    events = []
    for t in bench.get("tests") or []:
        kind = _BENCH_KIND.get(t.get("id"))
        if not kind:
            continue
        result = "passed" if t.get("passed") else "failed"
        events.append({"kind": kind, "status": result, "source": "benchmark",
                       "detail": f"Runtime security benchmark, {when}: {t.get('name')} test "
                                 f"{result} (runtime-wide test, not observed in this job)."})
    return events


RENDERED_PREFIX = "rendered mode (parsed the browser-rendered page, no network): "


def _run_job(job_id: str, url: str, saved: dict | None = None) -> None:
    """Run the scrape loop. With `saved` ({"code", "mode"}), attempt 1 reuses that scraper
    (no code-model call). mode "html": the scraper fetches the page itself. mode "rendered":
    the scraper parses PAGE_HTML, the browser-rendered page embedded by rendered.py."""
    job = JOBS[job_id]
    saved_code = saved["code"] if saved else None
    mode = saved["mode"] if saved else "html"
    try:
        shot = sandbox_client.screenshot(url)
        job["security"]["events"].extend(_blocked_to_events(shot.get("blocked_requests") or []))
        job["security"]["events"].extend(_injection_events(shot.get("html") or ""))
        if shot.get("error") and not shot.get("html"):
            raise sandbox_client.SandboxError(f"could not load page: {str(shot['error'])[:300]}")
        job["screenshot_base64"] = shot.get("image_base64")
        html = shot.get("html") or ""
        job["title"] = verify.page_title(html)
        bench = sandbox_client.security_benchmark()
        job["security"]["benchmark"] = bench
        # After this job's own events, so a real "blocked"/"detected" decides the UI status.
        job["security"]["events"].extend(_benchmark_events(bench))

        code, retarget_error = None, None
        if saved_code is not None:
            try:
                code = scrapers.set_url(saved_code, url)
            except ValueError as e:
                code = saved_code
                if mode == "html":  # rendered scrapers never fetch URL, so no retarget needed
                    retarget_error = str(e)
        prev = None  # last failed attempt that had code: input for the repair prompt

        for n in range(1, config.MAX_ATTEMPTS + 1):
            if code is not None:
                source = "saved" if (saved_code is not None and n == 1) else "repaired"
            else:
                source = "generated" if prev is None else "repaired"
            attempt = {"n": n, "source": source, "code": code or "", "stdout": "", "stderr": "",
                       "exit_code": None, "verdict": "running",
                       "reason": "running in sandbox" if code else
                                 ("generating scraper" if prev is None else "repairing scraper"),
                       "timed_out": None, "duration_ms": None, "runtime_job_id": None,
                       "sandbox": None, "scrape_mode": mode}
            job["attempts"].append(attempt)

            if code is None:  # ask the code model; a slow/failed call fails only this attempt
                job["code_model_calls"] += 1
                try:
                    if prev is None:
                        code = ai_client.write_scraper(url, html, mode)
                    else:
                        code = ai_client.fix_scraper(url, html, prev["code"], prev["reason"],
                                                     prev["stderr"], prev["stdout"], mode)
                except ai_client.AIError as e:
                    attempt.update(verdict="fail", reason=f"AI code model failed: {e}")
                    continue
                job["models"]["code"] = attempt["code_model"] = ai_client.last_code_model()
                attempt.update(code=code, reason="running in sandbox")

            run_code, build_error = code, None
            if mode == "rendered":  # wrapper defining PAGE_HTML + the AI's code (not stored)
                try:
                    run_code, _info = rendered.build_run_code(code, html)
                except ValueError as e:
                    build_error = f"rendered mode: {e}"

            if retarget_error or build_error:  # can't run it safely/at all
                ok, verdict, reason, items = False, "fail", retarget_error or build_error, []
                retarget_error = None
            else:
                res = sandbox_client.run(run_code, timeout=RUN_TIMEOUT_S,
                                         network=(mode == "html"))
                attempt.update(stdout=res.get("stdout", ""), stderr=res.get("stderr", ""),
                               exit_code=res.get("exit_code"), timed_out=res.get("timed_out"),
                               duration_ms=res.get("duration_ms"),
                               runtime_job_id=res.get("job_id"),
                               sandbox=sandbox_client.sandbox_info(res, RUN_TIMEOUT_S,
                                                                   network=(mode == "html")))
                attempt["reason"] = "checking output"
                ok, verdict, reason, items = _check_attempt(job, res, html)
            if ok:  # intelligence: a reused scraper whose output drifted from its baseline is repaired
                drift_reason = intel_hook.drift_check(job, url, items, source)
                if drift_reason:
                    ok, verdict, reason = False, "fail", drift_reason
            if ok and source == "saved":
                reason = "saved scraper, still works; " + reason
            if mode == "rendered" and not reason.startswith("rendered mode"):
                reason = RENDERED_PREFIX + reason
            attempt.update(verdict=verdict, reason=reason)

            if ok:
                scrapers.save(url, code, mode)
                job.update(results=items, final_code=code)
                intel_hook.after_success(job, job_id, url, html, items, code, source, verdict)
                job.update(status="done", finished_at=_now())
                return
            if mode == "html" and reason == EMPTY_REASON and not job.get("js_checked"):
                job["js_checked"] = True
                why = _js_rendered(url, html)
                if why and n < config.MAX_ATTEMPTS:
                    # A fetching scraper can't see these products: write a new one that
                    # parses the browser-rendered page instead (fresh, not a repair).
                    attempt["reason"] = (f"This site loads its products with JavaScript ({why}); "
                                         "switching to rendered mode.")
                    mode = job["scrape_mode"] = "rendered"
                    prev, code = None, None
                    continue
                if why:  # no attempts left to switch
                    attempt["reason"] = f"{JS_PAGE_MESSAGE} ({why})"
                    job.update(status="failed", error=JS_PAGE_MESSAGE, finished_at=_now())
                    return
            prev = {"code": code, "reason": reason,
                    "stderr": attempt["stderr"], "stdout": attempt["stdout"]}
            code = None

        job["status"] = "failed"
        job["error"] = f"no working scraper after {config.MAX_ATTEMPTS} attempts"
        job["finished_at"] = _now()
    except Exception as e:  # keep the error visible in the job, never crash the server
        traceback.print_exc()
        job["status"] = "failed"
        job["error"] = f"{type(e).__name__}: {e}"
        job["finished_at"] = _now()


def _now() -> str:
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())


def _check_url(url: str) -> None:
    if not url.startswith(("http://", "https://")):
        raise HTTPException(400, "url must start with http:// or https://")


def _start_job(url: str, saved: dict | None = None, parent: str | None = None,
               kind: str = "new") -> str:
    """kind: "new" (POST /api/jobs) or "rerun". Both start from `saved` when given."""
    job_id = uuid.uuid4().hex[:12]
    with _lock:
        JOBS[job_id] = {
            "status": "running", "url": url, "mode": kind,
            "scrape_mode": saved["mode"] if saved else "html",
            "parent": parent, "attempts": [], "results": [], "screenshot_base64": None,
            "error": None, "final_code": None, "code_model_calls": 0, "vision_calls": 0,
            "js_checked": False, "title": None,
            "models": {"code": config.CODE_MODEL, "vision": None}, "security": {"events": [], "benchmark": None},
            "created_at": _now(), "finished_at": None,
        }
    threading.Thread(target=_run_job, args=(job_id, url, saved), daemon=True).start()
    return job_id


def _registry_saved(url: str) -> dict | None:
    """Intelligence registry fallback (survives restarts, unlike scrapers.py).
    Registry versions have no scrape mode; they are treated as html scrapers."""
    v = intel_hook.saved_scraper(url)
    return {"code": v["code"], "mode": v.get("mode") or "html"} if v and v.get("code") else None


@app.post("/api/jobs")
def create_job(body: JobIn):
    """New job. If a scraper is saved for this site (same key as rerun), try it first
    and repair it if it fails; only write one from scratch when none is saved."""
    _check_url(body.url)
    return {"id": _start_job(body.url, saved=scrapers.get(body.url) or _registry_saved(body.url))}


@app.post("/api/jobs/{job_id}/rerun")
def rerun_job(job_id: str, body: JobIn):
    """Re-scrape with the saved scraper for this site; repair only if it breaks.
    Returns a NEW job id to poll."""
    _check_url(body.url)
    parent = JOBS.get(job_id)
    if parent is None:
        raise HTTPException(404, "job not found")
    saved = scrapers.get(body.url) or _registry_saved(body.url)
    if not saved and parent.get("final_code"):
        saved = {"code": parent["final_code"], "mode": parent.get("scrape_mode", "html")}
    if not saved:
        raise HTTPException(409, "no saved scraper for this site yet; run a normal job first")
    return {"id": _start_job(body.url, saved=saved, parent=job_id, kind="rerun")}


@app.post("/api/scrapers/reset")
def reset_scrapers():
    """Forget all saved scrapers (start the demo clean)."""
    return {"cleared": scrapers.reset(), "retired_versions": intel_hook.on_reset()}


@app.get("/api/scrapers")
def list_scrapers():
    return {"sites": scrapers.all_keys(), "modes": scrapers.all_modes()}


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
