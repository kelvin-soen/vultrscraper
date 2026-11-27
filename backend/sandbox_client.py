"""Client for the sandbox runner. Same functions in real and mock mode.

    run(code, timeout=30) -> {"stdout", "stderr", "exit_code", "timed_out", "duration_ms"}
    screenshot(url)       -> {"image_base64", "html", "status"}

Set MOCK_SANDBOX=1 to use the mock (never executes code).
"""
import httpx

import config

# 1x1 transparent PNG
_MOCK_PNG = (
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII="
)

_MOCK_HTML = """<!doctype html><html><body><h1>Demo Shop</h1>
<ul class="products">
  <li class="product"><span class="name">Kaffe 500g</span><span class="price">79 kr</span></li>
  <li class="product"><span class="name">Mjolk 1l</span><span class="price">18 kr</span></li>
  <li class="product"><span class="name">Brod</span><span class="price">35 kr</span></li>
</ul></body></html>"""


# ---------- mock ----------
def _mock_run(code: str, timeout: int = 30) -> dict:
    return {
        "stdout": '[{"name": "Kaffe 500g", "price_sek": 79}, {"name": "Mjolk 1l", "price_sek": 18}, '
                  '{"name": "Brod", "price_sek": 35}]',
        "stderr": "",
        "exit_code": 0,
        "timed_out": False,
        "duration_ms": 5,
    }


def _mock_screenshot(url: str) -> dict:
    return {"image_base64": _MOCK_PNG, "html": _MOCK_HTML, "status": 200}


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
