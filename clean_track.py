"""Survey-aligned cleaning chain (Sun et al. 2025, Electronics 14:4694):
outlier removal [3.1.1] -> Savitzky-Golay smoothing [3.1.3] -> DEM-snap [3.4]
-> Douglas-Peucker / SED-TD-TR simplification [3.2.1]. Run stage by stage."""
import math, os, sys, urllib.request, numpy as np
import rasterio
from pyproj import Transformer
from scipy.signal import savgol_filter
from flex import lat as LAT, lon as LON, ele as ELE
sys.setrecursionlimit(200000)

lat = np.array(LAT, float); lon = np.array(LON, float); ele = np.array(ELE, float)
R = 6371000; lat0 = math.radians(lat.mean())
SCR = os.environ.get("TREK_CACHE", os.path.expanduser("~/.cache/trek"))
os.makedirs(SCR, exist_ok=True)
# Piemonte 5m LIDAR is the only DEM-snap source; outside its bbox we keep smoothed GPS elevation.
def in_piemonte(la, lo): return 44.0 <= la.mean() <= 46.5 and 6.6 <= lo.mean() <= 9.2
BBOX = f"{lat.min():.3f}_{lat.max():.3f}_{lon.min():.3f}_{lon.max():.3f}"  # per-trek cache key

def hav(a1, o1, a2, o2):
    p1, p2 = math.radians(a1), math.radians(a2)
    h = math.sin((p2-p1)/2)**2+math.cos(p1)*math.cos(p2)*math.sin(math.radians(o2-o1)/2)**2
    return 2*R*math.asin(math.sqrt(h))
def dist_km(a, o): return sum(hav(a[i], o[i], a[i+1], o[i+1]) for i in range(len(a)-1))/1000
def ascent(z): return float(np.sum(np.clip(np.diff(z), 0, None)))

# [3.1.1] outlier removal — Hampel (median + MAD), the survey's median-filter family
def hampel(x, win=7, k=3.0):
    x = np.asarray(x, float); out = x.copy(); h = win//2; fixed = 0
    for i in range(len(x)):
        w = x[max(0, i-h):min(len(x), i+h+1)]
        med = np.median(w); mad = 1.4826*np.median(np.abs(w-med))
        if mad > 0 and abs(x[i]-med) > k*mad: out[i] = med; fixed += 1
    return out, fixed

# [3.4] map matching, elevation flavour — snap to 5 m LIDAR DTM
def fetch_dtm(path, a_lo, a_hi, o_lo, o_hi):
    if os.path.exists(path): return
    t = Transformer.from_crs(4326, 32632, always_xy=True)
    cE, cN = t.transform([o_lo, o_hi, o_lo, o_hi], [a_lo, a_lo, a_hi, a_hi])
    xmin, xmax, ymin, ymax = min(cE), max(cE), min(cN), max(cN)
    W, H = int((xmax-xmin)/5), int((ymax-ymin)/5)
    B = "https://geomap.reteunitaria.piemonte.it/ws/taims/rp-01/taimsdtmwcs/wcs_ice_2009_2011_dtm?"
    urllib.request.urlretrieve(B+f"service=WCS&version=1.0.0&request=GetCoverage&coverage=DTM"
        f"&crs=EPSG:32632&bbox={xmin},{ymin},{xmax},{ymax}&width={W}&height={H}&format=GEOTIFF_16", path)
def dem_sample(a, o, path, order):
    # order 0 = nearest (staircase), 1 = bilinear (2x2), 3 = bicubic (4x4 cells)
    from scipy.ndimage import map_coordinates
    with rasterio.open(path) as src:
        dem = src.read(1).astype(float); dem[dem == src.nodata] = np.nan; inv = ~src.transform
    dem = np.nan_to_num(dem, nan=np.nanmin(dem))
    E, N = Transformer.from_crs(4326, 32632, always_xy=True).transform(o, a)
    cols, rows = inv*(np.asarray(E), np.asarray(N))           # fractional indices
    return map_coordinates(dem, [rows, cols], order=order, mode="nearest")

# resample to uniform horizontal distance -> elevation gain stops depending on GPS spacing
def resample_dist(a, o, z, step=10.0):
    d = np.concatenate([[0], np.cumsum([hav(a[i], o[i], a[i+1], o[i+1]) for i in range(len(a)-1)])])
    dd = np.arange(0, d[-1], step)
    return np.interp(dd, d, a), np.interp(dd, d, o), np.interp(dd, d, z)

# cumulative ascent with a deadband: only bank a climb once it clears `thr`
def ascent_thr(z, thr=3.0):
    tot = 0.0; lo = z[0]
    for v in z[1:]:
        if v > lo+thr: tot += v-lo; lo = v
        elif v < lo: lo = v
    return tot

# [3.2.1] line-simplification — RDP (perpendicular) or TD-TR (synchronized/SED), in 3D
def simplify(a, o, z, eps=1.0, method="rdp"):
    X = R*np.radians(o)*math.cos(lat0); Y = R*np.radians(a); n = len(a); keep = set()
    def d(i, s, e):
        ax, ay, az = X[s], Y[s], z[s]; bx, by, bz = X[e], Y[e], z[e]; px, py, pz = X[i], Y[i], z[i]
        if method == "tdtr":
            r = (i-s)/(e-s) if e > s else 0
            qx, qy, qz = ax+r*(bx-ax), ay+r*(by-ay), az+r*(bz-az)
        else:
            dx, dy, dz = bx-ax, by-ay, bz-az; L = dx*dx+dy*dy+dz*dz
            tt = max(0, min(1, ((px-ax)*dx+(py-ay)*dy+(pz-az)*dz)/L)) if L else 0
            qx, qy, qz = ax+tt*dx, ay+tt*dy, az+tt*dz
        return math.dist((px, py, pz), (qx, qy, qz))
    def rec(s, e):
        dm = idx = 0
        for i in range(s+1, e):
            v = d(i, s, e)
            if v > dm: dm, idx = v, i
        if dm > eps: rec(s, idx); rec(idx, e)
        else: keep.update((s, e))
    rec(0, n-1); return sorted(keep)

DTM = f"{SCR}/dtm5_{BBOX}.tif"

# canonical front-end: returns the cleaned track ready for geometry/RDP.
# Hampel despike -> Savitzky-Golay on position -> bicubic 5m-LIDAR elevation (Piemonte only).
def clean_track():
    la, _ = hampel(lat); lo, _ = hampel(lon)
    la = savgol_filter(la, 15, 2); lo = savgol_filter(lo, 15, 2)
    if in_piemonte(lat, lon):
        fetch_dtm(DTM, lat.min()-0.003, lat.max()+0.003, lon.min()-0.003, lon.max()+0.003)
        z = dem_sample(la, lo, DTM, 3)        # bicubic -> clean per-point elevation
    else:
        z = savgol_filter(np.array(ELE, float), 61, 2)  # outside Piemonte: smoothed GPS elevation
    return la, lo, z

# canonical elevation gain: scale-fixed (resample by distance) + deadband threshold.
# This is the reported number — NOT a naive sum of the per-point series.
def elevation_gain(la, lo, z, step=5.0, thr=3.0):
    _, _, rz = resample_dist(la, lo, z, step)
    return ascent_thr(rz, thr)

def _report():
    def row(tag, a, o, z, note=""):
        print(f"{tag:30} pts {len(a):6d}   ascent {ascent(z):6.0f} m   dist {dist_km(a,o):6.2f} km   {note}")
    print("stage-by-stage cleaning  (Strava ascent: 1871 m)\n")
    row("0  raw", lat, lon, ele)
    la, fa = hampel(lat); lo, fo = hampel(lon); zz, fz = hampel(ele)
    row("1  Hampel despike", la, lo, zz, f"(fixed {fa}+{fo} pos, {fz} ele spikes)")
    la = savgol_filter(la, 15, 2); lo = savgol_filter(lo, 15, 2); zz = savgol_filter(zz, 61, 2)
    row("2  Savitzky-Golay", la, lo, zz, "(pos 15s, ele 61s)")
    fetch_dtm(DTM, lat.min()-0.003, lat.max()+0.003, lon.min()-0.003, lon.max()+0.003)
    row("3  DEM nearest (staircase)", la, lo, dem_sample(la, lo, DTM, 0))
    row("3  DEM bilinear (2x2)", la, lo, dem_sample(la, lo, DTM, 1))
    zz = dem_sample(la, lo, DTM, 3); row("3  DEM bicubic (4x4)", la, lo, zz, "<- clean per-point z")
    print("\n  elevation gain (scale-fixed) — bicubic DEM, resampled by distance:")
    for step in (5, 10, 20):
        _, _, rz = resample_dist(la, lo, zz, step)
        print(f"    resample {step:2d} m: raw {ascent(rz):5.0f} | +3m {ascent_thr(rz,3):5.0f} | +5m {ascent_thr(rz,5):5.0f} m")
    la2, lo2, z2 = clean_track()
    print(f"\n  canonical elevation_gain() = {elevation_gain(la2,lo2,z2):.0f} m (resample 5m, 3m deadband)")
    for m in ("rdp", "tdtr"):
        idx = simplify(la2, lo2, z2, 1.0, m)
        row(f"4  simplify {m.upper()} @1m", la2[idx], lo2[idx], z2[idx])

if __name__ == "__main__":
    _report()
