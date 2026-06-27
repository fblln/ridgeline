import re
from poly import encode, rdp

gpx = open("Morning_Hike.gpx").read()
coords = [(float(a), float(b)) for a, b in re.findall(r'lat="([^"]+)"\s+lon="([^"]+)"', gpx)]
import sys; sys.setrecursionlimit(100000)
simp = rdp(coords, 1.0)

raw_bytes = 686877            # compact GeoJSON coords
poly_bytes = len(encode(simp, 5))

# --- layout (mirrors monza-polyline-before-after.svg) ---
W, CARD_X, CARD_W, CARD_H = 760, 30, 700, 470
PAD = 40  # plot padding inside card below the two header lines

def project(pts, card_y):
    lats = [p[0] for p in pts]; lons = [p[1] for p in pts]
    x0 = CARD_X + PAD; y0 = card_y + 80
    pw = CARD_W - 2*PAD; ph = CARD_H - 80 - PAD
    minlat, maxlat = min(lats), max(lats); minlon, maxlon = min(lons), max(lons)
    # equal scale, preserve track shape (lon compressed by cos lat)
    import math
    cos = math.cos(math.radians((minlat+maxlat)/2))
    spanx = (maxlon-minlon)*cos or 1e-9; spany = (maxlat-minlat) or 1e-9
    s = min(pw/spanx, ph/spany)
    ox = x0 + (pw - spanx*s)/2; oy = y0 + (ph - spany*s)/2
    out = []
    for lat, lon in pts:
        x = ox + (lon-minlon)*cos*s
        y = oy + (maxlat-lat)*s   # flip: north up
        out.append((round(x,1), round(y,1)))
    return out

def panel(card_y, title, sub, color, pts, dots):
    poly = projectpts = project(pts, card_y)
    s = [f'<rect x="30" y="{card_y}" width="700" height="470" rx="12" fill="#ffffff" stroke="#cbd5e1"/>',
         f'<text x="54.0" y="{card_y+38}" font-family="Inter, Arial, sans-serif" font-size="19" font-weight="700" fill="{color}">{title}</text>',
         f'<text x="54.0" y="{card_y+62}" font-family="Inter, Arial, sans-serif" font-size="14" font-weight="400" fill="#475569">{sub}</text>']
    ptstr = " ".join(f"{x},{y}" for x, y in poly)
    s.append(f'<polyline points="{ptstr}" fill="none" stroke="{color if dots else "#94a3b8"}" stroke-width="2.0" stroke-linejoin="round" stroke-linecap="round" opacity="{0.9 if dots else 0.6}"/>')
    if dots:
        for x, y in poly:
            s.append(f'<circle cx="{x}" cy="{y}" r="2.2" fill="{color}"/>')
    return "\n".join(s)

def fmt(n): return f"{n:,}"

svg = [f'<svg xmlns="http://www.w3.org/2000/svg" width="760" height="1194" viewBox="0 0 760 1194">',
       '<rect width="100%" height="100%" fill="#f8fafc"/>',
       '<text x="30.0" y="44.0" font-family="Inter, Arial, sans-serif" font-size="24" font-weight="700" fill="#111827">Morning Hike: GPS LineString → encoded polyline</text>',
       '<text x="30.0" y="72.0" font-family="Inter, Arial, sans-serif" font-size="14" font-weight="400" fill="#475569">Ramer–Douglas–Peucker @ 1.0 m, then polyline encoding (precision 5).</text>',
       '<text x="30.0" y="92.0" font-family="Inter, Arial, sans-serif" font-size="14" font-weight="400" fill="#475569">Track shape preserved; redundant points dropped.</text>',
       panel(116, "Before — raw GPS LineString", f"{fmt(len(coords))} points · {fmt(raw_bytes)} bytes (GeoJSON coords)", "#dc2626", coords, False),
       panel(612, "After — simplified + encoded polyline", f"{fmt(len(simp))} points · {fmt(poly_bytes)} bytes (polyline string)", "#059669", simp, True),
       '<rect x="30" y="1106" width="700" height="64" rx="10" fill="#0f172a"/>',
       f'<text x="52.0" y="1146.0" font-family="Inter, Arial, sans-serif" font-size="19" font-weight="700" fill="#f8fafc">{fmt(raw_bytes)} bytes  →  {fmt(poly_bytes)} bytes  ({raw_bytes/poly_bytes:.0f}× smaller)</text>',
       '</svg>']
open("Morning_Hike-polyline-before-after.svg", "w").write("\n".join(svg))
print(f"raw {len(coords)} pts / {raw_bytes} B  ->  rdp {len(simp)} pts / {poly_bytes} B")
