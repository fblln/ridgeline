#!/usr/bin/env python3
"""Sandbox: drop in a GPX -> 16 camera angles -> pick one -> full-res image.

  python trek.py angles hike.gpx        # -> hike-angles.png  (16 heuristic shots, 0-15)
  python trek.py final  hike.gpx 6      # -> hike-final.png   (full-res render of #6)

Angles are auto-chosen: look across the track's long axis from the open/downhill side,
at a flattering tilt (no edge-on or occluded shots). DEM auto-picks (LiDAR where covered,
else global SRTM). Override anything via env:
  DEM=srtm STYLE=texture ZOOM=2.0 python trek.py final hike.gpx 6
"""
import os, sys, json, subprocess, tempfile
import numpy as np
from PIL import Image, ImageDraw, ImageFont

def crop_sky(path, margin=30):   # trim the blue sky gradient so the map fills the frame
    im = Image.open(path).convert("RGB"); a = np.asarray(im).astype(int)
    R, G, B = a[:, :, 0], a[:, :, 1], a[:, :, 2]
    notsky = ~((B > R+12) & (B > G+12))          # sky = blue-dominant gradient
    ys, xs = np.where(notsky)
    if len(xs) < 100:
        return
    h, w = a.shape[:2]
    box = (max(0, xs.min()-margin), max(0, ys.min()-margin),
           min(w, xs.max()+margin), min(h, ys.max()+margin))
    im.crop(box).save(path)

NCOL = 4   # contact-sheet columns (engine renders 4 azimuths x 4 elevations)

def run(gpx, env):               # invoke the render engine with our env on top
    # default to the textured map look (colors + sky); engine frames the whole track. user env still wins
    e = {"STYLE": "texture", **os.environ, "GPX": os.path.abspath(gpx), **env}
    subprocess.run([sys.executable, "plot3d_pv.py"], check=True,
                   cwd=os.path.dirname(os.path.abspath(__file__)), env=e)

def _font(sz):
    for p in ("/System/Library/Fonts/Supplemental/Arial Bold.ttf", "/System/Library/Fonts/Helvetica.ttc"):
        try: return ImageFont.truetype(p, sz)
        except Exception: pass
    return ImageFont.load_default()

def angles(gpx):
    stem = os.path.splitext(os.path.basename(gpx))[0]
    with tempfile.TemporaryDirectory() as d:
        run(gpx, {"OUTDIR": d})                       # engine picks the angles + writes angles.json
        man = json.load(open(f"{d}/angles.json"))
        json.dump(man, open(f"{stem}-angles.json", "w"))   # keep for `final` to reuse exact angles
        N = len(man); rows = (N + NCOL-1)//NCOL
        TW, TH, pad, lab = 600, 450, 12, 30
        sheet = Image.new("RGB", (NCOL*(TW+pad)+pad, rows*(TH+lab+pad)+pad), (24, 28, 34))
        dr = ImageDraw.Draw(sheet); f = _font(24)
        for n, a in enumerate(man):
            x, y = pad+(n % NCOL)*(TW+pad), pad+(n//NCOL)*(TH+lab+pad)
            sheet.paste(Image.open(f"{d}/a{n}.png").convert("RGB").resize((TW, TH)), (x, y+lab))
            dr.text((x+6, y+4), f"#{n}   az {a['az']:.0f}  ·  el {a['el']:.0f}", font=f, fill="white")
        out = f"{stem}-angles.png"; sheet.save(out)
        print(f"wrote {out} — pick a number, then: python trek.py final {gpx} <n>")

def final(gpx, n):
    stem = os.path.splitext(os.path.basename(gpx))[0]
    man = json.load(open(f"{stem}-angles.json"))      # written by `angles`
    a = man[n]
    out = f"{stem}-final.png"
    # high fidelity: bigger output, finer mesh, zoomed in so the map fills the frame (user env still wins)
    hi = {"RES": "3600", "MESH": "1600", "ZOOM": "1.2", "NOTEXT": "1", **os.environ}
    run(gpx, {"AZ": str(a["az"]), "EL": str(a["el"]), "OUT": out, **{k: hi[k] for k in ("RES", "MESH", "ZOOM", "NOTEXT")}})
    crop_sky(out)            # trim surrounding sky so the map fills the image
    print(f"wrote {out}  (#{n}: az {a['az']:.0f}, el {a['el']:.0f})")

if __name__ == "__main__":
    a = sys.argv[1:]
    if a[:1] == ["angles"] and len(a) == 2: angles(a[1])
    elif a[:1] == ["final"] and len(a) == 3: final(a[1], int(a[2]))
    else: print(__doc__)
