#!/usr/bin/env python3
"""Trusted in-sandbox runner for the Vultr Agent Runtime.

Reads the job spec from chunked environment variables, runs the workload
(declarative browser actions, generated Python code, validation tests) and
prints one framed, base64-encoded JSON result on stdout.

Everything this runner returns is treated as untrusted by the controller:
generated code runs as the same unprivileged user and could tamper with it.
Security decisions are made outside the sandbox.
"""
import base64
import json
import os
import re
import resource
import signal
import subprocess
import sys
import time
import traceback

RUNNER_VERSION = "1.0.0"
MARK_BEGIN = "@@VRT_RESULT_BEGIN@@"
MARK_END = "@@VRT_RESULT_END@@"
WORK = "/work"
OUT = "/work/output"
HOME = "/work/home"
INTERNAL = "/tmp/.vrt"
MAX_ARTIFACT_FILES = 20
MAX_ARTIFACT_TOTAL = 12 * 1024 * 1024
MAX_ARTIFACT_SINGLE = 8 * 1024 * 1024
MAX_STRUCTURED_OUTPUT = 2 * 1024 * 1024
MAX_FILE_WRITE = 64 * 1024 * 1024  # RLIMIT_FSIZE for generated code

SAFE_NAME = re.compile(r"[^A-Za-z0-9._-]+")


# ---------------------------------------------------------------- utilities
def load_spec():
    n = int(os.environ.pop("VRT_SPEC_CHUNKS", "0"))
    data = "".join(os.environ.pop(f"VRT_SPEC_{i}") for i in range(n))
    return json.loads(base64.b64decode(data))


def emit(result):
    payload = base64.b64encode(json.dumps(result, default=str).encode()).decode()
    out = sys.__stdout__
    out.write("\n" + MARK_BEGIN + "\n")
    for i in range(0, len(payload), 8000):
        out.write(payload[i:i + 8000] + "\n")
    out.write(MARK_END + "\n")
    out.flush()


def read_capped(path, cap):
    try:
        size = os.path.getsize(path)
    except OSError:
        return "", 0, False
    with open(path, "rb") as f:
        data = f.read(cap)
    return data.decode("utf-8", "replace"), size, size > cap


def child_env(spec):
    env = {
        "PATH": "/usr/local/bin:/usr/bin:/bin",
        "HOME": HOME,
        "LANG": "C.UTF-8",
        "PYTHONUNBUFFERED": "1",
        "PYTHONDONTWRITEBYTECODE": "1",
        "PLAYWRIGHT_BROWSERS_PATH": "/opt/ms-playwright",
        "TMPDIR": "/tmp",
    }
    for k in ("HTTP_PROXY", "HTTPS_PROXY", "http_proxy", "https_proxy", "NO_PROXY", "no_proxy",
              "VRT_PROXY_SERVER", "VRT_PROXY_USER", "VRT_PROXY_PASS"):
        if k in os.environ:
            env[k] = os.environ[k]
    return env


def run_child(argv, timeout, mem_bytes, nproc, env, label):
    stdout_path = os.path.join(INTERNAL, f"{label}.stdout")
    stderr_path = os.path.join(INTERNAL, f"{label}.stderr")

    def preexec():
        os.setsid()
        # Ignored SIGXFSZ survives exec: oversized writes fail with EFBIG
        # instead of killing the process, so output exhaustion stays bounded.
        signal.signal(signal.SIGXFSZ, signal.SIG_IGN)
        resource.setrlimit(resource.RLIMIT_CORE, (0, 0))
        resource.setrlimit(resource.RLIMIT_FSIZE, (MAX_FILE_WRITE, MAX_FILE_WRITE))
        if mem_bytes:
            resource.setrlimit(resource.RLIMIT_AS, (mem_bytes, mem_bytes))
        if nproc:
            resource.setrlimit(resource.RLIMIT_NPROC, (nproc, nproc))

    start = time.monotonic()
    timed_out = False
    with open(stdout_path, "wb") as so, open(stderr_path, "wb") as se:
        p = subprocess.Popen(argv, stdout=so, stderr=se, stdin=subprocess.DEVNULL, cwd=WORK,
                             env=env, preexec_fn=preexec, close_fds=True)
        try:
            rc = p.wait(timeout=max(timeout, 0.1))
        except subprocess.TimeoutExpired:
            timed_out = True
            try:
                os.killpg(p.pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
            rc = p.wait()
    return {
        "exit_code": rc,
        "timed_out": timed_out,
        "duration_ms": int((time.monotonic() - start) * 1000),
        "stdout_path": stdout_path,
        "stderr_path": stderr_path,
    }


def collect_artifacts():
    artifacts, total = [], 0
    if not os.path.isdir(OUT):
        return artifacts, []
    skipped = []
    for root, dirs, files in os.walk(OUT, followlinks=False):
        for fn in sorted(files):
            path = os.path.join(root, fn)
            rel = os.path.relpath(path, OUT)
            try:
                st = os.lstat(path)
            except OSError:
                continue
            if not os.path.isfile(path) or os.path.islink(path):
                skipped.append({"name": rel, "reason": "not a regular file"})
                continue
            if rel == "result.json":
                continue
            if len(artifacts) >= MAX_ARTIFACT_FILES:
                skipped.append({"name": rel, "reason": "too many artifacts"})
                continue
            if st.st_size > MAX_ARTIFACT_SINGLE or total + st.st_size > MAX_ARTIFACT_TOTAL:
                skipped.append({"name": rel, "reason": "artifact size limit", "size": st.st_size})
                continue
            with open(path, "rb") as f:
                data = f.read(MAX_ARTIFACT_SINGLE + 1)
            total += len(data)
            name = SAFE_NAME.sub("_", rel.replace(os.sep, "__"))[:120] or "artifact"
            artifacts.append({"name": name, "size": len(data), "data_b64": base64.b64encode(data).decode()})
    return artifacts, skipped


def structured_output():
    path = os.path.join(OUT, "result.json")
    if not os.path.isfile(path) or os.path.islink(path):
        return None, None
    if os.path.getsize(path) > MAX_STRUCTURED_OUTPUT:
        return None, "result.json exceeds 2 MB limit"
    try:
        with open(path, encoding="utf-8") as f:
            return json.load(f), None
    except Exception as e:  # noqa: BLE001 - untrusted content
        return None, f"result.json is not valid JSON: {e.__class__.__name__}"


# ------------------------------------------------------------------ browser
def proxy_settings():
    server = os.environ.get("VRT_PROXY_SERVER")
    if not server:
        return None
    return {"server": server, "username": os.environ.get("VRT_PROXY_USER", ""),
            "password": os.environ.get("VRT_PROXY_PASS", ""), "bypass": "<-loopback>"}


CHROMIUM_ARGS = [
    "--disable-gpu", "--disable-extensions", "--disable-background-networking",
    "--disable-component-update", "--disable-sync", "--no-first-run",
    "--proxy-bypass-list=<-loopback>",
    "--force-webrtc-ip-handling-policy=disable_non_proxied_udp",
]


def run_browser(b, deadline):
    from playwright.sync_api import sync_playwright

    res = {"status": None, "final_url": None, "title": None, "actions": [], "extracted": {},
           "blocked_requests": [], "failed_requests": [], "console": [], "error": None}
    os.makedirs(OUT, exist_ok=True)

    def remaining_ms(cap):
        return int(max(500, min(cap, (deadline - time.monotonic()) * 1000)))

    nav_cap = b.get("nav_timeout_ms", 30000)
    with sync_playwright() as p:
        browser = p.chromium.launch(proxy=proxy_settings(), args=CHROMIUM_ARGS, chromium_sandbox=False,
                                    handle_sigint=False, handle_sigterm=False, handle_sighup=False)
        ctx = browser.new_context(
            viewport={"width": b.get("viewport_width", 1366), "height": b.get("viewport_height", 900)},
            accept_downloads=False, service_workers="block", java_script_enabled=True)
        page = ctx.new_page()

        def on_failed(r):
            if len(res["failed_requests"]) < 200:
                res["failed_requests"].append({"url": r.url[:500], "error": (r.failure or "")[:200]})

        def on_response(r):
            try:
                reason = r.headers.get("x-vrt-blocked")
            except Exception:  # noqa: BLE001
                reason = None
            if reason and len(res["blocked_requests"]) < 200:
                res["blocked_requests"].append({"url": r.url[:500], "reason": reason[:200]})

        def on_console(m):
            if len(res["console"]) < 50:
                res["console"].append({"type": m.type, "text": m.text[:300]})

        def on_download(d):
            res["actions"].append({"type": "download", "ok": False, "error": "downloads are disabled"})
            try:
                d.cancel()
            except Exception:  # noqa: BLE001
                pass

        page.on("requestfailed", on_failed)
        page.on("response", on_response)
        page.on("console", on_console)
        page.on("download", on_download)
        wait_until = b.get("wait_until", "load")

        try:
            if b.get("html_content") is not None:
                page.set_content(b["html_content"], wait_until=wait_until, timeout=remaining_ms(nav_cap))
            elif b.get("url"):
                resp = page.goto(b["url"], wait_until=wait_until, timeout=remaining_ms(nav_cap))
                res["status"] = resp.status if resp else None
        except Exception as e:  # noqa: BLE001
            res["error"] = f"{e.__class__.__name__}: {str(e).splitlines()[0][:300]}"

        for i, a in enumerate(b.get("actions", [])):
            entry = {"index": i, "type": a["type"], "ok": True}
            try:
                t = a["type"]
                tmo = remaining_ms(a.get("timeout_ms", 10000))
                if t == "goto":
                    resp = page.goto(a["url"], wait_until=wait_until, timeout=remaining_ms(nav_cap))
                    entry["status"] = resp.status if resp else None
                    res["status"] = entry["status"]
                elif t == "click":
                    page.click(a["selector"], timeout=tmo)
                elif t == "fill":
                    page.fill(a["selector"], a.get("value", ""), timeout=tmo)
                elif t == "press":
                    page.press(a["selector"], a["key"], timeout=tmo)
                elif t == "wait_for_selector":
                    page.wait_for_selector(a["selector"], timeout=tmo)
                elif t == "wait":
                    page.wait_for_timeout(min(a.get("ms", 1000), remaining_ms(30000)))
                elif t == "scroll":
                    page.mouse.wheel(0, a.get("y", 1000))
                elif t in ("extract_text", "extract_attribute", "extract_html"):
                    name = a.get("name") or f"{t}_{i}"
                    loc = page.locator(a["selector"])
                    if t == "extract_text":
                        vals = loc.all_inner_texts() if a.get("all") else [loc.first.inner_text(timeout=tmo)]
                    elif t == "extract_html":
                        vals = [h for h in loc.evaluate_all("els => els.map(e => e.outerHTML)")] if a.get("all") \
                            else [loc.first.evaluate("e => e.outerHTML")]
                    else:
                        attr = a["attr"]
                        vals = [loc.nth(k).get_attribute(attr) for k in range(min(loc.count(), 500))] \
                            if a.get("all") else [loc.first.get_attribute(attr, timeout=tmo)]
                    vals = [(v or "")[:20000] for v in vals[:500]]
                    res["extracted"][name] = vals if a.get("all") else vals[0]
                elif t == "screenshot":
                    name = SAFE_NAME.sub("_", a.get("name") or f"screenshot_{i}")[:60]
                    page.screenshot(path=os.path.join(OUT, f"{name}.png"),
                                    full_page=a.get("full_page", True), timeout=tmo)
            except Exception as e:  # noqa: BLE001
                entry["ok"] = False
                entry["error"] = f"{e.__class__.__name__}: {str(e).splitlines()[0][:300]}"
            res["actions"].append(entry)

        try:
            res["final_url"] = page.url[:2000]
            res["title"] = (page.title() or "")[:500]
        except Exception:  # noqa: BLE001
            pass
        if b.get("capture_html", True):
            try:
                with open(os.path.join(OUT, "page.html"), "w", encoding="utf-8") as f:
                    f.write(page.content()[:5 * 1024 * 1024])
                res["html_artifact"] = "page.html"
            except Exception as e:  # noqa: BLE001
                res["html_error"] = str(e)[:200]
        if b.get("screenshot", True):
            try:
                page.screenshot(path=os.path.join(OUT, "screenshot.png"), full_page=b.get("full_page", True),
                                timeout=remaining_ms(15000))
                res["screenshot_artifact"] = "screenshot.png"
            except Exception as e:  # noqa: BLE001
                res["screenshot_error"] = str(e)[:200]
        ctx.close()
        browser.close()
    return res


# --------------------------------------------------------------------- main
def main():
    t0 = time.monotonic()
    result = {"runner_version": RUNNER_VERSION, "ok": False}
    try:
        spec = load_spec()
        for d in (OUT, HOME, INTERNAL):
            os.makedirs(d, exist_ok=True)
        timeout = float(spec["timeout_s"])
        deadline = t0 + timeout
        max_out = int(spec.get("max_output_bytes", 1024 * 1024))
        mem_bytes = int(spec.get("memory_mb", 0)) * 1024 * 1024 if spec.get("rlimit_as") else 0
        nproc = int(spec.get("nproc", 0))
        env = child_env(spec)
        result["profile"] = spec.get("profile")

        if spec.get("inputs") is not None:
            with open(os.path.join(WORK, "input.json"), "w", encoding="utf-8") as f:
                json.dump(spec["inputs"], f)

        if spec.get("browser"):
            result["browser"] = run_browser(spec["browser"], deadline)

        if spec.get("code"):
            with open(os.path.join(WORK, "main.py"), "w", encoding="utf-8") as f:
                f.write(spec["code"])
            r = run_child([sys.executable, "-I", "-B", "main.py"], deadline - time.monotonic(),
                          mem_bytes, nproc, env, "main")
            result["exit_code"] = r["exit_code"]
            result["timed_out"] = r["timed_out"]
            result["code_duration_ms"] = r["duration_ms"]
            result["stdout"], result["stdout_bytes"], result["stdout_truncated"] = read_capped(r["stdout_path"], max_out)
            result["stderr"], result["stderr_bytes"], result["stderr_truncated"] = read_capped(r["stderr_path"], max_out)

        if spec.get("test_code") and not result.get("timed_out"):
            with open(os.path.join(WORK, "test_job.py"), "w", encoding="utf-8") as f:
                f.write(spec["test_code"])
            r = run_child([sys.executable, "-I", "-B", "-m", "pytest", "-q", "-p", "no:cacheprovider",
                           "--no-header", "test_job.py"], deadline - time.monotonic(), mem_bytes, nproc, env, "tests")
            out, _, trunc = read_capped(r["stdout_path"], 64 * 1024)
            result["tests"] = {"ran": True, "passed": r["exit_code"] == 0 and not r["timed_out"],
                               "exit_code": r["exit_code"], "timed_out": r["timed_out"],
                               "output": out, "output_truncated": trunc}

        result["output"], result["output_error"] = structured_output()
        result["artifacts"], result["artifacts_skipped"] = collect_artifacts()
        result["ok"] = True
    except Exception:  # noqa: BLE001
        result["runner_error"] = traceback.format_exc()[-2000:]
    result["runner_duration_ms"] = int((time.monotonic() - t0) * 1000)
    emit(result)


if __name__ == "__main__":
    main()
