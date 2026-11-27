"""Client for the sandbox runner. Same functions in real and mock mode.

    run(code, timeout=30) -> {"stdout", "stderr", "exit_code", "timed_out", "duration_ms"}
    screenshot(url)       -> {"image_base64", "html", "status"}

Set MOCK_SANDBOX=1 to use the mock (it never executes code).
Mock behaviour: for each target URL found in the code, runs alternate
fail (Python traceback) -> success (valid JSON). So a fresh job sees
attempt 1 fail and attempt 2 succeed.
"""
import base64
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

_MOCK_PNG_PATH = Path(__file__).resolve().parent / "mock_assets" / "shop.png"

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

_mock_counts: dict[str, int] = {}
_mock_lock = threading.Lock()


def _mock_run(code: str, timeout: int = 30) -> dict:
    m = re.search(r"https?://[^\s\"']+", code)
    key = m.group(0) if m else ""
    with _mock_lock:
        _mock_counts[key] = _mock_counts.get(key, 0) + 1
        n = _mock_counts[key]
    if n % 2 == 1:
        return {"stdout": "", "stderr": _MOCK_TRACEBACK, "exit_code": 1,
                "timed_out": False, "duration_ms": 412}
    return {"stdout": json.dumps(MOCK_PRODUCTS, ensure_ascii=False) + "\n", "stderr": "",
            "exit_code": 0, "timed_out": False, "duration_ms": 538}


def _mock_screenshot(url: str) -> dict:
    img = base64.b64encode(_MOCK_PNG_PATH.read_bytes()).decode()
    return {"image_base64": img, "html": _MOCK_HTML, "status": 200}


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
