"""Deterministic price verification (no AI).

- evidence_check: every extracted price must appear in the page's visible text.
- compare_prices: compare the prices the vision model saw with the extracted ones.

Prices are whole SEK with decimals dropped (51.77 -> 51). Matching allows +-1 SEK.
"""
import math
import re

from bs4 import BeautifulSoup, Comment

PRICE_TOLERANCE = 1

_HIDDEN_STYLE = re.compile(
    r"display\s*:\s*none|visibility\s*:\s*hidden|opacity\s*:\s*0(?:\.0+)?\s*(?:;|$)"
    r"|font-size\s*:\s*0|(?:left|top)\s*:\s*-\d{3,}", re.I)
# "1 149", "1,149.00", "1.299", "51.77", "129,50" (space/nbsp/thin space, comma or dot groups)
_GROUPED = re.compile(r"\d{1,3}(?:[   .,]\d{3})+(?:[.,]\d{1,2})?(?!\d)")
_DECIMAL = re.compile(r"\d+(?:[.,]\d{1,2})?(?!\d)")
_DIGITS = re.compile(r"\d+")


def _is_hidden(tag) -> bool:
    return (tag.has_attr("hidden") or tag.get("aria-hidden") == "true"
            or bool(_HIDDEN_STYLE.search(tag.get("style") or "")))


def _drop_non_content(soup) -> None:
    for tag in soup(["script", "style", "noscript", "template", "head", "svg"]):
        tag.decompose()


def visible_text(html: str) -> str:
    """Text a user would see: drops script/style/head and inline-hidden elements."""
    soup = BeautifulSoup(html or "", "html.parser")
    _drop_non_content(soup)
    for tag in soup.find_all(True):
        if not tag.decomposed and _is_hidden(tag):
            tag.decompose()
    return soup.get_text(" ")


def hidden_texts(html: str) -> list[str]:
    """Text a user would NOT see but a scraper/LLM would: inline-hidden elements and
    HTML comments. One string per outermost hidden element/comment."""
    soup = BeautifulSoup(html or "", "html.parser")
    out = [str(c) for c in soup.find_all(string=lambda t: isinstance(t, Comment))]
    _drop_non_content(soup)
    for tag in soup.find_all(True):
        if tag.decomposed or not _is_hidden(tag):
            continue
        text = tag.get_text(" ")
        for attr in ("alt", "title", "aria-label", "content"):  # text hidden in attributes
            if tag.get(attr):
                text += " " + str(tag[attr])
        out.append(text)
        tag.decompose()  # don't report nested hidden children twice
    return [" ".join(t.split()) for t in out if t.strip()]


# Phrases typical of prompt injection aimed at an AI agent / code generator.
_INJECTION_PATTERNS = [
    r"ignore\s+(?:all\s+|any\s+)?(?:previous|prior|above|earlier|preceding)\s+(?:instructions|prompts?|rules)",
    r"disregard\s+(?:all\s+|any\s+|the\s+)?(?:previous|prior|above|earlier)?\s*(?:instructions|prompts?|rules)",
    r"(?:new|updated|override|system)\s+(?:instructions|prompt)",
    r"\b(?:ai|llm|gpt)\s+(?:agent|assistant|model|scraper)\b",
    r"\byou\s+are\s+(?:now\s+)?(?:an?\s+)?(?:ai|assistant|agent|language model)",
    r"\b(?:add|insert|include|append)\s+(?:this|the following|.{0,30}?)\s+to\s+your\s+(?:code|script|output|answer)",
    r"os\.system\s*\(|subprocess\.|\beval\s*\(|\bexec\s*\(|__import__\s*\(",
    r"\brm\s+-rf\b|\bcurl\s+https?://|\bwget\s+https?://",
    r"(?:api[_ ]?key|password|secret|token|credentials?)\s+(?:to|into|at)\s+https?://",
]
_INJECTION_RX = re.compile("|".join(f"(?:{p})" for p in _INJECTION_PATTERNS), re.I)


def injection_findings(html: str, limit: int = 5) -> list[dict]:
    """Hidden page text containing instruction-like phrases.
    Returns [{"phrases": [...], "snippet": str}] (both are untrusted page text)."""
    found = []
    for text in hidden_texts(html):
        phrases = list(dict.fromkeys(m.group(0) for m in _INJECTION_RX.finditer(text)))
        if phrases:
            found.append({"phrases": phrases[:5], "snippet": text[:200]})
        if len(found) >= limit:
            break
    return found


def _token_to_int(tok: str) -> int:
    """'1 149,50' -> 1149, '51.77' -> 51, '1.299' -> 1299."""
    tok = re.sub(r"[.,]\d{1,2}$", "", tok)       # drop decimals
    return int(re.sub(r"\D", "", tok))


def price_candidates(text: str) -> set[int]:
    """All whole-SEK values that a price in `text` could normalise to (lenient on purpose:
    it only has to catch prices that are NOT on the page)."""
    out: set[int] = set()
    for rx in (_GROUPED, _DECIMAL):
        for m in rx.finditer(text):
            out.add(_token_to_int(m.group(0)))
    out.update(int(d) for d in _DIGITS.findall(text))
    return out


def to_whole_sek(x) -> int | None:
    """Vision output item -> whole SEK. Accepts 79, 51.77, '51,77', '£51.77', '1 149 kr'."""
    if isinstance(x, bool):
        return None
    if isinstance(x, (int, float)):
        return math.floor(x) if math.isfinite(x) and x >= 0 else None
    m = _GROUPED.search(str(x)) or _DECIMAL.search(str(x))
    return _token_to_int(m.group(0)) if m else None


def _near(value: int, pool) -> bool:
    return any(abs(value - p) <= PRICE_TOLERANCE for p in pool)


def evidence_check(items: list[dict], html: str) -> tuple[bool, str]:
    if not (html or "").strip():
        return True, "evidence check skipped (no page HTML)"
    found = price_candidates(visible_text(html))
    missing = [it for it in items if not _near(it["price_sek"], found)]
    if missing:
        shown = "; ".join(f"{it['name'][:40]}={it['price_sek']}" for it in missing[:5])
        return False, (f"evidence check: {len(missing)}/{len(items)} extracted prices do not appear "
                       f"in the page's visible text: {shown}")
    return True, f"evidence check: all {len(items)} prices appear in the page text"


def compare_prices(items: list[dict], visible: list[int], cropped: bool) -> tuple[bool, str]:
    """Match vision-seen prices against extracted ones (multiset, +-1 SEK).
    Fails if the screenshot shows prices we did not extract, or (when the whole page was
    visible) if we extracted prices the screenshot does not show."""
    if not visible:
        raise ValueError("vision model listed no prices")
    pool = [it["price_sek"] for it in items]
    unmatched_visible = []
    for v in sorted(visible):
        for cand in (v, v - 1, v + 1):
            if cand in pool:
                pool.remove(cand)
                break
        else:
            unmatched_visible.append(v)
    matched = len(visible) - len(unmatched_visible)
    problems = []
    if unmatched_visible:
        problems.append(f"screenshot shows prices not in the data: {unmatched_visible[:8]}")
    if pool and not cropped:
        problems.append(f"extracted prices not in the screenshot: {sorted(pool)[:8]}")
    if problems:
        return False, "vision check disagrees: " + " | ".join(problems)
    note = f" ({len(pool)} below the visible area, checked by evidence only)" if pool else ""
    return True, f"vision check agrees: {matched}/{len(visible)} visible prices matched{note}"
