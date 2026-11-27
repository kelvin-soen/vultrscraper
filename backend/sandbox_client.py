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
import hashlib
import json
import re
import threading
from pathlib import Path

import httpx

import config

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
    return {"image_base64": img, "html": _MOCK_HTML_V2 if v2 else _MOCK_HTML, "status": 200}


# ---------- real ----------
def _real_run(code: str, timeout: int = 30) -> dict:
    r = httpx.post(
        f"{config.SANDBOX_URL}/run",
        json={"code": code, "timeout": timeout, "network": True},
        timeout=timeout + 30,
    )
    r.raise_for_status()
    return r.json()


def _real_screenshot(url: str) -> dict:
    r = httpx.post(f"{config.SANDBOX_URL}/screenshot", json={"url": url}, timeout=90)
    r.raise_for_status()
    return r.json()


def run(code: str, timeout: int = 30) -> dict:
    return _mock_run(code, timeout) if config.MOCK_SANDBOX else _real_run(code, timeout)


def screenshot(url: str) -> dict:
    return _mock_screenshot(url) if config.MOCK_SANDBOX else _real_screenshot(url)
