"""Rendered mode: run an AI scraper against the browser-rendered HTML.

For pages that build their products with JavaScript, a plain HTTP fetch inside the
sandbox sees no products. Instead, the backend embeds the rendered HTML (from the
runtime's /screenshot) in the code it sends to /run: one wrapper line defines
PAGE_HTML, followed by the AI's scraper. The run needs no network at all.
"""
import base64
import re
import zlib

from bs4 import BeautifulSoup, Comment

import ai_client

RUN_CODE_LIMIT = 100_000  # runtime /run "code" max length
SAFETY_MARGIN = 1_000

_WRAPPER_HEAD = ("import base64 as _b64, zlib as _zlib; "  # added by siftform., not AI-generated
                 "PAGE_HTML = _zlib.decompress(_b64.b64decode(\"")
_WRAPPER_TAIL = "\")).decode(\"utf-8\")\n"


def clean_rendered_html(html: str) -> str:
    """Remove script/style/svg/noscript/template and comments; collapse whitespace."""
    soup = BeautifulSoup(html or "", "html.parser")
    for c in soup.find_all(string=lambda t: isinstance(t, Comment)):
        c.extract()
    for tag in soup(["script", "style", "svg", "noscript", "template"]):
        tag.decompose()
    return re.sub(r">\s+<", "><", re.sub(r"\s+", " ", str(soup))).strip()


def _pack(text: str) -> str:
    return base64.b64encode(zlib.compress(text.encode("utf-8"), 9)).decode("ascii")


def build_run_code(ai_code: str, html: str) -> tuple[str, dict]:
    """Wrapper line + AI code, kept under the /run limit. If the cleaned page does not
    fit, keep the window with the most prices (shrinking until it fits).
    Returns (run_code, info) where info describes what PAGE_HTML contains."""
    cleaned = clean_rendered_html(html)
    budget = RUN_CODE_LIMIT - SAFETY_MARGIN - len(ai_code) - len(_WRAPPER_HEAD) - len(_WRAPPER_TAIL)
    if budget <= 0:
        raise ValueError(f"scraper code too long for rendered mode ({len(ai_code):,} chars)")
    page, excerpt, limit = cleaned, False, len(cleaned)
    packed = _pack(page)
    while len(packed) > budget:
        limit = int(limit * 0.7)
        if limit < 2_000:
            raise ValueError("rendered page does not fit in the /run code limit")
        start, end, _ = ai_client.best_price_window(cleaned, limit)
        page, excerpt = cleaned[start:end], True
        packed = _pack(page)
    run_code = _WRAPPER_HEAD + packed + _WRAPPER_TAIL + ai_code
    info = {"page_chars": len(page), "cleaned_chars": len(cleaned), "excerpt": excerpt,
            "run_code_chars": len(run_code)}
    return run_code, info
