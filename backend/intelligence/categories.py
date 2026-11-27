"""Product category inference and reference price bands.

The scraper contract is {name, price_sek}; a record may also carry "category". When
it doesn't, the category is inferred from the product name with a small keyword
taxonomy. Every inference says where it came from ("field" or "name keyword").

Reference bands are DOMAIN PRIORS: typical retail price ranges for new equipment in
Sweden, used only to judge plausibility. They are never presented as facts about the
scraped site, and a value outside a band is a reason to investigate, not an error.
"""
import re

# key: (label, keywords (regex, matched on the lower-cased name), typical band in SEK)
TAXONOMY = [
    ("iron_set", "Iron set", r"\biron set\b|\birons?\s*\(\d|\b\d-pw\b|\b[3-6]-(?:pw|gw|sw)\b", (3500, 22000)),
    ("driver", "Driver", r"\bdriver\b", (2000, 9500)),
    ("fairway", "Fairway wood", r"\bfairway\b|\b[357]-wood\b", (1500, 5500)),
    ("hybrid", "Hybrid", r"\bhybrid\b|\brescue\b", (1200, 4500)),
    ("wedge", "Wedge", r"\bwedge\b", (700, 3000)),
    ("putter", "Putter", r"\bputter\b", (900, 8000)),
    ("iron", "Iron", r"\biron\b", (900, 3500)),
    ("balls", "Golf balls", r"\bballs?\b|\bdozen\b", (150, 900)),
    ("bag", "Golf bag", r"\bbag\b", (800, 6000)),
]
_COMPILED = [(k, label, re.compile(rx, re.I), band) for k, label, rx, band in TAXONOMY]
_BY_LABEL = {label.lower(): (k, label, band) for k, label, _, band in TAXONOMY}
_BY_LABEL.update({"fairway wood": ("fairway", "Fairway wood", (1500, 5500))})

UNCATEGORISED = {"key": "uncategorised", "label": "Uncategorised", "source": "none", "band": None}


def infer(record: dict) -> dict:
    """-> {"key", "label", "source": "field"|"name keyword"|"none", "band": [lo, hi]|None}"""
    field = record.get("category")
    if isinstance(field, str) and field.strip():
        known = _BY_LABEL.get(field.strip().lower())
        if known:
            k, label, band = known
            return {"key": k, "label": label, "source": "field", "band": list(band)}
        label = " ".join(field.split())[:60]
        return {"key": re.sub(r"\W+", "_", label.lower()).strip("_") or "other", "label": label,
                "source": "field", "band": None}
    name = str(record.get("name") or "")
    for k, label, rx, band in _COMPILED:
        if rx.search(name):
            return {"key": k, "label": label, "source": "name keyword", "band": list(band)}
    return dict(UNCATEGORISED)
