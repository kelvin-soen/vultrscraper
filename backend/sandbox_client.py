"""Client for the sandbox runner. Same functions in real and mock mode.

    run(code, timeout=30) -> {"stdout", "stderr", "exit_code", "timed_out", "duration_ms"}
    screenshot(url)       -> {"image_base64", "html", "status"}

Set MOCK_SANDBOX=1 to use the mock (it never executes code).
Mock behaviour (layout chosen by the URL inside the code; "v=2" = changed layout):
- v1 (/shop): code that already passed once keeps passing. New code alternates
  fail (Python traceback) -> success per URL, so a fresh job sees attempt 1 fail
  and attempt 2 succeed.
- v2 (/shop?v=2): code passes only if it targets the new markup (`sku-tile`);
  otherwise it finds no products and prints [] (like a real layout change).
"""
import base64
import datetime
import hashlib
import json
import re
import threading
import time
from pathlib import Path

import httpx

import config
import verify

# ---------- mock ----------
MOCK_PRODUCTS = [
    {"name": "Kaffe Mellanrost 500g", "price_sek": 79},
    {"name": "Mjölk 1,5 l", "price_sek": 18},
    {"name": "Surdegsbröd", "price_sek": 45},
    {"name": "Smör 500g", "price_sek": 62},
    {"name": "Ägg 12-pack", "price_sek": 49},
    {"name": "Lagrad ost 1 kg", "price_sek": 129},
    {"name": "Havregryn 1,5 kg", "price_sek": 32},
    {"name": "Lingonsylt 400g", "price_sek": 38},
]

# v2 = "sale week": new markup and some new prices.
MOCK_PRODUCTS_V2 = [
    {"name": "Kaffe Mellanrost 500g", "price_sek": 69},
    {"name": "Mjölk 1,5 l", "price_sek": 18},
    {"name": "Surdegsbröd", "price_sek": 39},
    {"name": "Smör 500g", "price_sek": 62},
    {"name": "Ägg 12-pack", "price_sek": 44},
    {"name": "Lagrad ost 1 kg", "price_sek": 119},
    {"name": "Havregryn 1,5 kg", "price_sek": 32},
    {"name": "Lingonsylt 400g", "price_sek": 35},
]

_ASSETS = Path(__file__).resolve().parent / "mock_assets"
_MOCK_PNG_PATH = _ASSETS / "shop.png"
_MOCK_PNG_V2_PATH = _ASSETS / "shop_v2.png"

_MOCK_HTML = (
    "<!doctype html><html lang=\"sv\"><head><title>Demo Shop</title></head><body>\n"
    "<header class=\"top\"><h1>Demo Shop</h1><a class=\"cart\">Varukorg (0)</a></header>\n"
    "<main><h2>Veckans erbjudanden</h2>\n<div class=\"grid\">\n"
    + "".join(
        f"  <div class=\"card\"><img src=\"/img/{i}.jpg\" alt=\"\">"
        f"<h3 class=\"card-title\">{p['name']}</h3>"
        f"<div class=\"card-price\"><span class=\"amount\">{p['price_sek']}</span> kr</div>"
        f"<button>Köp</button></div>\n"
        for i, p in enumerate(MOCK_PRODUCTS)
    )
    + "</div></main></body></html>"
)

_MOCK_TRACEBACK = """Traceback (most recent call last):
  File "/sandbox/scraper.py", line 41, in <module>
    main()
  File "/sandbox/scraper.py", line 29, in main
    name = li.select_one(".name").get_text(strip=True)
           ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^
AttributeError: 'NoneType' object has no attribute 'get_text'
"""

_MOCK_HTML_V2 = (
    "<!doctype html><html lang=\"sv\"><head><title>Demo Shop</title></head><body>\n"
    "<nav class=\"nav\"><span class=\"logo\">Demo Shop</span></nav>\n"
    "<section class=\"catalog\"><h2>Kampanjvecka</h2>\n<ol class=\"sku-list\">\n"
    + "".join(
        f"  <li class=\"sku-tile\" data-sku=\"{1000 + i}\">"
        f"<p class=\"sku-tile__label\">{p['name']}</p>"
        f"<p class=\"sku-tile__cost\"><b>{p['price_sek']}:-</b></p>"
        f"<a class=\"btn\">Lägg i korgen</a></li>\n"
        for i, p in enumerate(MOCK_PRODUCTS_V2)
    )
    + "</ol></section></body></html>"
)

_mock_counts: dict[str, int] = {}
_mock_passed: set[str] = set()  # sha256 of code that already passed on v1
_mock_lock = threading.Lock()


def _target_url(code: str) -> str:
    m = re.search(r"^URL\s*=\s*[\"'](.+?)[\"']", code, re.MULTILINE) \
        or re.search(r"https?://[^\s\"']+", code)
    return m.group(1) if m and m.groups() else (m.group(0) if m else "")


def _ok(products: list[dict]) -> dict:
    return {"stdout": json.dumps(products, ensure_ascii=False) + "\n", "stderr": "",
            "exit_code": 0, "timed_out": False, "duration_ms": 538}


def _mock_run(code: str, timeout: int = 30) -> dict:
    url = _target_url(code)
    if "v=2" in url:
        if "sku-tile" in code:
            return _ok(MOCK_PRODUCTS_V2)
        # old selectors match nothing on the new layout
        return {"stdout": "[]\n", "stderr": "", "exit_code": 0,
                "timed_out": False, "duration_ms": 497}
    h = hashlib.sha256(code.encode()).hexdigest()
    with _mock_lock:
        if h in _mock_passed:
            return _ok(MOCK_PRODUCTS)
        _mock_counts[url] = _mock_counts.get(url, 0) + 1
        fail = _mock_counts[url] % 2 == 1
        if not fail:
            _mock_passed.add(h)
    if fail:
        return {"stdout": "", "stderr": _MOCK_TRACEBACK, "exit_code": 1,
                "timed_out": False, "duration_ms": 412}
    return _ok(MOCK_PRODUCTS)


def _mock_screenshot(url: str) -> dict:
    v2 = "v=2" in url
    path = _MOCK_PNG_V2_PATH if v2 else _MOCK_PNG_PATH
    img = base64.b64encode(path.read_bytes()).decode()
    blocked = []
    if "v=evil" in url:  # hostile page: its exfiltration attempts get blocked by the proxy
        blocked = [
            {"url": "http://169.254.169.254/latest/meta-data/iam/", "reason": "blocked-metadata"},
            {"url": "http://10.0.0.5:6379/?leak=ignore-previous-instructions", "reason": "blocked-private"},
        ]
    return {"image_base64": img, "html": _MOCK_HTML_V2 if v2 else _MOCK_HTML, "status": 200,
            "blocked_requests": blocked}


# ---------- real ----------
class SandboxError(RuntimeError):
    """Runtime call failed in a way the job should report (message is safe to show)."""


RETRY_DELAYS_429 = [2, 4, 8, 16]  # seconds; runtime budget is 6 active jobs per key


def _headers() -> dict:
    return {"Authorization": f"Bearer {config.sandbox_key()}"}


def _post(path: str, payload: dict, timeout: float) -> dict:
    """POST to the runtime with auth. 401 -> clear error; 429 -> back off and retry."""
    for i, delay in enumerate([0] + RETRY_DELAYS_429):
        if delay:
            time.sleep(delay)
        try:
            r = httpx.post(f"{config.SANDBOX_URL}{path}", json=payload,
                           headers=_headers(), timeout=timeout)
        except httpx.HTTPError as e:
            raise SandboxError(f"runtime unreachable at {config.SANDBOX_URL}{path}: "
                               f"{type(e).__name__}") from None
        if r.status_code == 401:
            raise SandboxError("runtime rejected the API key (401): check SANDBOX_API_KEY "
                               "or /etc/vultr-runtime/backend.key")
        if r.status_code == 429:
            last_429 = _detail(r)
            continue
        if r.status_code >= 400:
            raise SandboxError(f"runtime {path} returned {r.status_code}: {_detail(r)}")
        return r.json()
    raise SandboxError(f"runtime busy (429 {last_429}) after {len(RETRY_DELAYS_429)} retries")


def _detail(r: httpx.Response) -> str:
    try:
        body = r.json()
        return str(body.get("error") or body.get("detail") or body)[:300]
    except ValueError:
        return r.text[:300]


def _real_run(code: str, timeout: int = 30) -> dict:
    return _post("/run", {"code": code, "timeout": timeout, "network": True}, timeout + 60)


def _real_screenshot(url: str) -> dict:
    return _post("/screenshot", {"url": url}, 150)


def run(code: str, timeout: int = 30) -> dict:
    return _mock_run(code, timeout) if config.MOCK_SANDBOX else _real_run(code, timeout)


def screenshot(url: str) -> dict:
    return _mock_screenshot(url) if config.MOCK_SANDBOX else _real_screenshot(url)


def job_telemetry(job_id: str | None) -> dict | None:
    """Runtime telemetry for a finished job (GET /v1/jobs/{id} -> telemetry), or None."""
    if config.MOCK_SANDBOX:
        return {"oci_runtime": "mock", "cleanup": {"container_removed": None}}
    if not job_id:
        return None
    try:
        r = httpx.get(f"{config.SANDBOX_URL}/v1/jobs/{job_id}", headers=_headers(), timeout=10)
        if r.status_code != 200:
            return None
        return r.json().get("telemetry") or None
    except (httpx.HTTPError, ValueError):
        return None


_RUNTIME_NAMES = {"runsc": "gVisor (runsc)", "mock": "mock (no sandbox)"}


def sandbox_info(run_result: dict, timeout: int, network: bool = True) -> dict:
    """attempt.sandbox for the frontend (HANDOFF section 7.1). Never raises."""
    tel = job_telemetry(run_result.get("job_id")) or {}
    oci = tel.get("oci_runtime")
    return {
        "runtime": _RUNTIME_NAMES.get(oci, oci),
        "network": "egress allow-list" if network else "none",
        "timeout_s": timeout,
        "container_removed": (tel.get("cleanup") or {}).get("container_removed"),
    }


# ---------- runtime security benchmark (GET /v1/security/benchmark) ----------
_BENCH_TTL_S = 300
_bench_cache: dict = {"at": 0.0, "value": None}


def security_benchmark() -> dict | None:
    """Compact summary of the runtime's latest published benchmark, cached 5 min.
    None in mock mode or if the runtime has none. Runtime-wide, NOT per job."""
    if config.MOCK_SANDBOX:
        return None
    now = time.time()
    if now - _bench_cache["at"] < _BENCH_TTL_S:
        return _bench_cache["value"]
    value = None
    try:
        r = httpx.get(f"{config.SANDBOX_URL}/v1/security/benchmark", headers=_headers(), timeout=10)
        if r.status_code == 200:
            b = r.json()
            tests = [{"id": t.get("id"), "name": t.get("name"), "core": bool(t.get("core")),
                      "passed": t.get("passed") is True} for t in b.get("tests") or []]
            fin = b.get("finished_at")
            value = {
                "source": "runtime security benchmark (runtime-wide, not this job)",
                "finished_at": (datetime.datetime.fromtimestamp(fin, datetime.timezone.utc)
                                .strftime("%Y-%m-%dT%H:%M:%SZ") if isinstance(fin, (int, float)) else None),
                "oci_runtime": b.get("oci_runtime"),
                "all_passed": b.get("all_passed") is True,
                "core_passed": b.get("core_passed") is True,
                "passed": sum(t["passed"] for t in tests),
                "total": len(tests),
                "tests": tests,
            }
    except (httpx.HTTPError, ValueError, RuntimeError):
        value = None
    _bench_cache.update(at=now, value=value)
    return value


# ---------- raw-HTML probe (is the page rendered by JavaScript?) ----------
_PROBE_CODE = """
import json, re, requests
from bs4 import BeautifulSoup
URL = {url}
r = requests.get(URL, timeout=20)
soup = BeautifulSoup(r.text, "html.parser")
for t in soup(["script", "style", "noscript", "template", "head", "svg"]):
    t.decompose()
n = len(re.findall({rx}, soup.get_text(" "), re.I))
print(json.dumps({{"status": r.status_code, "chars": len(r.text), "prices": n}}))
"""


def probe_raw_prices(url: str) -> dict | None:
    """Fetch `url` with plain requests inside the sandbox (exactly what a scraper sees)
    and count prices. Returns {"status", "chars", "prices"} or None if the probe failed."""
    if config.MOCK_SANDBOX:
        return None
    code = _PROBE_CODE.format(url=json.dumps(url), rx=repr(verify.PRICE_RX.pattern))
    try:
        res = run(code, timeout=30)
        return json.loads((res.get("stdout") or "").strip().splitlines()[-1])
    except (SandboxError, ValueError, IndexError):
        return None
