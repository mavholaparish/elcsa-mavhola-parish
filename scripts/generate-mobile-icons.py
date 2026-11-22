#!/usr/bin/env python3
"""Generate matching ELCSA Mavhola Parish native app icons for Android and iOS."""
import io
import json
import os
import urllib.request
from PIL import Image, ImageDraw

ROOT = os.getcwd()
LOGO_PATH = os.path.join(ROOT, "public", "elcsa-logo.png")
LOGO_URL = "https://raw.githubusercontent.com/mavholaparish/elcsa-mavhola-parish/storage-migration/neon-r2/public/elcsa-logo.png"
NAVY = (8, 43, 101, 255)
GOLD = (221, 180, 83, 255)

if not os.path.exists(LOGO_PATH):
    with urllib.request.urlopen(LOGO_URL, timeout=30) as response:
        logo_bytes = response.read()
    logo = Image.open(io.BytesIO(logo_bytes)).convert("RGBA")
else:
    logo = Image.open(LOGO_PATH).convert("RGBA")

def make_icon(size, round_mask=False):
    canvas = Image.new("RGBA", (size, size), NAVY)
    # A restrained gold ring gives the parish logo a consistent app-icon frame.
    margin = int(size * 0.075)
    ImageDraw.Draw(canvas).ellipse((margin, margin, size-margin, size-margin), outline=GOLD, width=max(1, int(size*0.012)))
    max_logo = int(size * 0.72)
    logo_copy = logo.copy()
    logo_copy.thumbnail((max_logo, max_logo), Image.Resampling.LANCZOS)
    x = (size-logo_copy.width)//2
    y = (size-logo_copy.height)//2
    canvas.alpha_composite(logo_copy, (x, y))
    if round_mask:
        mask = Image.new("L", (size, size), 0)
        ImageDraw.Draw(mask).ellipse((0, 0, size-1, size-1), fill=255)
        canvas.putalpha(mask)
    return canvas

# Android legacy launcher icon densities and adaptive icon assets.
android_res = os.path.join(ROOT, "android", "app", "src", "main", "res")
for folder, size in [("mipmap-mdpi",48),("mipmap-hdpi",72),("mipmap-xhdpi",96),("mipmap-xxhdpi",144),("mipmap-xxxhdpi",192)]:
    out = os.path.join(android_res, folder)
    os.makedirs(out, exist_ok=True)
    make_icon(size).save(os.path.join(out, "ic_launcher.png"))
    make_icon(size, round_mask=True).save(os.path.join(out, "ic_launcher_round.png"))
adaptive = os.path.join(android_res, "drawable")
os.makedirs(adaptive, exist_ok=True)
foreground = Image.new("RGBA", (432,432), (0,0,0,0))
lg = logo.copy()
lg.thumbnail((300,300), Image.Resampling.LANCZOS)
foreground.alpha_composite(lg, ((432-lg.width)//2, (432-lg.height)//2))
foreground.save(os.path.join(adaptive, "ic_launcher_foreground.png"))
os.makedirs(os.path.join(android_res, "mipmap-anydpi-v26"), exist_ok=True)
with open(os.path.join(android_res, "mipmap-anydpi-v26", "ic_launcher.xml"), "w") as f:
    f.write('<?xml version="1.0" encoding="utf-8"?>\n<adaptive-icon xmlns:android="http://schemas.android.com/apk/res/android"><background android:drawable="@color/ic_launcher_background"/><foreground android:drawable="@drawable/ic_launcher_foreground"/></adaptive-icon>\n')
values = os.path.join(android_res, "values")
os.makedirs(values, exist_ok=True)
with open(os.path.join(values, "ic_launcher_background.xml"), "w") as f:
    f.write('<?xml version="1.0" encoding="utf-8"?>\n<resources><color name="ic_launcher_background">#082B65</color></resources>\n')

# iOS AppIcon asset catalog.
ios_assets = os.path.join(ROOT, "ios", "App", "App", "Assets.xcassets")
iconset = os.path.join(ios_assets, "AppIcon.appiconset")
os.makedirs(iconset, exist_ok=True)
items = []
specs = [
    ("20", "2x", "iphone"), ("20", "3x", "iphone"),
    ("29", "2x", "iphone"), ("29", "3x", "iphone"),
    ("40", "2x", "iphone"), ("40", "3x", "iphone"),
    ("60", "2x", "iphone"), ("60", "3x", "iphone"),
    ("20", "1x", "ipad"), ("20", "2x", "ipad"),
    ("29", "1x", "ipad"), ("29", "2x", "ipad"),
    ("40", "1x", "ipad"), ("40", "2x", "ipad"),
    ("76", "1x", "ipad"), ("76", "2x", "ipad"),
    ("83.5", "2x", "ipad"),
    ("1024", "1x", "ios-marketing"),
]
seen = set()
for logical, scale, idiom in specs:
    px = int(float(logical) * int(scale[0]))
    filename = f"icon-{logical.replace('.','_')}-{scale}-{idiom}.png"
    make_icon(px).save(os.path.join(iconset, filename))
    entry = {"filename": filename, "idiom": idiom, "scale": scale, "size": f"{logical}x{logical}"}
    key = (logical, scale, idiom)
    if key not in seen:
        items.append(entry); seen.add(key)
with open(os.path.join(iconset, "Contents.json"), "w") as f:
    json.dump({"images": items, "info": {"author": "xcode", "version": 1}}, f, indent=2)
print("Generated ELCSA Mavhola Parish icons for Android and iOS.")
