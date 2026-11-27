"""In-memory store of working scrapers, one per site (URL without query/fragment)."""
import json
import re
import threading
from urllib.parse import urlsplit, urlunsplit

_SAVED: dict[str, str] = {}
_lock = threading.Lock()

# Generated scrapers must define the target as `URL = "..."` on its own line.
_URL_LINE = re.compile(r'^URL\s*=\s*.*$', re.MULTILINE)


def site_key(url: str) -> str:
    p = urlsplit(url)
    return urlunsplit((p.scheme, p.netloc, p.path, "", ""))


def save(url: str, code: str) -> None:
    with _lock:
        _SAVED[site_key(url)] = code


def get(url: str) -> str | None:
    with _lock:
        return _SAVED.get(site_key(url))


def all_keys() -> list[str]:
    with _lock:
        return sorted(_SAVED)


def set_url(code: str, url: str) -> str:
    """Point a saved scraper at `url` by rewriting its URL constant."""
    if not _URL_LINE.search(code):
        raise ValueError("saved scraper has no `URL = ...` line to retarget")
    # json.dumps gives a valid, safely escaped Python string literal for a URL.
    return _URL_LINE.sub(lambda _: "URL = " + json.dumps(url), code, count=1)
