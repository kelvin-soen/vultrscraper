#!/usr/bin/env python3
"""Functional tests for the Vultr Agent Runtime, run against the deployed service.

    sudo /opt/vultr-runtime/venv/bin/python runtime/tests/functional_test.py [--demo-url http://70.34.217.56:8080/shop]
"""
import argparse
import base64
import json
import os
import sys
import time
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, "..", "client"))
from runtime_client import RuntimeClient  # noqa: E402

BASE = os.environ.get("RUNTIME_URL", "http://127.0.0.1:8001")
KEY = os.environ.get("RUNTIME_API_KEY") or open("/etc/vultr-runtime/backend.key").read().strip()
rt = RuntimeClient(BASE, api_key=KEY, timeout=120)
results = []


def case(name):
    def deco(fn):
        def run():
            t0 = time.time()
            try:
                detail = fn()
                ok = True
            except AssertionError as e:
                ok, detail = False, f"assertion: {e}"
            except Exception as e:  # noqa: BLE001
                ok, detail = False, f"{e.__class__.__name__}: {e}"
            results.append({"case": name, "passed": ok, "seconds": round(time.time() - t0, 1), "detail": detail})
            print(f"{'PASS' if ok else 'FAIL'}  {name}  ({results[-1]['seconds']}s)  {str(detail)[:160]}", flush=True)
        CASES.append(run)
        return fn
    return deco


CASES = []


@case("python: structured output + passing validation tests")
def _():
    r = rt.run_python(
        "from vrt_sandbox import write_result, read_inputs\nx = read_inputs()['n']\nwrite_result({'square': x * x})\nprint('ok')",
        inputs={"n": 7},
        test_code="import json\ndef test_square():\n    assert json.load(open('/work/output/result.json'))['square'] == 49\n")
    assert r["status"] == "succeeded", r
    assert r["output"] == {"square": 49}, r["output"]
    assert r["tests"]["passed"] is True, r["tests"]
    return {"output": r["output"], "tests": r["tests"]["output"].strip().splitlines()[-1]}


@case("python: failing validation tests mark the job failed")
def _():
    r = rt.run_python("print('hi')", test_code="def test_fail():\n    assert 1 == 2\n")
    assert r["status"] == "failed" and r["tests"]["passed"] is False, r
    return r["error"]


@case("python: no network in the python profile")
def _():
    r = rt.run_python("import socket\ntry:\n    socket.create_connection(('1.1.1.1', 80), timeout=3); print('CONNECTED')\nexcept Exception as e:\n    print('blocked', type(e).__name__)")
    assert r["status"] == "succeeded" and "CONNECTED" not in r["stdout"], r["stdout"]
    return r["stdout"].strip()


@case("python-net: scrape a public page through the egress proxy")
def _():
    code = ("import requests\nfrom bs4 import BeautifulSoup\nfrom vrt_sandbox import write_result\n"
            "h = requests.get('https://example.com', timeout=15).text\n"
            "write_result({'title': BeautifulSoup(h, 'html.parser').title.text})")
    r = rt.run_python(code, network=True, allowed_domains=["example.com"])
    assert r["status"] == "succeeded", (r["status"], r["stderr"][-400:])
    assert r["output"]["title"] == "Example Domain", r["output"]
    assert r["telemetry"]["egress"]["allowed"] >= 1
    return {"output": r["output"], "egress": r["telemetry"]["egress"]}


@case("python-net: hosts outside the allowlist are blocked")
def _():
    r = rt.run_python("import requests\nr = requests.get('http://neverssl.com', timeout=10)\nprint(r.status_code, r.headers.get('X-VRT-Blocked'))",
                      network=True, allowed_domains=["example.com"])
    assert "403 domain-not-in-allowlist" in r["stdout"], r["stdout"]
    return r["stdout"].strip()


@case("browser: declarative actions, extraction, screenshot and HTML")
def _():
    r = rt.browse("https://example.com", allowed_domains=["example.com"], actions=[
        {"type": "wait_for_selector", "selector": "p"},
        {"type": "extract_text", "selector": "p", "name": "first_paragraph"},
        {"type": "extract_attribute", "selector": "a", "attr": "href", "all": True, "name": "links"},
        {"type": "screenshot", "name": "viewport", "full_page": False}])
    b = r["browser"]
    assert r["status"] == "succeeded", (r["status"], r["error"], b)
    assert b["status"] == 200 and b["title"] == "Example Domain" and "domain" in b["extracted"]["first_paragraph"].lower(), b
    names = {a["name"] for a in r["artifacts"]}
    assert {"screenshot.png", "page.html", "viewport.png"} <= names, names
    png = rt.artifact(r["job_id"], "screenshot.png")
    assert png[:8] == b"\x89PNG\r\n\x1a\n"
    return {"extracted": b["extracted"], "artifacts": sorted(names), "png_bytes": len(png)}


@case("browser: generated Playwright code via vrt_sandbox.launch_chromium")
def _():
    code = ("from playwright.sync_api import sync_playwright\nfrom vrt_sandbox import launch_chromium, write_result\n"
            "with sync_playwright() as p:\n    b = launch_chromium(p)\n    pg = b.new_page()\n"
            "    pg.goto('https://example.com')\n    pg.screenshot(path='/work/output/code.png')\n"
            "    write_result({'title': pg.title()})\n    b.close()\n")
    r = rt.run({"profile": "browser", "code": code, "network": {"allowed_domains": ["example.com"]}}, timeout=240)
    assert r["status"] == "succeeded", (r["status"], r["stderr"][-600:])
    assert r["output"] == {"title": "Example Domain"}, r["output"]
    return {"output": r["output"], "artifacts": [a["name"] for a in r["artifacts"]]}


@case("artifacts are served as untrusted attachments")
def _():
    r = rt.run_python("open('/work/output/x.html','w').write('<script>alert(1)</script>')")
    req = urllib.request.Request(f"{BASE}/v1/jobs/{r['job_id']}/artifacts/x.html", headers={"Authorization": f"Bearer {KEY}"})
    with urllib.request.urlopen(req) as resp:
        h = dict(resp.headers)
    assert h.get("x-content-type-options") == "nosniff" and "attachment" in h.get("content-disposition", ""), h
    assert "sandbox" in h.get("content-security-policy", ""), h
    return {k: h.get(k) for k in ("content-disposition", "x-content-type-options", "content-security-policy")}


@case("compat POST /run (backend contract)")
def _():
    body = json.dumps({"code": "import json\nprint(json.dumps([{'name': 'x', 'price_sek': 1}]))", "timeout": 30, "network": True}).encode()
    req = urllib.request.Request(f"{BASE}/run", data=body, method="POST",
                                 headers={"Authorization": f"Bearer {KEY}", "Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=120) as resp:
        r = json.loads(resp.read())
    assert {"stdout", "stderr", "exit_code", "timed_out", "duration_ms"} <= set(r), r
    assert r["exit_code"] == 0 and json.loads(r["stdout"]) == [{"name": "x", "price_sek": 1}], r
    return {k: r[k] for k in ("exit_code", "timed_out", "duration_ms", "status")}


@case("compat POST /screenshot (backend contract)")
def _():
    body = json.dumps({"url": "https://example.com"}).encode()
    req = urllib.request.Request(f"{BASE}/screenshot", data=body, method="POST",
                                 headers={"Authorization": f"Bearer {KEY}", "Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=180) as resp:
        r = json.loads(resp.read())
    assert r["status"] == 200 and r["image_base64"] and "Example Domain" in r["html"], {k: r.get(k) for k in ("status", "error")}
    assert base64.b64decode(r["image_base64"])[:4] == b"\x89PNG"
    return {"status": r["status"], "png_b64_len": len(r["image_base64"]), "html_len": len(r["html"])}


def demo_cases(demo_url):
    @case(f"trusted target: scrape demo shop {demo_url} via /run")
    def _():
        body = json.dumps({"code": f"import requests\nr = requests.get({demo_url!r}, timeout=15)\nprint(r.status_code, len(r.text))",
                           "timeout": 30, "network": True}).encode()
        req = urllib.request.Request(f"{BASE}/run", data=body, method="POST",
                                     headers={"Authorization": f"Bearer {KEY}", "Content-Type": "application/json"})
        with urllib.request.urlopen(req, timeout=120) as resp:
            r = json.loads(resp.read())
        assert r["exit_code"] == 0 and r["stdout"].startswith("200"), r
        return r["stdout"].strip()

    @case(f"trusted target: screenshot demo shop {demo_url}")
    def _():
        body = json.dumps({"url": demo_url}).encode()
        req = urllib.request.Request(f"{BASE}/screenshot", data=body, method="POST",
                                     headers={"Authorization": f"Bearer {KEY}", "Content-Type": "application/json"})
        with urllib.request.urlopen(req, timeout=180) as resp:
            r = json.loads(resp.read())
        assert r["status"] == 200 and r["image_base64"], {k: r.get(k) for k in ("status", "error", "blocked_requests")}
        return {"status": r["status"], "html_len": len(r["html"] or "")}


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--demo-url")
    ap.add_argument("--json-out")
    a = ap.parse_args()
    if a.demo_url:
        demo_cases(a.demo_url)
    for c in CASES:
        c()
    passed = sum(r["passed"] for r in results)
    print(json.dumps({"total": len(results), "passed": passed, "failed": len(results) - passed}))
    if a.json_out:
        with open(a.json_out, "w") as f:
            json.dump({"finished_at": time.time(), "results": results}, f, indent=2, default=str)
    sys.exit(0 if passed == len(results) else 1)
