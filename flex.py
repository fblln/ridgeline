import re, math, sys, os, brotli, flexpolyline as fp
sys.setrecursionlimit(200000)

g = open(os.environ.get("GPX", "Morning_Hike.gpx")).read()
lat = [float(x) for x in re.findall(r'lat="([^"]+)"', g)]
lon = [float(x) for x in re.findall(r'lon="([^"]+)"', g)]
ele = [float(x) for x in re.findall(r'<ele>([^<]+)</ele>', g)]
n = len(lat)

# project to local meters once (equirectangular about the mean latitude)
lat0 = math.radians(sum(lat)/n); R = 6371000
X = [R*math.radians(lo)*math.cos(lat0) for lo in lon]
Y = [R*math.radians(la) for la in lat]

# ---- elevation smoothing: 60s centered moving average ----
# 1Hz samples + hiking pace: real grade only shows over ~tens of seconds, so a
# 60s low-pass kills baro jitter and brings total ascent to ~1853m (map: 1834m).
def smooth(z, w=60):
    h = w//2; o = []
    for i in range(len(z)):
        a = max(0, i-h); b = min(len(z), i+h+1)
        o.append(sum(z[a:b])/(b-a))
    return o

def ascent(z): return sum(max(0, z[i+1]-z[i]) for i in range(len(z)-1))

# ---- Savitzky-Golay (denoise, keep slope) + hysteresis ascent (deadband) ----
def savgol(z, win=61, poly=2):           # win odd; ~1min window at 1Hz
    from scipy.signal import savgol_filter
    return list(savgol_filter(z, win, poly))

def ascent_hyst(z, thr=3.0):             # only bank a climb once it clears `thr`
    tot = 0.0; lo = z[0]
    for v in z[1:]:
        if v > lo + thr: tot += v - lo; lo = v
        elif v < lo: lo = v
    return tot

if __name__ == "__main__":
    sg = savgol(ele)
    print("\n--- elevation cleaning vs Strava 1871 m ---")
    print(f"  raw sum               {ascent(ele):.0f} m")
    print(f"  60s moving average    {ascent(smooth(ele)):.0f} m")
    print(f"  Savitzky-Golay        {ascent(sg):.0f} m")
    print(f"  raw + hysteresis 3m   {ascent_hyst(ele):.0f} m")
    print(f"  SavGol + hysteresis   {ascent_hyst(sg):.0f} m")

# ---- index-based simplifier: RDP (perpendicular) or TD-TR (synchronized) ----
# method='rdp'  -> perpendicular distance: minimizes map-line (cross-track) error.
# method='tdtr' -> synchronized distance: where constant-velocity travel would put
#                  you at sample i (index ratio == time ratio at 1Hz). Spends points
#                  where momentum changed (switchbacks/stops); ~halves positional-
#                  timing error vs RDP at the same point budget.
# dim=3 includes smoothed elevation (meters) in the distance; dim=2 ignores it.
def dist(i, s, e, Z, method, dim):
    ax, ay, az = X[s], Y[s], Z[s]; bx, by, bz = X[e], Y[e], Z[e]
    px, py, pz = X[i], Y[i], Z[i]
    if method == "tdtr":
        r = (i-s)/(e-s) if e > s else 0.0
        qx, qy, qz = ax+r*(bx-ax), ay+r*(by-ay), az+r*(bz-az)
    else:  # rdp: closest point on segment
        dx, dy, dz = bx-ax, by-ay, (bz-az if dim == 3 else 0)
        L = dx*dx+dy*dy+dz*dz
        t = max(0, min(1, ((px-ax)*dx+(py-ay)*dy+(pz-az if dim == 3 else 0)*dz)/L)) if L else 0
        qx, qy, qz = ax+t*dx, ay+t*dy, az+t*dz
    return math.hypot(math.hypot(px-qx, py-qy), pz-qz if dim == 3 else 0)

def simplify(eps, Z, method, dim):
    keep = set()
    def rec(s, e):
        dmax = idx = 0
        for i in range(s+1, e):
            d = dist(i, s, e, Z, method, dim)
            if d > dmax: dmax, idx = d, i
        if dmax > eps: rec(s, idx); rec(idx, e)
        else: keep.update((s, e))
    rec(0, n-1)
    return sorted(keep)

def encode(idx, Z):
    triples = [(lat[i], lon[i], Z[i]) for i in idx]
    return fp.encode(triples, third_dim=fp.ALTITUDE, precision=6, third_dim_precision=1)

# ---- pipeline: smooth Z -> TD-TR (3D) -> Flexible Polyline ----
ele_s = smooth(ele)
print(f"raw points {n} | ascent raw {ascent(ele):.0f} m -> smoothed {ascent(ele_s):.0f} m | trail map 1834 m\n")
print(f"{'config':22}{'pts':>7}{'bytes':>9}{'brotli':>8}{'ascent':>9}")
for eps in (1.0, 2.0):
    for method in ("rdp", "tdtr"):
        idx = simplify(eps, ele_s, method, dim=3)
        enc = encode(idx, ele_s).encode()
        br = len(brotli.compress(enc, quality=11))
        asc = ascent([ele_s[i] for i in idx])
        print(f"eps{eps} {method+'-3D':14}{len(idx):>7}{len(enc):>9}{br:>8}{asc:>8.0f}m")
    print()

# the chosen pipeline output
best = encode(simplify(1.0, ele_s, "rdp", dim=3), ele_s)
open("Morning_Hike.flexpolyline", "w").write(best)
print(f"wrote Morning_Hike.flexpolyline  ({len(best)} chars)")
