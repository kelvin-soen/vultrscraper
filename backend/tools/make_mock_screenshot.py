"""Generate mock_assets/shop.png: a fake shop screenshot that matches the mock HTML.

Run: .venv/bin/python tools/make_mock_screenshot.py
"""
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

import sys
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from sandbox_client import MOCK_PRODUCTS  # noqa: E402

FONT = "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf"
BOLD = "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf"
OUT = Path(__file__).resolve().parent.parent / "mock_assets" / "shop.png"

W, H = 1000, 640
img = Image.new("RGB", (W, H), "#f4f4f6")
d = ImageDraw.Draw(img)
title, h2, body, price_f = (ImageFont.truetype(BOLD, 34), ImageFont.truetype(BOLD, 20),
                            ImageFont.truetype(FONT, 16), ImageFont.truetype(BOLD, 24))

# header bar
d.rectangle([0, 0, W, 80], fill="#1f3a5f")
d.text((30, 20), "Demo Shop", fill="white", font=title)
d.text((W - 210, 30), "Varukorg (0)", fill="white", font=body)
d.text((30, 100), "Veckans erbjudanden", fill="#222", font=h2)

# product cards, 4 per row
cw, ch, gap, x0, y0 = 220, 220, 20, 30, 145
for i, p in enumerate(MOCK_PRODUCTS):
    x = x0 + (i % 4) * (cw + gap)
    y = y0 + (i // 4) * (ch + gap)
    d.rounded_rectangle([x, y, x + cw, y + ch], radius=10, fill="white", outline="#ddd")
    d.rectangle([x + 15, y + 15, x + cw - 15, y + 95], fill="#e3e8ef")  # image placeholder
    d.text((x + 15, y + 110), p["name"], fill="#222", font=body)
    d.text((x + 15, y + 145), f"{p['price_sek']} kr", fill="#c0392b", font=price_f)
    d.rounded_rectangle([x + 15, y + 182, x + 120, y + 208], radius=6, fill="#1f3a5f")
    d.text((x + 25, y + 186), "Köp", fill="white", font=body)

OUT.parent.mkdir(exist_ok=True)
img.save(OUT, "PNG")
print(f"wrote {OUT} ({OUT.stat().st_size} bytes)")

# ---------- v2: changed layout (list rows, "69:-" prices, sale banner) ----------
from sandbox_client import MOCK_PRODUCTS_V2  # noqa: E402

OUT2 = OUT.parent / "shop_v2.png"
W2, H2 = 1000, 700
img = Image.new("RGB", (W2, H2), "white")
d = ImageDraw.Draw(img)
d.rectangle([0, 0, W2, 64], fill="#0b6e4f")
d.text((30, 14), "Demo Shop", fill="white", font=ImageFont.truetype(BOLD, 28))
d.rectangle([0, 64, W2, 110], fill="#ffd166")
d.text((30, 75), "KAMPANJVECKA  -  nya priser!", fill="#222", font=h2)
row_h, y = 66, 125
for i, p in enumerate(MOCK_PRODUCTS_V2):
    if i % 2 == 0:
        d.rectangle([20, y, W2 - 20, y + row_h - 6], fill="#f2f7f5")
    d.text((40, y + 18), f"{i + 1}.", fill="#888", font=body)
    d.text((80, y + 16), p["name"], fill="#222", font=h2)
    d.text((W2 - 330, y + 14), f"{p['price_sek']}:-", fill="#0b6e4f", font=price_f)
    d.rounded_rectangle([W2 - 200, y + 12, W2 - 40, y + 46], radius=6, fill="#0b6e4f")
    d.text((W2 - 188, y + 19), "Lägg i korgen", fill="white", font=body)
    y += row_h
img.save(OUT2, "PNG")
print(f"wrote {OUT2} ({OUT2.stat().st_size} bytes)")
