import os, math, json, urllib.request, urllib.parse, numpy as np
from PIL import Image, ImageEnhance
import pyvista as pv
import rasterio
from pyproj import Transformer
from scipy.ndimage import gaussian_filter
from clean_track import clean_track, elevation_gain, simplify, in_piemonte, BBOX

VE = 2.5  # vertical exaggeration
STYLE = os.environ.get("STYLE", "texture")   # texture | hillshade
ZOOMF = float(os.environ.get("ZOOM", "1.0"))    # 1 = whole track fills frame; small DEM skirt via MARGIN
FX = os.environ.get("FX")  # focal point 0..1 W->E; default = route centroid (set below)
FY = os.environ.get("FY")  # focal point 0..1 S->N; default = route centroid (set below)
EL = float(os.environ.get("EL", "34"))       # camera inclination (deg above horizontal)
AZ = float(os.environ.get("AZ", "12"))       # camera azimuth (deg); +90 rotates view a quarter turn
SEAMAXIS = os.environ.get("SEAMAXIS", "lon")  # blend seam runs along 'lon' (N-S) or 'lat' (E-W)
# canonical cleaned track: Hampel -> SavGol position -> bicubic 5m-LIDAR elevation
lat, lon, ele = clean_track()
GAIN = elevation_gain(lat, lon, ele)   # scale-fixed reported gain (~1869 m)
lat0 = math.radians(lat.mean()); R = 6371000
x0 = R*math.radians(lon.min())*math.cos(lat0); y0 = R*math.radians(lat.min())
to_x = lambda lo: R*math.radians(lo)*math.cos(lat0) - x0
to_y = lambda la: R*math.radians(la) - y0

idx = simplify(lat, lon, ele, 1.0, "rdp")
px = np.array([to_x(lon[i]) for i in idx]); py = np.array([to_y(lat[i]) for i in idx])
pz = np.array([ele[i] for i in idx])

# DEM source switch:  DEM=lidar (Piemonte 5m) | DEM=srtm (global 30m) | DEM=blend
# default auto-picks: LIDAR inside Piemonte, global SRTM everywhere else.
SRC = os.environ.get("DEM") or ("lidar" if in_piemonte(lat, lon) else "srtm")
mlat, mlon = float(os.environ.get("MARGIN", "0.0025")), float(os.environ.get("MARGIN", "0.0025"))  # DEM skirt around the track
BTAG = f"{BBOX}_m{mlat:.4f}"   # cache key: track bbox + margin (content depends on both)
la_lo, la_hi = min(lat)-mlat, max(lat)+mlat
lo_lo, lo_hi = min(lon)-mlon, max(lon)+mlon
SCR = os.environ.get("TREK_CACHE", os.path.expanduser("~/.cache/trek"))
os.makedirs(SCR, exist_ok=True)
to_utm = Transformer.from_crs(4326, 32632, always_xy=True)

# common mesh (master frame for texture + route) — identical for both DEMs.
# MESH=1200 ≈ 5 m cells here (matches the source DEMs); raise for detail, lower for speed.
N = int(os.environ.get("MESH", "1200"))
glat = np.linspace(la_lo, la_hi, N); glon = np.linspace(lo_lo, lo_hi, N)
LO, LA = np.meshgrid(glon, glat)
GX = R*np.radians(LO)*math.cos(lat0) - x0
GY = R*np.radians(LA) - y0

def build_srtm():   # global 30m, cubic-interpolated + smoothed -> honest coarse blobs
    cache = f"{SCR}/srtm_gz_{BTAG}_{N}.npy"
    if os.path.exists(cache):
        return np.load(cache)
    import srtm
    from scipy.interpolate import RegularGridInterpolator
    dem0 = srtm.get_data(); cg = 130
    cglat = np.linspace(la_lo, la_hi, cg); cglon = np.linspace(lo_lo, lo_hi, cg)
    gzc = np.array([[dem0.get_elevation(a, o) or np.nan for o in cglon] for a in cglat])
    gzc = np.nan_to_num(gzc, nan=np.nanmin(gzc[~np.isnan(gzc)]))
    f = RegularGridInterpolator((cglat, cglon), gzc, method="cubic", bounds_error=False, fill_value=None)
    gz = gaussian_filter(f(np.c_[LA.ravel(), LO.ravel()]).reshape(LO.shape), sigma=4.0)
    np.save(cache, gz); return gz

def build_lidar():  # Piemonte 5m via WCS (cached) -> full gully detail
    dtm_path = f"{SCR}/dtm5_{BTAG}.tif"
    cE, cN = to_utm.transform([lo_lo, lo_hi, lo_lo, lo_hi], [la_lo, la_lo, la_hi, la_hi])
    xmin, xmax, ymin, ymax = min(cE), max(cE), min(cN), max(cN)
    if not os.path.exists(dtm_path):
        W = int((xmax-xmin)/5); H = int((ymax-ymin)/5)
        B = "https://geomap.reteunitaria.piemonte.it/ws/taims/rp-01/taimsdtmwcs/wcs_ice_2009_2011_dtm?"
        urllib.request.urlretrieve(B+"service=WCS&version=1.0.0&request=GetCoverage&coverage=DTM"
            f"&crs=EPSG:32632&bbox={xmin},{ymin},{xmax},{ymax}&width={W}&height={H}&format=GEOTIFF_16", dtm_path)
    with rasterio.open(dtm_path) as src:
        dem = src.read(1).astype(float); dem[dem == src.nodata] = np.nan; inv = ~src.transform
    E, Nn = to_utm.transform(LO, LA)
    cols, rows = inv * (E.ravel(), Nn.ravel())
    rows = np.clip(rows.astype(int), 0, dem.shape[0]-1); cols = np.clip(cols.astype(int), 0, dem.shape[1]-1)
    g = dem[rows, cols].reshape(LO.shape)        # NaN where Piemonte LiDAR has no coverage (e.g. France)
    hole = np.isnan(g)
    if hole.any():
        g[hole] = fill_ign(LO[hole], LA[hole])   # patch cross-border gaps with IGN France LiDAR/RGE ALTI
    return gaussian_filter(np.nan_to_num(g, nan=np.nanmin(g)), sigma=1.0)

def load_border():  # national border (admin_level=2) within the bbox, as lon/lat polylines, cached GeoJSON
    path = os.environ.get("BORDER_GEOJSON") or f"{SCR}/border_{BTAG}.geojson"
    if not os.path.exists(path):
        q = (f'[out:json][timeout:25];way["boundary"="administrative"]["admin_level"="2"]'
             f'({la_lo},{lo_lo},{la_hi},{lo_hi});out geom;')
        req = urllib.request.Request("https://overpass-api.de/api/interpreter",
                                     data=urllib.parse.urlencode({"data": q}).encode(),
                                     headers={"User-Agent": "trek-sandbox/1.0"})
        try:
            ways = json.load(urllib.request.urlopen(req, timeout=60))["elements"]
        except Exception as ex:
            print("  border fetch failed:", ex); return []
        feats = [{"type": "Feature", "properties": {"id": w["id"]}, "geometry": {"type": "LineString",
                  "coordinates": [[p["lon"], p["lat"]] for p in w["geometry"]]}}
                 for w in ways if w["type"] == "way" and w.get("geometry")]
        json.dump({"type": "FeatureCollection", "features": feats}, open(path, "w"))
    lines = []
    for f in json.load(open(path))["features"]:
        g = f["geometry"]
        segs = g["coordinates"] if g["type"] == "MultiLineString" else [g["coordinates"]]
        lines += [np.array(s) for s in segs if len(s) > 1]
    return lines

def fill_ign(lons, lats):  # IGN LiDAR HD (ELEVATION.HIGHRES) via one WMS BIL-float32 request, bicubic-sampled
    cache = f"{SCR}/ignhd_{BTAG}_{N}.npy"
    if os.path.exists(cache):
        return np.load(cache)
    from scipy.ndimage import map_coordinates
    wm = (lo_hi-lo_lo)*111320*math.cos(math.radians((la_lo+la_hi)/2)); hm = (la_hi-la_lo)*111320
    W = min(2048, max(256, int(wm/2))); H = min(2048, max(256, int(hm/2)))   # ~2-3 m/px, server-capped
    q = {"SERVICE": "WMS", "VERSION": "1.3.0", "REQUEST": "GetMap", "STYLES": "",
         "LAYERS": "ELEVATION.ELEVATIONGRIDCOVERAGE.HIGHRES", "CRS": "CRS:84",
         "BBOX": f"{lo_lo},{la_lo},{lo_hi},{la_hi}", "WIDTH": W, "HEIGHT": H, "FORMAT": "image/x-bil;bits=32"}
    b = urllib.request.urlopen("https://data.geopf.fr/wms-r/wms?"+urllib.parse.urlencode(q), timeout=90).read()
    dem = np.frombuffer(b, "<f4").reshape(H, W).astype(float); dem[dem < -1000] = np.nan
    dem = np.nan_to_num(dem, nan=np.nanmin(dem[~np.isnan(dem)]))   # north-up raster over the full bbox
    c = (lons-lo_lo)/(lo_hi-lo_lo)*(W-1); r = (la_hi-lats)/(la_hi-la_lo)*(H-1)
    out = map_coordinates(dem, [r, c], order=3, mode="nearest")     # bicubic, like the Italian DTM
    np.save(cache, out)
    return out

seam_pts = None
if SRC == "srtm":
    gz = build_srtm()
elif SRC == "blend":   # ONE surface: SRTM (west) morphing into LiDAR (east) across a seam
    SEAM = float(os.environ.get("SEAM", "0.5"))
    SEAMANG = math.radians(float(os.environ.get("SEAMANG", "0")))  # 0=N-S seam, 90=E-W, any angle
    gz_s, gz_l = build_srtm(), build_lidar()
    ulon = (LO - lo_lo)/(lo_hi - lo_lo); ulat = (LA - la_lo)/(la_hi - la_lo)
    u = math.cos(SEAMANG)*ulon + math.sin(SEAMANG)*ulat        # project onto seam normal
    u = (u - u.min())/(u.max() - u.min())
    w = (u >= SEAM).astype(float)                              # HARD edge: 0 -> SRTM, 1 -> LiDAR
    gz = gz_s*(1-w) + gz_l*w
    # explicit separation line: surface points along the w boundary, ordered along the seam
    edge = np.zeros_like(w, bool)
    edge[:, :-1] |= w[:, :-1] != w[:, 1:]; edge[:-1, :] |= w[:-1, :] != w[1:, :]
    ei = np.where(edge)
    along = -math.sin(SEAMANG)*ulon[ei] + math.cos(SEAMANG)*ulat[ei]
    o = np.argsort(along)
    seam_pts = np.c_[GX[ei][o], GY[ei][o], np.maximum(gz_s, gz_l)[ei][o]*VE]
else:
    gz = build_lidar()

grid = pv.StructuredGrid(GX, GY, gz*VE)
# default focal point = route centroid, so zoom frames the track (not the DEM middle)
fx = float(FX) if FX is not None else (px.mean()-GX.min())/(GX.max()-GX.min())
fy = float(FY) if FY is not None else (py.mean()-GY.min())/(GY.max()-GY.min())
cx = GX.min() + fx*(GX.max()-GX.min())
cy = GY.min() + fy*(GY.max()-GY.min())
cz = gz[int(fy*(N-1)), int(fx*(N-1))]*VE   # look at the local surface, not global mid
span = max(GX.max()-GX.min(), GY.max()-GY.min())
RES = int(os.environ.get("RES", "2400"))   # output width px (final renders bump this for fidelity)
pl = pv.Plotter(off_screen=True, window_size=(RES, int(RES*0.75)), lighting="none")

if STYLE == "texture":
    pl.set_background("#bcd6ef", top="#5a86c5")   # sky gradient
    CACHE = f"{SCR}/otm"; os.makedirs(CACHE, exist_ok=True)
    Z = int(os.environ.get("TILEZOOM", "17"))   # OTM detail; 17 = max, sharper map (4x tiles vs 16)
    def deg2num(la, lo):
        n = 2**Z; return (lo+180)/360*n, (1-math.asinh(math.tan(math.radians(la)))/math.pi)/2*n
    def tile(tx, ty):   # OpenTopoMap tile, cached to disk (lifted from plot3d.py)
        p = f"{CACHE}/{Z}_{tx}_{ty}.png"
        if not os.path.exists(p):
            req = urllib.request.Request(f"https://tile.opentopomap.org/{Z}/{tx}/{ty}.png",
                                         headers={"User-Agent": "trek-sandbox/1.0"})
            with urllib.request.urlopen(req) as r, open(p, "wb") as f: f.write(r.read())
        return Image.open(p).convert("RGB")
    xfw, yfn = deg2num(la_hi, lo_lo); xfe, yfs = deg2num(la_lo, lo_hi)
    tx0, tx1, ty0, ty1 = int(xfw), int(xfe), int(yfn), int(yfs)
    mosaic = Image.new("RGB", ((tx1-tx0+1)*256, (ty1-ty0+1)*256))
    for tx in range(tx0, tx1+1):
        for ty in range(ty0, ty1+1):
            mosaic.paste(tile(tx, ty), ((tx-tx0)*256, (ty-ty0)*256))
    crop = (int((xfw-tx0)*256), int((yfn-ty0)*256), int((xfe-tx0)*256), int((yfs-ty0)*256))
    cimg = mosaic.crop(crop)
    cimg = ImageEnhance.Color(cimg).enhance(float(os.environ.get("SAT", "1.45")))      # richer colors
    cimg = ImageEnhance.Brightness(cimg).enhance(float(os.environ.get("BRIGHT", "0.82")))  # less bright
    cimg = ImageEnhance.Contrast(cimg).enhance(float(os.environ.get("CONTRAST", "1.15")))   # more depth
    texture = pv.Texture(np.ascontiguousarray(np.asarray(cimg))); texture.interpolate = True
    grid.texture_map_to_plane(origin=(GX.min(), GY.min(), 0), point_u=(GX.max(), GY.min(), 0),
                              point_v=(GX.min(), GY.max(), 0), inplace=True)
    pl.add_light(pv.Light(position=(GX.min()-span, GY.max()+span, gz.max()*VE*3),
                          focal_point=(cx, cy, 0), color="white", intensity=0.85))
    pl.add_light(pv.Light(light_type="headlight", intensity=0.18))
    pl.add_mesh(grid, texture=texture, smooth_shading=True, ambient=0.32, diffuse=0.8, specular=0.0)
else:  # hillshade: bare relief, low grazing sun, uniform light color -> pure geometry, gullies pop
    pl.set_background("#eef2f6", top="#d2dce6")
    pl.add_light(pv.Light(position=(GX.min()-span*0.5, GY.max()+span*0.5, gz.max()*VE*0.8),
                          focal_point=(cx, cy, 0), color="white", intensity=1.2))  # low, grazing
    pl.add_light(pv.Light(light_type="headlight", intensity=0.12))
    pl.add_mesh(grid, color="#cdc7b6", smooth_shading=True, ambient=0.33, diffuse=0.92, specular=0.02)

# route draped ONTO the rendered surface (sample the DEM at each point), not at the
# raw GPS elevation -> never sinks into the coarse/smoothed terrain. Lift keeps it clear.
from scipy.interpolate import RegularGridInterpolator
rgi = RegularGridInterpolator((GY[:, 0], GX[0, :]), gz, bounds_error=False, fill_value=None)
route_z = rgi(np.c_[py, px])*VE + 14   # lift ≈ tube radius -> rests on the ground
route = pv.lines_from_points(np.c_[px, py, route_z])
pl.add_mesh(route.tube(radius=15), color="#e3000f", lighting=False)  # vivid unlit route, no casing

if seam_pts is not None and len(seam_pts) > 1:   # hard SRTM|LiDAR separation line
    sp = seam_pts.copy(); sp[:, 2] += 22
    pl.add_mesh(pv.lines_from_points(sp).tube(radius=14), color="#ffe000", lighting=False)

for arr in load_border():   # national border from GeoJSON, draped on the surface, in yellow
    lon, la = arr[:, 0], arr[:, 1]
    m = (lon >= lo_lo) & (lon <= lo_hi) & (la >= la_lo) & (la <= la_hi)
    if not m.any():
        continue
    ins = np.where(m)[0]
    for run in np.split(ins, np.where(np.diff(ins) > 1)[0]+1):   # contiguous in-bbox runs only
        if len(run) < 2:
            continue
        bx = R*np.radians(lon[run])*math.cos(lat0) - x0; by = R*np.radians(la[run]) - y0
        bz = rgi(np.c_[by, bx])*VE + 20
        pl.add_mesh(pv.lines_from_points(np.c_[bx, by, bz]).tube(radius=13), color="#1f6bff", lighting=False)

# --- heuristic "good shot" azimuth: look ACROSS the track's long axis (route spreads widest),
# from the LOWER side (open ground -> mountain rises behind the track, never occludes it) ---
_e, _v = np.linalg.eigh(np.cov(np.vstack([px-px.mean(), py-py.mean()])))
_axis = _v[:, int(np.argmax(_e))]; _perp = np.array([-_axis[1], _axis[0]])   # ⟂ to long axis
_cxr, _cyr = px.mean(), py.mean()
_h = lambda s: rgi([[_cyr+s*_perp[1]*span*0.35, _cxr+s*_perp[0]*span*0.35]])[0]
_s = -1 if _h(-1) < _h(1) else 1                     # camera on the lower-terrain (open) side
_u = _s*_perp                                        # focal->camera horizontal direction
AZ_BEST = math.degrees(math.atan2(_u[0], -_u[1]))    # in the shoot() az convention

pl.enable_anti_aliasing("ssaa")   # supersample: kills jaggies (CalTopo-grade edges)
pl.enable_ssao(radius=80)         # ambient occlusion -> depth in gullies/valleys

# 3/4 view, inclination/azimuth controllable for rotating the scene
dist = 1.9*span
BASE_VA = pl.camera.view_angle   # reset before each zoom so ZOOMF is absolute, not cumulative
ROUTE_BOUNDS = (px.min(), px.max(), py.min(), py.max(), route_z.min(), route_z.max())  # frame the WHOLE track
def shoot(az, el, outfile, text=True):
    elev_a, az_a = math.radians(el), math.radians(az)
    pos = (cx + dist*math.cos(elev_a)*math.sin(az_a),
           cy - dist*math.cos(elev_a)*math.cos(az_a),
           cz + dist*math.sin(elev_a))
    pl.camera_position = [pos, (cx, cy, cz), (0, 0, 1)]   # set view DIRECTION (az/el)
    pl.camera.view_angle = BASE_VA
    pl.reset_camera(bounds=ROUTE_BOUNDS)   # keep direction, fit the whole route in frame
    pl.camera.zoom(ZOOMF)                  # ZOOMF<1 leaves margin/context around the track
    if text and STYLE == "texture" and not os.environ.get("NOTEXT"):
        demlabel = "LiDAR ICE 2009–2011 DTM · 5 m" if SRC == "lidar" else "NASA SRTM 30m"
        pl.add_text(f"{os.path.splitext(os.path.basename(os.environ.get('GPX','Morning_Hike.gpx')))[0]}"
                    f" — cleaned RDP@1m route ({len(idx)} pts) · {GAIN:.0f} m gain\n"
                    f"OpenTopoMap z{os.environ.get('TILEZOOM','17')} + {demlabel} · bicubic drape · 2.5x vert. exag",
                    position="upper_left", font_size=10, color="black", name="caption")
    pl.render()   # SSAA caches the frame; force a re-render after moving the camera
    pl.screenshot(outfile)

# grid mode (OUTDIR set): render a sheet reusing one scene + write angles.json manifest.
# Default = heuristic spread around AZ_BEST; override with explicit AZ_GRID/EL_GRID env.
if os.environ.get("OUTDIR"):
    import json
    OUTDIR = os.environ["OUTDIR"]
    azs = [float(a) for a in os.environ.get("AZ_GRID", "").split(",") if a] or \
          [AZ_BEST+d for d in (-45, -15, 15, 45)]            # all good 3/4 angles, just nuanced
    els = [float(e) for e in os.environ.get("EL_GRID", "").split(",") if e] or [38, 46, 54, 62]
    combos = [(az, el) for el in els for az in azs]          # row = elevation, col = azimuth
    manifest = []
    for n, (az, el) in enumerate(combos):
        shoot(az, el, f"{OUTDIR}/a{n}.png", text=False)
        manifest.append({"az": round(az, 1), "el": el})
    json.dump(manifest, open(f"{OUTDIR}/angles.json", "w"))
    print(f"wrote {len(combos)} thumbs to {OUTDIR} | AZ_BEST={AZ_BEST:.0f} DEM={SRC} STYLE={STYLE}")
else:
    srctag = {"lidar": "", "srtm": "-srtm", "blend": "-blend"}[SRC]
    outfile = os.environ.get("OUT", f"Morning_Hike-3d-pv{srctag}{'' if STYLE == 'texture' else '-hs'}.png")
    shoot(AZ, EL, outfile)
    print(f"wrote {outfile} | DEM={SRC} STYLE={STYLE} | {len(idx)} pts")
