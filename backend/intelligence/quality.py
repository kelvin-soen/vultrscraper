"""Deterministic data quality (extraction verification) and anomaly signals (semantic
plausibility). No AI here; every number is computed from the records, the page, the
saved history or the documented category priors.
"""
import math
import re
import statistics

import verify

from . import categories
from .history import product_key

# Plausibility thresholds (documented in INTEGRATION_HANDOFF.md).
BAND_FACTOR_HIGH = 2.0       # price > 2x the top of the category band
BAND_FACTOR_LOW = 3.0        # price < 1/3 of the bottom of the band
PEER_RATIO = 4.0             # 4x above / below the median of same-category peers
ROBUST_Z = 3.5               # robust z-score on log10(price), whole dataset (n >= 6)
HISTORY_RATIO = 2.5          # >= 2.5x up or <= 1/2.5 down vs last unflagged observation
SHIFT_FACTORS = (10, 100)    # digit / decimal-shift signatures
FLAG_SCORE = 2

_WS = re.compile(r"\s+")


def _norm(text: str) -> str:
    return _WS.sub(" ", text or "").strip()


def _median(xs):
    return statistics.median(xs) if xs else None


def _fmt(n) -> str:
    return f"{round(n):,}".replace(",", " ") + " kr"


def locate(visible: str, name: str, price: int, window: int = 160) -> dict:
    """Find the record on the page: the name in the visible text and the price close to it.
    -> {"name_found", "price_near_name", "excerpt"} (excerpt is untrusted page text)."""
    lo = visible.lower()
    i = lo.find(_norm(name).lower())
    if i < 0:
        return {"name_found": False, "price_near_name": False, "excerpt": None}
    start = max(0, i - 20)
    seg = visible[start:i + len(name) + window]
    near = any(abs(price - c) <= verify.PRICE_TOLERANCE for c in verify.price_candidates(seg[i - start:]))
    return {"name_found": True, "price_near_name": near, "excerpt": seg.strip()[:240]}


def _shift(ratio: float) -> int | None:
    for f in SHIFT_FACTORS:
        if abs(ratio - f) / f <= 0.02 or abs(ratio - 1 / f) * f <= 0.02:
            return f
    return None


def analyze(items: list[dict], html: str, prev: dict, *, verdict: str) -> dict:
    """items: verified records. prev: {product_key: observation} from history.previous().
    verdict: final attempt verdict ("pass" = evidence + vision, "unverified" = evidence only)."""
    visible = _norm(verify.visible_text(html)) if html else ""
    page_prices = verify.price_candidates(visible) if visible else set()
    n = len(items)

    recs = []
    for i, it in enumerate(items):
        cat = categories.infer(it)
        loc = locate(visible, it["name"], it["price_sek"]) if visible else \
            {"name_found": None, "price_near_name": None, "excerpt": None}
        on_page = any(abs(it["price_sek"] - p) <= verify.PRICE_TOLERANCE for p in page_prices) if visible else None
        recs.append({"index": i, "name": it["name"], "price_sek": it["price_sek"], "category": cat,
                     "on_page": on_page, "location": loc, "signals": [], "score": 0,
                     "flagged": False, "severity": None,
                     "previous": prev.get(product_key(it["name"]))})

    # ---- dataset statistics ------------------------------------------------
    prices = [r["price_sek"] for r in recs]
    by_cat: dict[str, list[dict]] = {}
    for r in recs:
        by_cat.setdefault(r["category"]["key"], []).append(r)
    cat_stats = []
    for key, rs in by_cat.items():
        ps = sorted(r["price_sek"] for r in rs)
        cat_stats.append({"key": key, "label": rs[0]["category"]["label"], "count": len(rs),
                          "median": _median(ps), "min": ps[0], "max": ps[-1],
                          "band": rs[0]["category"]["band"], "source": rs[0]["category"]["source"]})
    cat_stats.sort(key=lambda c: -(c["median"] or 0))
    logs = [math.log10(p) for p in prices if p > 0]
    log_med = _median(logs)
    mad = _median([abs(x - log_med) for x in logs]) if logs else None
    stats = {"count": n, "min": min(prices) if prices else None, "max": max(prices) if prices else None,
             "median": _median(prices), "mean": round(statistics.fmean(prices)) if prices else None,
             "categories": cat_stats,
             "categorised": sum(1 for r in recs if r["category"]["source"] != "none")}

    # ---- plausibility signals ---------------------------------------------
    for r in recs:
        p, cat, sig = r["price_sek"], r["category"], r["signals"]
        band = cat["band"]
        if band:
            if p > band[1] * BAND_FACTOR_HIGH:
                f = p / band[1]
                sig.append({"id": "category_band", "weight": 2 if f >= 5 else 1,
                            "detail": f"{f:.1f}× the top of the typical {cat['label'].lower()} range "
                                      f"({_fmt(band[0])}–{_fmt(band[1])}, reference prior)",
                            "ratio": round(f, 2)})
            elif p < band[0] / BAND_FACTOR_LOW:
                sig.append({"id": "category_band", "weight": 1,
                            "detail": f"far below the typical {cat['label'].lower()} range "
                                      f"({_fmt(band[0])}–{_fmt(band[1])}, reference prior)",
                            "ratio": round(p / band[0], 3)})
        peers = [x["price_sek"] for x in by_cat[cat["key"]] if x is not r]
        # Peers contaminate each other in small groups (a normal driver looks "cheap" next to
        # a 10x typo), so with a known band the peer signal only counts on the side where the
        # value is also outside the band; without a band it needs >= 3 peers.
        enough = len(peers) >= (1 if band else 3)
        if cat["key"] != "uncategorised" and enough:
            med = _median(peers)
            ratio = p / med
            outside = (not band) or (ratio > 1 and p > band[1]) or (ratio < 1 and p < band[0])
            if outside and (ratio >= PEER_RATIO or ratio <= 1 / PEER_RATIO):
                sig.append({"id": "category_peers", "weight": 2,
                            "detail": f"{ratio:.1f}× the median of {len(peers)} other "
                                      f"{cat['label'].lower()} listing{'s' if len(peers) != 1 else ''} "
                                      f"on this page ({_fmt(med)})", "ratio": round(ratio, 2)})
        if n >= 6 and mad:
            z = 0.6745 * (math.log10(p) - log_med) / mad
            if abs(z) > ROBUST_Z:
                sig.append({"id": "dataset_outlier", "weight": 1,
                            "detail": f"statistical outlier in this dataset (robust z = {z:.1f} on log price)",
                            "z": round(z, 2)})
        pv = r["previous"]
        if pv and pv.get("price"):
            ratio = p / pv["price"]
            if ratio >= HISTORY_RATIO or ratio <= 1 / HISTORY_RATIO:
                shift = _shift(ratio)
                sig.append({"id": "history_jump", "weight": 2,
                            "detail": f"was {_fmt(pv['price'])} at {pv['at'].replace('T', ' ')[:16]} UTC "
                                      f"({ratio:.2f}× change)"
                                      + (f"; exactly {shift}× suggests a digit or decimal shift" if shift else ""),
                            "ratio": round(ratio, 3), "shift": shift})
        if band and p > band[1] * BAND_FACTOR_HIGH:
            for f in SHIFT_FACTORS:
                if band[0] <= p / f <= band[1]:
                    r["hint"] = f"{_fmt(p / f)} (÷{f}) would sit inside the typical range"
                    break
        r["score"] = sum(s["weight"] for s in sig)
        r["flagged"] = r["score"] >= FLAG_SCORE
        r["severity"] = "high" if r["score"] >= 4 else "medium" if r["flagged"] else ("low" if sig else None)

    # ---- extraction verification checks ------------------------------------
    names = [product_key(r["name"]) for r in recs]
    dups = sorted({x for x in names if names.count(x) > 1})
    located = [r for r in recs if r["location"]["price_near_name"]]
    checks = [
        {"id": "schema", "lane": "extraction", "label": "Schema valid", "ok": True,
         "detail": f"all {n} records have a name and a positive whole-SEK price"},
        {"id": "evidence", "lane": "extraction", "label": "Values on the page",
         "ok": all(r["on_page"] for r in recs) if visible else None,
         "detail": (f"{sum(1 for r in recs if r['on_page'])}/{n} prices appear in the visible page text"
                    if visible else "page text not available")},
        {"id": "colocation", "lane": "extraction", "label": "Price next to its product",
         "ok": len(located) == n if visible else None,
         "detail": (f"{len(located)}/{n} prices found right after their product name"
                    if visible else "page text not available")},
        {"id": "vision", "lane": "extraction", "label": "Screenshot agrees",
         "ok": True if verdict == "pass" else None,
         "detail": "vision check matched the screenshot" if verdict == "pass"
         else "vision check unavailable; evidence check only"},
        {"id": "duplicates", "lane": "extraction", "label": "No duplicate records", "ok": not dups,
         "detail": "every product name is unique" if not dups else f"duplicates: {', '.join(dups[:5])}"},
        {"id": "categorised", "lane": "plausibility", "label": "Categories recognised",
         "ok": stats["categorised"] == n, "detail": f"{stats['categorised']}/{n} records matched a category"},
        {"id": "history", "lane": "plausibility", "label": "Compared with history",
         "ok": None if not prev else True,
         "detail": (f"{sum(1 for r in recs if r['previous'])}/{n} products seen in earlier runs"
                    if prev else "first verified run for this site: no history yet")},
    ]
    flagged = [r["index"] for r in recs if r["flagged"]]
    return {"records": recs, "stats": stats, "checks": checks, "flagged": flagged,
            "summary": {"records": n, "flagged": len(flagged),
                        "notes": sum(1 for r in recs if r["signals"] and not r["flagged"]),
                        "plausible": n - len(flagged)}}
