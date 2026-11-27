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
