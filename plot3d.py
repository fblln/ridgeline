import re, math, numpy as np
import matplotlib; matplotlib.use("Agg")
import matplotlib.pyplot as plt
from mpl_toolkits.mplot3d.art3d import Line3DCollection
import srtm
from flex import lat, lon, ele, smooth, simplify  # reuse pipeline

lat0 = math.radians(sum(lat)/len(lat)); R = 6371000
to_m = lambda la, lo: (R*math.radians(lo)*math.cos(lat0), R*math.radians(la))
x0 = R*math.radians(min(lon))*math.cos(lat0); y0 = R*math.radians(min(lat))

ele_s = smooth(ele)
Xa = np.array([to_m(a, o)[0]-x0 for a, o in zip(lat, lon)])
Ya = np.array([to_m(a, o)[1]-y0 for a, o in zip(lat, lon)])
Za = np.array(ele_s)

# RDP-simplified 3D polyline (the thing we encode)
idx = simplify(1.0, ele_s, "rdp", dim=3)
px, py, pz = Xa[idx], Ya[idx], Za[idx]

# real topo basemap: SRTM 30m DEM over the track bbox + ~600m margin
from scipy.ndimage import zoom as ndzoom
dem = srtm.get_data()
mlat = 0.006; mlon = 0.008
glat0 = np.linspace(min(lat)-mlat, max(lat)+mlat, 200)
glon0 = np.linspace(min(lon)-mlon, max(lon)+mlon, 200)
gz0 = np.array([[dem.get_elevation(a, o) or np.nan for o in glon0] for a in glat0])
zlo, zhi = np.nanmin(gz0), np.nanmax(gz0)
# upsample geometry (smooth bilinear) so the sharper z16 tiles keep their detail
F = 5
gzf = ndzoom(np.nan_to_num(gz0, nan=zlo), F, order=1)
glat = np.linspace(glat0[0], glat0[-1], gzf.shape[0])
glon = np.linspace(glon0[0], glon0[-1], gzf.shape[1])
LO, LA = np.meshgrid(glon, glat)
gx = R*np.radians(LO)*math.cos(lat0) - x0
gy = R*np.radians(LA) - y0
floor = zlo - 30

fig = plt.figure(figsize=(13, 10))
ax = fig.add_subplot(111, projection="3d")

from matplotlib.colors import LightSource

# --- OpenTopoMap tiles draped on the terrain (cached to scratchpad) ---
import os, time, urllib.request
from PIL import Image
CACHE = "/private/tmp/claude-501/-Users-fabio-Workspace-strava/dbc53142-5e1e-4343-8980-7dc43383ae7e/scratchpad/otm"
os.makedirs(CACHE, exist_ok=True)
Z = 16
def deg2num(la, lo):
    n = 2**Z; latr = math.radians(la)
    return (lo+180)/360*n, (1-math.asinh(math.tan(latr))/math.pi)/2*n
def tile(tx, ty):
    p = f"{CACHE}/{Z}_{tx}_{ty}.png"
    if not os.path.exists(p):
        req = urllib.request.Request(f"https://tile.opentopomap.org/{Z}/{tx}/{ty}.png",
            headers={"User-Agent": "hike-3d-viz/1.0 (personal one-off; ellenafabio@gmail.com)"})
        for attempt in range(4):          # polite: retry with backoff on throttle
            try:
                open(p, "wb").write(urllib.request.urlopen(req, timeout=30).read()); break
            except Exception as e:
                if attempt == 3: raise
                time.sleep(2*(attempt+1))
        time.sleep(0.2)                   # rate-limit: ~5 req/s, only on cache miss
    return Image.open(p).convert("RGB")

xf0, yf0 = deg2num(max(glat), min(glon))   # NW corner -> smallest tile x,y
xf1, yf1 = deg2num(min(glat), max(glon))   # SE corner
tx0, tx1 = int(xf0), int(xf1); ty0, ty1 = int(yf0), int(yf1)
mosaic = Image.new("RGB", ((tx1-tx0+1)*256, (ty1-ty0+1)*256))
for tx in range(tx0, tx1+1):
    for ty in range(ty0, ty1+1):
        mosaic.paste(tile(tx, ty), ((tx-tx0)*256, (ty-ty0)*256))
osm = np.asarray(mosaic)
print(f"OSM zoom{Z}: {(tx1-tx0+1)*(ty1-ty0+1)} tiles")

# sample the mosaic at every grid point -> texture (rows, cols, 3) in [0,1]
# vectorized: tile x depends only on lon, tile y only on lat (web mercator)
H, W = osm.shape[:2]; n = 2**Z
xf = (glon+180)/360*n
yf = (1-np.arcsinh(np.tan(np.radians(glat)))/math.pi)/2*n
pxc = np.clip(((xf-tx0)*256).astype(int), 0, W-1)
pyr = np.clip(((yf-ty0)*256).astype(int), 0, H-1)
tex = osm[pyr[:, None], pxc[None, :]] / 255.0

# drape the OSM colors over the terrain with hillshade relief
ls = LightSource(azdeg=315, altdeg=45)
rgb = ls.shade_rgb(tex, gzf, vert_exag=2.5, blend_mode="soft",
                   dx=abs(gx[0,1]-gx[0,0]), dy=abs(gy[1,0]-gy[0,0]))
rgb = np.dstack([rgb, np.full(gzf.shape, 0.9)])   # alpha so route shows through (no z-buffer)
ax.plot_surface(gx, gy, gzf, facecolors=rgb, linewidth=0, antialiased=True,
                rcount=len(glat), ccount=len(glon), shade=False, zorder=1)

# the route, bold red (Outdooractive style), lifted above the surface
seg = np.array([np.c_[px, py, pz+25][:-1], np.c_[px, py, pz+25][1:]]).transpose(1, 0, 2)
ax.add_collection3d(Line3DCollection(seg, colors="white", lw=5.2, zorder=5))      # casing
ax.add_collection3d(Line3DCollection(seg, colors="#e3000f", lw=3.0, zorder=6))    # route

top = max(zhi, Za.max())
ax.set_box_aspect((gx.max()-gx.min(), gy.max()-gy.min(), (top-floor)*2.5))  # 2.5x vert. exag
ax.set_zlim(floor, top)
ax.set_xlim(gx.min(), gx.max()); ax.set_ylim(gy.min(), gy.max())
ax.set_xlabel("E (m)"); ax.set_ylabel("N (m)"); ax.set_zlabel("elevation (m)")
ax.view_init(elev=24, azim=-88)   # angled to look into the valley
ax.set_title(f"Morning Hike — RDP@1m polyline ({len(idx)} pts) on OpenTopoMap + SRTM 30m terrain\n"
             f"track {Za.min():.0f}–{Za.max():.0f} m · 1839 m gain · 2.5× vert. exag · map data © OpenStreetMap, © OpenTopoMap (CC-BY-SA)",
             fontsize=10)
fig.tight_layout()
fig.savefig("Morning_Hike-3d.png", dpi=240)
print(f"wrote Morning_Hike-3d.png | polyline {len(idx)} pts | z {Za.min():.0f}-{Za.max():.0f}m")
