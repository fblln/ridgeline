import re, math, sys

def encode(coords, precision):
    factor = 10 ** precision
    out, prev = [], (0, 0)
    for lat, lon in coords:
        for cur, p in ((round(lat*factor), prev[0]), (round(lon*factor), prev[1])):
            v = (cur - p) << 1
            if cur - p < 0: v = ~v
            while v >= 0x20:
                out.append(chr((0x20 | (v & 0x1f)) + 63)); v >>= 5
            out.append(chr(v + 63))
        prev = (round(lat*factor), round(lon*factor))
    return "".join(out)

def perp_dist_m(p, a, b):
    # project onto segment a-b in local meters (equirectangular around a)
    lat0 = math.radians(a[0])
    mx = lambda lon: math.radians(lon) * math.cos(lat0) * 6371000
    my = lambda lat: math.radians(lat) * 6371000
    ax, ay = mx(a[1]), my(a[0]); bx, by = mx(b[1]), my(b[0]); px, py = mx(p[1]), my(p[0])
    dx, dy = bx-ax, by-ay
    if dx == 0 and dy == 0: return math.hypot(px-ax, py-ay)
    t = ((px-ax)*dx + (py-ay)*dy) / (dx*dx+dy*dy)
    t = max(0, min(1, t))
    return math.hypot(px-(ax+t*dx), py-(ay+t*dy))

def rdp(pts, eps):
    if len(pts) < 3: return pts
    dmax, idx = 0, 0
    for i in range(1, len(pts)-1):
        d = perp_dist_m(pts[i], pts[0], pts[-1])
        if d > dmax: dmax, idx = d, i
    if dmax > eps:
        return rdp(pts[:idx+1], eps)[:-1] + rdp(pts[idx:], eps)
    return [pts[0], pts[-1]]

gpx = open(sys.argv[1] if len(sys.argv) > 1 else "Morning_Hike.gpx").read()
coords = [(float(a), float(b)) for a, b in re.findall(r'lat="([^"]+)"\s+lon="([^"]+)"', gpx)]
print(f"points: {len(coords)}")

for p in (6, 5):
    print(f"polyline p{p}: {len(encode(coords, p))} bytes")

sys.setrecursionlimit(100000)
simplified = rdp(coords, 1.0)
print(f"after rdp 1m: {len(simplified)} points")
print(f"polyline p5 (rdp 1m): {len(encode(simplified, 5))} bytes")
