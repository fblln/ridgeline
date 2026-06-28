#!/usr/bin/env python3
"""Export a GPX trek into static assets for the web viewer.

The viewer consumes this generated heightfield, route, texture, and manifest
package directly; no Python runs in the browser.
"""

import concurrent.futures
import json
import math
import os
import shutil
import sys
import time
import urllib.parse
import urllib.request
from pathlib import Path

import numpy as np
import rasterio
from contourpy import contour_generator
from PIL import Image, ImageDraw, ImageEnhance
from pyproj import Transformer
from scipy.ndimage import gaussian_filter, map_coordinates
from scipy.signal import savgol_filter

from . import otel_worker as otel
from .gpx import ascent_deadband, cumulative_distance, parse_gpx, route_title_from_stem, simplify_by_distance, slugify

R = 6371000.0
DEFAULT_CACHE = Path(os.environ.get("TREK_CACHE", Path.home() / ".cache" / "trek"))


def progress(pct: int, label: str):
    """Structured progress line the import server parses into a headline step."""
    print(f"progress:{pct} {label}", flush=True)


FETCH_WORKERS = max(1, int(os.environ.get("WEB_FETCH_WORKERS", "16")))


def download(url, dest=None, headers=None, timeout=60, retries=3):
    """Fetch a URL with small retries. Transient DNS/connection blips are common
    once many fetches run in parallel, and one must not abort the whole build.
    Returns bytes, or writes to dest and returns the path."""
    request = urllib.request.Request(url, headers=headers) if headers else url
    last_error = None
    for attempt in range(retries):
        try:
            data = urllib.request.urlopen(request, timeout=timeout).read()
            if dest is not None:
                Path(dest).write_bytes(data)
                return dest
            return data
        except Exception as exc:  # network/DNS/HTTP — retry with light backoff
            last_error = exc
            time.sleep(0.4 * (attempt + 1))
    raise last_error


def parallel_map(fn, items, label=None):
    """Run fn over items across a thread pool (I/O-bound tile/DEM fetches).

    With `label`, each task runs inside a named span (e.g. 'topo-tile') so the
    workers are individually monitorable in Jaeger instead of anonymous 'GET's.
    otel.context_binder() carries the active span into each worker thread, so the
    named spans (and their HTTP children) still nest under the build trace.
    """
    items = list(items)
    call = (lambda item: otel.run_in_span(label, fn, item)) if label else fn
    if FETCH_WORKERS <= 1 or len(items) <= 1:
        return [call(item) for item in items]
    bound = otel.context_binder()(call)
    results = [None] * len(items)
    with concurrent.futures.ThreadPoolExecutor(max_workers=FETCH_WORKERS) as pool:
        future_to_index = {pool.submit(bound, item): i for i, item in enumerate(items)}
        for future in concurrent.futures.as_completed(future_to_index):
            results[future_to_index[future]] = future.result()
    return results


def fetch_ign_grid(lo_lo, lo_hi, la_lo, la_hi, cache_key):
    target_res_m = float(os.environ.get("WEB_DEM_RES_M", "1.0"))
    max_request = int(os.environ.get("WEB_WMS_MAX", "5010"))
    wm = (lo_hi - lo_lo) * 111320 * math.cos(math.radians((la_lo + la_hi) / 2))
    hm = (la_hi - la_lo) * 111320
    width = max(256, int(math.ceil(wm / target_res_m)))
    height = max(256, int(math.ceil(hm / target_res_m)))
    cache = DEFAULT_CACHE / f"web_ignhd_{cache_key}_{target_res_m:.2f}m_{width}x{height}.npy"
    if cache.exists():
        return np.load(cache)

    dem = np.empty((height, width), dtype=np.float32)
    tiles = [
        (x0, min(width, x0 + max_request), y0, min(height, y0 + max_request))
        for y0 in range(0, height, max_request)
        for x0 in range(0, width, max_request)
    ]

    def fetch_tile(box):
        x0, x1, y0, y1 = box
        q = {
            "SERVICE": "WMS",
            "VERSION": "1.3.0",
            "REQUEST": "GetMap",
            "STYLES": "",
            "LAYERS": "ELEVATION.ELEVATIONGRIDCOVERAGE.HIGHRES",
            "CRS": "CRS:84",
            "BBOX": f"{lo_lo + (lo_hi - lo_lo) * (x0 / width)},{la_hi - (la_hi - la_lo) * (y1 / height)},"
            f"{lo_lo + (lo_hi - lo_lo) * (x1 / width)},{la_hi - (la_hi - la_lo) * (y0 / height)}",
            "WIDTH": x1 - x0,
            "HEIGHT": y1 - y0,
            "FORMAT": "image/x-bil;bits=32",
        }
        url = "https://data.geopf.fr/wms-r/wms?" + urllib.parse.urlencode(q)
        data = download(url, timeout=120)
        return box, np.frombuffer(data, "<f4").reshape(y1 - y0, x1 - x0).astype(np.float32)

    for (x0, x1, y0, y1), tile in parallel_map(fetch_tile, tiles, label="dem-tile"):
        dem[y0:y1, x0:x1] = tile
    dem[dem < -1000] = np.nan
    valid = dem[~np.isnan(dem)]
    # No IGN coverage here (e.g. Piemonte interior, away from the France border):
    # leave the grid all-NaN so it acts as an empty fill rather than crashing.
    if valid.size:
        dem = np.nan_to_num(dem, nan=float(valid.min()))
        print(f"  ign: {valid.size}/{dem.size} cells covered")
    else:
        print("  ign: no coverage for this area (Piemonte DTM only)")
    np.save(cache, dem)
    return dem


def fetch_piemonte_dtm(lo_lo, lo_hi, la_lo, la_hi, cache_key):
    path = DEFAULT_CACHE / f"dtm5_{cache_key}.tif"
    to_utm = Transformer.from_crs(4326, 32632, always_xy=True)
    c_e, c_n = to_utm.transform([lo_lo, lo_hi, lo_lo, lo_hi], [la_lo, la_lo, la_hi, la_hi])
    xmin, xmax, ymin, ymax = min(c_e), max(c_e), min(c_n), max(c_n)
    if not path.exists():
        width = max(1, int((xmax - xmin) / 5))
        height = max(1, int((ymax - ymin) / 5))
        base = "https://geomap.reteunitaria.piemonte.it/ws/taims/rp-01/taimsdtmwcs/wcs_ice_2009_2011_dtm?"
        url = (
            base
            + "service=WCS&version=1.0.0&request=GetCoverage&coverage=DTM"
            + f"&crs=EPSG:32632&bbox={xmin},{ymin},{xmax},{ymax}"
            + f"&width={width}&height={height}&format=GEOTIFF_16"
        )
        download(url, dest=path, timeout=180)
    with rasterio.open(path) as src:
        dem = src.read(1).astype(np.float32)
        if src.nodata is not None:
            dem[dem == src.nodata] = np.nan
        inv = ~src.transform
    return {"dem": dem, "inv": inv, "to_utm": to_utm, "path": path.name}


def sample_piemonte(lon, lat, piemonte_source):
    lon_arr = np.asarray(lon)
    lat_arr = np.asarray(lat)
    shape = lon_arr.shape
    east, north = piemonte_source["to_utm"].transform(lon_arr.ravel(), lat_arr.ravel())
    cols, rows = piemonte_source["inv"] * (east, north)
    dem = piemonte_source["dem"]
    order = int(os.environ.get("WEB_PIEMONTE_SAMPLE_ORDER", "1"))
    values = map_coordinates(dem, [rows, cols], order=order, mode="nearest")
    return values.reshape(shape)


def sample_ign(lon, lat, lo_lo, lo_hi, la_lo, la_hi, source_dem):
    height, width = source_dem.shape
    c = (lon - lo_lo) / (lo_hi - lo_lo) * (width - 1)
    r = (la_hi - lat) / (la_hi - la_lo) * (height - 1)
    return map_coordinates(source_dem, [r, c], order=3, mode="nearest")


def build_elevation_source(lo_lo, lo_hi, la_lo, la_hi, cache_key):
    mode = os.environ.get("WEB_DEM_SOURCE", "mixed").lower()
    ign_dem = fetch_ign_grid(lo_lo, lo_hi, la_lo, la_hi, cache_key)
    if mode == "ign":
        return {"kind": "ign", "name": "IGN LiDAR HD / RGE ALTI", "ign": ign_dem}
    try:
        piemonte = fetch_piemonte_dtm(lo_lo, lo_hi, la_lo, la_hi, cache_key)
    except Exception as exc:
        print(f"  Piemonte DTM unavailable, falling back to IGN-only: {exc}")
        return {"kind": "ign", "name": "IGN LiDAR HD / RGE ALTI", "ign": ign_dem}
    return {
        "kind": "mixed",
        "name": "Piemonte ICE 2009-2011 DTM 5m + IGN LiDAR HD fill",
        "ign": ign_dem,
        "piemonte": piemonte,
    }


def sample_elevation(lon, lat, lo_lo, lo_hi, la_lo, la_hi, source):
    if source["kind"] == "ign":
        return sample_ign(lon, lat, lo_lo, lo_hi, la_lo, la_hi, source["ign"])
    values = sample_piemonte(lon, lat, source["piemonte"])
    missing = ~np.isfinite(values)
    if np.any(missing):
        fill = sample_ign(np.asarray(lon)[missing], np.asarray(lat)[missing], lo_lo, lo_hi, la_lo, la_hi, source["ign"])
        values = values.copy()
        values[missing] = fill
    # If both sources had gaps (Piemonte hole + no IGN coverage), flatten the
    # remaining NaNs to the lowest known elevation so terrain math stays finite.
    still_missing = ~np.isfinite(values)
    if np.any(still_missing):
        finite = values[~still_missing]
        values = values.copy()
        values[still_missing] = float(finite.min()) if finite.size else 0.0
    return values


def sample_grid_elevation(lon, lat, lo_lo, lo_hi, la_lo, la_hi, heights):
    c = (lon - lo_lo) / (lo_hi - lo_lo) * (heights.shape[1] - 1)
    r = (lat - la_lo) / (la_hi - la_lo) * (heights.shape[0] - 1)
    return map_coordinates(heights, [r, c], order=1, mode="nearest")


def ensure_topo_tile(tx, ty, zoom):
    cache = DEFAULT_CACHE / "otm"
    cache.mkdir(parents=True, exist_ok=True)
    path = cache / f"{zoom}_{tx}_{ty}.png"
    if not path.exists():
        download(
            f"https://tile.opentopomap.org/{zoom}/{tx}/{ty}.png",
            dest=path,
            headers={"User-Agent": "trek-camera-viewer/1.0"},
            timeout=60,
        )
    return path


def opentopo_tile(tx, ty, zoom):
    return Image.open(ensure_topo_tile(tx, ty, zoom)).convert("RGB")


def warm_topo_cache(lo_lo, lo_hi, la_lo, la_hi):
    """Download all topo tiles for the bbox into the disk cache (parallel)."""
    zoom = int(os.environ.get("WEB_TILEZOOM", "17"))
    x_w, y_n = deg2num(la_hi, lo_lo, zoom)
    x_e, y_s = deg2num(la_lo, lo_hi, zoom)
    coords = [(tx, ty) for tx in range(int(x_w), int(x_e) + 1) for ty in range(int(y_n), int(y_s) + 1)]
    with otel.span("warm-topo", **{"tiles.count": len(coords)}):
        parallel_map(lambda c: ensure_topo_tile(c[0], c[1], zoom), coords, label="topo-tile")


def deg2num(lat, lon, zoom):
    n = 2**zoom
    x = (lon + 180.0) / 360.0 * n
    y = (1.0 - math.asinh(math.tan(math.radians(lat))) / math.pi) / 2.0 * n
    return x, y


def export_topographic_texture(lo_lo, lo_hi, la_lo, la_hi, out_path):
    zoom = int(os.environ.get("WEB_TILEZOOM", "17"))
    x_w, y_n = deg2num(la_hi, lo_lo, zoom)
    x_e, y_s = deg2num(la_lo, lo_hi, zoom)
    tx0, tx1 = int(x_w), int(x_e)
    ty0, ty1 = int(y_n), int(y_s)
    mosaic = Image.new("RGB", ((tx1 - tx0 + 1) * 256, (ty1 - ty0 + 1) * 256))
    coords = [(tx, ty) for tx in range(tx0, tx1 + 1) for ty in range(ty0, ty1 + 1)]
    tiles = parallel_map(lambda c: (c, opentopo_tile(c[0], c[1], zoom)), coords)
    for (tx, ty), tile in tiles:
        mosaic.paste(tile, ((tx - tx0) * 256, (ty - ty0) * 256))
    crop = (
        int((x_w - tx0) * 256),
        int((y_n - ty0) * 256),
        int((x_e - tx0) * 256),
        int((y_s - ty0) * 256),
    )
    texture = mosaic.crop(crop)
    texture = ImageEnhance.Color(texture).enhance(float(os.environ.get("WEB_TEXTURE_SAT", "1.45")))
    texture = ImageEnhance.Brightness(texture).enhance(float(os.environ.get("WEB_TEXTURE_BRIGHT", "0.82")))
    texture = ImageEnhance.Contrast(texture).enhance(float(os.environ.get("WEB_TEXTURE_CONTRAST", "1.16")))
    max_px = int(os.environ.get("WEB_TEXTURE_MAX", "8192"))
    texture.thumbnail((max_px, max_px), Image.Resampling.LANCZOS)
    texture.save(out_path.with_name("terrain-topo-raw.png"), optimize=True)
    texture.save(out_path, optimize=True)
    return zoom


def bake_hillshade_into_topo(texture_path, shade):
    texture = Image.open(texture_path).convert("RGB")
    shade_img = Image.fromarray(np.round(np.clip(shade, 0, 1) * 255).astype(np.uint8), mode="L")
    shade_img = shade_img.resize(texture.size, Image.Resampling.BICUBIC)
    texture_arr = np.asarray(texture).astype(float)
    shade_arr = np.asarray(shade_img).astype(float) / 255.0
    factor = 0.50 + 0.78 * shade_arr
    shaded = np.clip(texture_arr * factor[..., None], 0, 255).astype(np.uint8)
    Image.fromarray(shaded, mode="RGB").save(texture_path, optimize=True)


def draw_dem_contours(texture_path, heights):
    if os.environ.get("WEB_DEM_CONTOURS", "0") not in {"1", "true", "yes"}:
        return
    texture = Image.open(texture_path).convert("RGBA")
    overlay = Image.new("RGBA", texture.size, (0, 0, 0, 0))
    draw = ImageDraw.Draw(overlay)
    rows, cols = heights.shape
    width, height = texture.size
    minor_interval = float(os.environ.get("WEB_CONTOUR_MINOR_M", "40"))
    major_interval = float(os.environ.get("WEB_CONTOUR_MAJOR_M", "200"))
    min_level = math.ceil(float(np.nanmin(heights)) / minor_interval) * minor_interval
    max_level = math.floor(float(np.nanmax(heights)) / minor_interval) * minor_interval
    cg = contour_generator(x=np.arange(cols, dtype=float), y=np.arange(rows, dtype=float), z=heights)
    for level in np.arange(min_level, max_level + minor_interval * 0.5, minor_interval):
        is_major = abs((level / major_interval) - round(level / major_interval)) < 1e-6
        color = (96, 62, 30, 48) if is_major else (126, 86, 43, 20)
        line_width = 2 if is_major else 1
        for line in cg.lines(float(level)):
            if len(line) < 2:
                continue
            points = [
                (
                    float(point[0]) / max(1, cols - 1) * (width - 1),
                    (1.0 - float(point[1]) / max(1, rows - 1)) * (height - 1),
                )
                for point in line
            ]
            draw.line(points, fill=color, width=line_width)
    Image.alpha_composite(texture, overlay).convert("RGB").save(texture_path, optimize=True)


def normalize_to_u8(values, lo=None, hi=None):
    lo = float(np.nanpercentile(values, 2) if lo is None else lo)
    hi = float(np.nanpercentile(values, 98) if hi is None else hi)
    scaled = (np.clip(values, lo, hi) - lo) / max(1e-9, hi - lo)
    return np.round(scaled * 255).astype(np.uint8)


def relief_shade(dx, dy, azimuth_deg, altitude_deg=36.0, ambient=0.34):
    az = math.radians(azimuth_deg)
    alt = math.radians(altitude_deg)
    normal_x = -dx
    normal_y = -dy
    normal_z = np.ones_like(dx)
    norm = np.sqrt(normal_x * normal_x + normal_y * normal_y + normal_z * normal_z)
    normal_x, normal_y, normal_z = normal_x / norm, normal_y / norm, normal_z / norm
    light = np.array([math.cos(alt) * math.sin(az), math.cos(alt) * math.cos(az), math.sin(alt)])
    shade = np.clip(normal_x * light[0] + normal_y * light[1] + normal_z * light[2], 0, 1)
    return ambient + (1 - ambient) * shade, (normal_x, normal_y, normal_z)


def export_relief_textures(heights, width_m, depth_m, out_dir):
    dy, dx = np.gradient(heights, depth_m / (heights.shape[0] - 1), width_m / (heights.shape[1] - 1))
    slope_surface = gaussian_filter(heights, sigma=float(os.environ.get("WEB_SLOPE_SMOOTH", "0.6")))
    slope_dy, slope_dx = np.gradient(
        slope_surface,
        depth_m / (slope_surface.shape[0] - 1),
        width_m / (slope_surface.shape[1] - 1),
    )
    slope = np.hypot(slope_dx, slope_dy)
    hillshade_float, normals = relief_shade(dx, dy, 315)
    normal_x, normal_y, normal_z = normals
    shade_stack = [relief_shade(dx, dy, az, altitude_deg=38.0, ambient=0.28)[0] for az in (0, 45, 90, 135, 225, 270, 315)]
    multishade_float = np.mean(shade_stack, axis=0)
    reference_shade = np.clip(0.68 * hillshade_float + 0.32 * multishade_float, 0, 1)
    # Draped textures are sampled north-up (image top = north) to match the topo
    # tiles and the viewer's UVs. The relief arrays are derived from `heights`,
    # which is south-up (glat runs south->north), so flip every saved image.
    # The PNG encodes (zlib releases the GIL) are collected and saved in parallel.
    saves = []  # (array, mode, filename)
    hillshade = normalize_to_u8(hillshade_float, 0, 1)
    saves.append((np.flipud(hillshade), "L", "terrain-hillshade.png"))
    saves.append((np.flipud(normalize_to_u8(multishade_float, 0, 1)), "L", "terrain-multishade.png"))

    slope_deg = np.degrees(np.arctan(slope))
    base = normalize_to_u8(multishade_float, 0, 1).astype(float)
    slope_rgb = np.dstack([base, base, base]).astype(np.uint8)
    classes = [
        (20, (244, 226, 130)),
        (27, (237, 167, 64)),
        (30, (224, 91, 53)),
        (35, (180, 61, 116)),
        (40, (94, 52, 118)),
        (45, (38, 35, 48)),
    ]
    for threshold, color in classes:
        mask = slope_deg >= threshold
        color_arr = np.array(color, dtype=float)
        shade_factor = 0.72 + 0.34 * multishade_float[mask, None]
        slope_rgb[mask] = np.clip(color_arr * shade_factor, 0, 255).astype(np.uint8)
    saves.append((np.flipud(slope_rgb), "RGB", "terrain-slope.png"))

    h_u8 = normalize_to_u8(heights, np.nanmin(heights), np.nanmax(heights))
    hypso = np.zeros((*h_u8.shape, 3), dtype=np.uint8)
    hypso[..., 0] = np.interp(h_u8, [0, 80, 150, 255], [62, 118, 184, 245]).astype(np.uint8)
    hypso[..., 1] = np.interp(h_u8, [0, 80, 150, 255], [94, 142, 178, 239]).astype(np.uint8)
    hypso[..., 2] = np.interp(h_u8, [0, 80, 150, 255], [88, 94, 132, 230]).astype(np.uint8)
    shaded_hypso = (hypso.astype(float) * (0.50 + 0.50 * reference_shade[..., None])).astype(np.uint8)
    saves.append((np.flipud(shaded_hypso), "RGB", "terrain-hypso.png"))

    # Flip space (north-up) and negate the north-south component so the encoded
    # normals stay physically correct after the vertical flip.
    normal_rgb = np.dstack([
        np.flipud((normal_x * 0.5 + 0.5) * 255),
        np.flipud((normal_z * 0.5 + 0.5) * 255),
        np.flipud((-normal_y * 0.5 + 0.5) * 255),
    ]).astype(np.uint8)
    saves.append((normal_rgb, "RGB", "terrain-normal.png"))

    parallel_map(lambda s: Image.fromarray(s[0], s[1]).save(out_dir / s[2], optimize=True), saves, label="encode-relief")
    return {
        "hillshade": hillshade_float,
        "multishade": multishade_float,
        "reference": reference_shade,
    }


def fetch_forest_tcd(lo_lo, lo_hi, la_lo, la_hi):
    """Download the Copernicus Tree Cover Density tile into the cache (one request)."""
    px = int(os.environ.get("WEB_FOREST_PX", "2048"))
    wm = (lo_hi - lo_lo) * 111320 * math.cos(math.radians((la_lo + la_hi) / 2))
    hm = (la_hi - la_lo) * 111320
    width, height = px, max(1, int(round(px * hm / wm)))
    base = os.environ.get(
        "WEB_FOREST_URL",
        "https://image.discomap.eea.europa.eu/arcgis/rest/services/"
        "GioLandPublic/HRL_TreeCoverDensity_2018/ImageServer/exportImage",
    )
    q = {
        "bbox": f"{lo_lo},{la_lo},{lo_hi},{la_hi}",
        "bboxSR": "4326",
        "imageSR": "4326",
        "size": f"{width},{height}",
        "format": "tiff",
        "pixelType": "U8",
        "interpolation": "RSP_BilinearInterpolation",
        "f": "image",
    }
    path = DEFAULT_CACHE / f"forest_{lo_lo:.4f}_{la_lo:.4f}_{lo_hi:.4f}_{la_hi:.4f}_{width}x{height}.tif"
    if not path.exists():
        download(base + "?" + urllib.parse.urlencode(q), dest=path, timeout=180)
    return path, width, height


def warm_forest_cache(lo_lo, lo_hi, la_lo, la_hi):
    with otel.span("warm-forest"):
        try:
            fetch_forest_tcd(lo_lo, lo_hi, la_lo, la_hi)
        except Exception:
            pass  # forest is an optional layer; export step logs if it's unavailable


def export_forest_texture(lo_lo, lo_hi, la_lo, la_hi, out_dir, shade):
    # Copernicus HRL Tree Cover Density 2018 (10 m), via EEA Discomap's public ImageServer.
    # Raw 0-100 % canopy values, colourised to a paper-map green with relief baked in (like slope/hypso).
    try:
        path, width, height = fetch_forest_tcd(lo_lo, lo_hi, la_lo, la_hi)
        with rasterio.open(path) as src:
            tcd = src.read(1).astype(np.float32)
    except Exception as exc:
        print(f"  Copernicus tree-cover unavailable, skipping forest layer: {exc}")
        return None
    tcd = tcd[::-1]  # exportImage is north-up; relief arrays/heights are south-up
    tcd[tcd > 100] = 0.0  # 254/255 = nodata / outside coverage
    # Only real forest reads green: drop canopy below the threshold (scattered trees / meadow look like grass otherwise).
    thresh = float(os.environ.get("WEB_FOREST_MIN_TCD", "50"))
    d = np.clip((tcd - thresh) / (100.0 - thresh), 0.0, 1.0)
    cream = np.array([243, 239, 226], dtype=float)
    g_lo = np.array([120, 162, 104], dtype=float)  # threshold canopy
    g_hi = np.array([42, 86, 44], dtype=float)  # dense canopy
    green = g_lo[None, None] + (g_hi - g_lo)[None, None] * d[..., None]
    vis = np.clip(d * 3.0, 0.0, 1.0)[..., None]  # soft edge near threshold, paper below it
    rgb = cream[None, None] * (1 - vis) + green * vis
    shade_img = Image.fromarray(np.round(np.clip(shade, 0, 1) * 255).astype(np.uint8), "L").resize(
        (width, height), Image.Resampling.BICUBIC
    )
    factor = (0.55 + 0.62 * (np.asarray(shade_img) / 255.0))[..., None]
    rgb = np.clip(rgb * factor, 0, 255).astype(np.uint8)
    # Computed south-up (to align with the shade array); flip to north-up for draping.
    Image.fromarray(np.flipud(rgb), "RGB").save(out_dir / "terrain-forest.png", optimize=True)
    print(f"  forest: TCD canopy {float((d > 0).mean() * 100):.0f}% of bbox")
    return "terrain-forest.png"


def load_border_lines(lo_lo, lo_hi, la_lo, la_hi, cache_key):
    path = DEFAULT_CACHE / f"border_{cache_key}.geojson"
    if not path.exists():
        q = (
            f'[out:json][timeout:25];way["boundary"="administrative"]["admin_level"="2"]'
            f"({la_lo},{lo_lo},{la_hi},{lo_hi});out geom;"
        )
        req = urllib.request.Request(
            "https://overpass-api.de/api/interpreter",
            data=urllib.parse.urlencode({"data": q}).encode(),
            headers={"User-Agent": "trek-camera-viewer/1.0"},
        )
        try:
            ways = json.load(urllib.request.urlopen(req, timeout=60))["elements"]
        except Exception:
            return []
        features = [
            {
                "type": "Feature",
                "properties": {"id": way["id"]},
                "geometry": {
                    "type": "LineString",
                    "coordinates": [[p["lon"], p["lat"]] for p in way["geometry"]],
                },
            }
            for way in ways
            if way.get("type") == "way" and way.get("geometry")
        ]
        path.write_text(json.dumps({"type": "FeatureCollection", "features": features}))
    data = json.loads(path.read_text())
    lines = []
    for feature in data.get("features", []):
        geometry = feature.get("geometry", {})
        segments = geometry.get("coordinates", [])
        if geometry.get("type") == "LineString":
            segments = [segments]
        for segment in segments:
            if len(segment) > 1:
                lines.append(np.array(segment, dtype=float))
    return lines


def export_border_overlay(lo_lo, lo_hi, la_lo, la_hi, lat0, x0, y0, heights, cache_key, out_dir):
    overlays = []
    for line in load_border_lines(lo_lo, lo_hi, la_lo, la_hi, cache_key):
        lon = line[:, 0]
        lat = line[:, 1]
        mask = (lon >= lo_lo) & (lon <= lo_hi) & (lat >= la_lo) & (lat <= la_hi)
        if not mask.any():
            continue
        indices = np.where(mask)[0]
        for run in np.split(indices, np.where(np.diff(indices) > 1)[0] + 1):
            if len(run) < 2:
                continue
            sampled_lon = lon[run]
            sampled_lat = lat[run]
            z = sample_grid_elevation(sampled_lon, sampled_lat, lo_lo, lo_hi, la_lo, la_hi, heights)
            x = R * np.radians(sampled_lon) * math.cos(lat0) - x0
            y = R * np.radians(sampled_lat) - y0
            overlays.append(
                [
                    {
                        "x": round(float(px), 2),
                        "y": round(float(py), 2),
                        "z": round(float(pz), 2),
                    }
                    for px, py, pz in zip(x, y, z)
                ]
            )
    border = {"id": "france-italy-border", "name": "France / Italy border", "color": "#1f6bff", "lines": overlays}
    (out_dir / "border.json").write_text(json.dumps(border, separators=(",", ":")))
    return len(overlays)


def build_assets(gpx_path: Path, final_image: Path, angles_image: Path, out_dir: Path):
    progress(8, "Reading GPX track")
    with otel.span("parse-gpx"):
        lat_raw, lon_raw, ele_raw = parse_gpx(gpx_path)
    route_id = os.environ.get("WEB_ROUTE_ID") or slugify(gpx_path.stem)
    route_name = os.environ.get("WEB_ROUTE_NAME") or route_title_from_stem(gpx_path.stem)
    source_name = os.environ.get("WEB_SOURCE_NAME") or gpx_path.name
    lat = savgol_filter(lat_raw, 15, 2)
    lon = savgol_filter(lon_raw, 15, 2)
    ele_smooth = savgol_filter(ele_raw, 61, 2)

    margin = float(os.environ.get("WEB_MARGIN", "0.0025"))
    la_lo, la_hi = float(lat.min() - margin), float(lat.max() + margin)
    lo_lo, lo_hi = float(lon.min() - margin), float(lon.max() + margin)
    bbox_key = f"{lat_raw.min():.3f}_{lat_raw.max():.3f}_{lon_raw.min():.3f}_{lon_raw.max():.3f}_m{margin:.4f}"

    # Pick the grid for a target ground resolution (m/cell) so detail density is
    # consistent regardless of route size. WEB_GRID still forces a fixed grid.
    # The cell count is capped so a huge route can't blow up terrain.json — when
    # the cap bites, the effective resolution coarsens (logged below).
    span_w_m = (lo_hi - lo_lo) * 111320 * math.cos(math.radians((la_lo + la_hi) / 2))
    span_h_m = (la_hi - la_lo) * 111320
    if os.environ.get("WEB_GRID"):
        grid_size = int(os.environ["WEB_GRID"])
    else:
        target_res_m = float(os.environ.get("WEB_TARGET_RES_M", "5"))
        grid_min = int(os.environ.get("WEB_GRID_MIN", "700"))
        grid_max = int(os.environ.get("WEB_GRID_MAX", "3000"))
        grid_size = int(np.clip(round(max(span_w_m, span_h_m) / target_res_m), grid_min, grid_max))
    cell_m = max(span_w_m, span_h_m) / max(1, grid_size - 1)
    print(f"  grid: {grid_size}x{grid_size}, ~{cell_m:.1f} m/cell over {max(span_w_m, span_h_m) / 1000:.1f} km", flush=True)

    # Overlap the three independent online fetches (each hits a different host):
    # map tiles + forest warm their caches on background threads while the DEM
    # downloads and terrain samples on the main thread.
    bind = otel.context_binder()
    prefetch_pool = concurrent.futures.ThreadPoolExecutor(max_workers=2)
    prefetch = [
        prefetch_pool.submit(bind(warm_topo_cache), lo_lo, lo_hi, la_lo, la_hi),
        prefetch_pool.submit(bind(warm_forest_cache), lo_lo, lo_hi, la_lo, la_hi),
    ]

    glat = np.linspace(la_lo, la_hi, grid_size)
    glon = np.linspace(lo_lo, lo_hi, grid_size)
    LO, LA = np.meshgrid(glon, glat)
    progress(22, "Fetching elevation (DEM)")
    with otel.span("elevation-source", **{"dem.bbox": bbox_key, "dem.grid": grid_size}):
        elevation_source = build_elevation_source(lo_lo, lo_hi, la_lo, la_hi, bbox_key)
    progress(58, "Sampling route & terrain")
    with otel.span("sample-elevation", **{"dem.source": elevation_source["kind"]}):
        raw_heights = sample_elevation(LO, LA, lo_lo, lo_hi, la_lo, la_hi, elevation_source)
    mesh_smooth = float(os.environ.get("WEB_MESH_SMOOTH", "0.0"))
    relief_smooth = float(os.environ.get("WEB_RELIEF_SMOOTH", "0.10"))
    heights = raw_heights if mesh_smooth <= 0 else gaussian_filter(raw_heights, sigma=mesh_smooth)
    relief_heights = heights if relief_smooth <= 0 else gaussian_filter(heights, sigma=relief_smooth)

    lat0 = math.radians(float(lat.mean()))
    x0 = R * math.radians(lo_lo) * math.cos(lat0)
    y0 = R * math.radians(la_lo)
    x_grid = R * np.radians(LO) * math.cos(lat0) - x0
    y_grid = R * np.radians(LA) - y0
    width_m = float(x_grid.max() - x_grid.min())
    depth_m = float(y_grid.max() - y_grid.min())

    route_step = float(os.environ.get("WEB_ROUTE_STEP_M", "2.0"))
    idx = simplify_by_distance(lat, lon, ele_smooth, target_step=route_step)
    route_lon = lon[idx]
    route_lat = lat[idx]
    route_z = sample_grid_elevation(route_lon, route_lat, lo_lo, lo_hi, la_lo, la_hi, heights)
    route_x = R * np.radians(route_lon) * math.cos(lat0) - x0
    route_y = R * np.radians(route_lat) - y0
    route_d = cumulative_distance(route_lat, route_lon)
    route_points = [
        {
            "x": round(float(x), 2),
            "y": round(float(y), 2),
            "z": round(float(z), 2),
            "d": round(float(d), 2),
            "lat": round(float(a), 7),
            "lon": round(float(o), 7),
        }
        for x, y, z, d, a, o in zip(route_x, route_y, route_z, route_d, route_lat, route_lon)
    ]

    DEFAULT_CACHE.mkdir(parents=True, exist_ok=True)
    out_dir.mkdir(parents=True, exist_ok=True)
    has_reference_render = final_image.exists()
    if has_reference_render:
        shutil.copyfile(final_image, out_dir / "reference-render.png")
    if angles_image.exists():
        shutil.copyfile(angles_image, out_dir / "angle-sheet.png")

    # Caches are warm from the background prefetch; these stages now read locally.
    for future in prefetch:
        future.result()
    prefetch_pool.shutdown()

    progress(70, "Building map textures")
    with otel.span("textures"):
        texture_zoom = export_topographic_texture(lo_lo, lo_hi, la_lo, la_hi, out_dir / "terrain-texture.png")
    reference_source = final_image if has_reference_render else out_dir / "terrain-texture.png"
    if not has_reference_render:
        shutil.copyfile(reference_source, out_dir / "reference-render.png")
    preview = Image.open(reference_source).convert("RGB")
    preview.thumbnail((1200, 900), Image.Resampling.LANCZOS)
    preview.save(out_dir / "reference-preview.jpg", quality=88, optimize=True)

    route = {
        "id": route_id,
        "name": route_name,
        "source": source_name,
        "pointCount": int(len(lat_raw)),
        "displayPointCount": int(len(route_points)),
        "distanceKm": round(float(cumulative_distance(lat, lon)[-1] / 1000), 2),
        "elevationGainM": round(float(ascent_deadband(ele_smooth))),
        "minElevationM": round(float(np.min(route_z))),
        "maxElevationM": round(float(np.max(route_z))),
        "points": route_points,
    }
    (out_dir / "route.json").write_text(json.dumps(route, separators=(",", ":")))

    height_min = float(np.min(heights))
    height_max = float(np.max(heights))
    quantized = np.round((heights - height_min) / (height_max - height_min) * 65535).astype(np.uint16)
    height_image = Image.fromarray(quantized, mode="I;16")
    height_image.save(out_dir / "heightmap.png")
    progress(82, "Rendering relief & slope")
    relief = export_relief_textures(relief_heights, width_m, depth_m, out_dir)
    if os.environ.get("WEB_BAKE_RELIEF", "0") in {"1", "true", "yes"}:
        # topo texture is north-up; relief["reference"] is south-up — flip to match.
        bake_hillshade_into_topo(out_dir / "terrain-texture.png", np.flipud(relief["reference"]))
    draw_dem_contours(out_dir / "terrain-texture.png", relief_heights)
    progress(90, "Adding forest layer")
    forest_texture = export_forest_texture(lo_lo, lo_hi, la_lo, la_hi, out_dir, relief["reference"])
    border_count = export_border_overlay(lo_lo, lo_hi, la_lo, la_hi, lat0, x0, y0, heights, bbox_key, out_dir)
    terrain = {
        "gridSize": grid_size,
        "widthM": round(width_m, 2),
        "depthM": round(depth_m, 2),
        "minHeightM": round(height_min, 2),
        "maxHeightM": round(height_max, 2),
        "heights": [round(float(v), 3) for v in heights.ravel()],
    }
    (out_dir / "terrain.json").write_text(json.dumps(terrain, separators=(",", ":")))

    manifest = {
        "id": route_id,
        "name": route_name,
        "bounds": [round(lo_lo, 7), round(la_lo, 7), round(lo_hi, 7), round(la_hi, 7)],
        "projection": {
            "kind": "local-equirectangular",
            "lat0": round(math.degrees(lat0), 7),
            "originLon": round(lo_lo, 7),
            "originLat": round(la_lo, 7),
        },
        "terrain": {
            "data": "terrain.json",
            "heightmap": "heightmap.png",
            "texture": "terrain-texture.png",
            "rawTexture": "terrain-topo-raw.png",
            "textureZoom": texture_zoom,
            "hillshadeTexture": "terrain-hillshade.png",
            "multiHillshadeTexture": "terrain-multishade.png",
            "slopeTexture": "terrain-slope.png",
            "hypsoTexture": "terrain-hypso.png",
            "forestTexture": forest_texture,
            "normalTexture": "terrain-normal.png",
            "demSource": elevation_source["kind"],
            "demSourceLabel": elevation_source["name"],
            "piemonteSampleOrder": int(os.environ.get("WEB_PIEMONTE_SAMPLE_ORDER", "1")),
            "sourceResolutionM": 5.0 if elevation_source["kind"] == "mixed" else float(os.environ.get("WEB_DEM_RES_M", "1.0")),
            "ignFillResolutionM": float(os.environ.get("WEB_DEM_RES_M", "1.0")),
            "meshSmoothingSigma": mesh_smooth,
            "reliefSmoothingSigma": relief_smooth,
            "slopeSmoothingSigma": float(os.environ.get("WEB_SLOPE_SMOOTH", "0.6")),
            "routeSampleStepM": route_step,
            "gridSize": grid_size,
            "widthM": round(width_m, 2),
            "depthM": round(depth_m, 2),
            "minHeightM": round(height_min, 2),
            "maxHeightM": round(height_max, 2),
        },
        "reference": {
            "render": "reference-render.png",
            "preview": "reference-preview.jpg",
            "angles": "angle-sheet.png" if angles_image.exists() else None,
        },
        "routes": [
            {
                "id": route["id"],
                "name": route["name"],
                "path": "route.json",
                "distanceKm": route["distanceKm"],
                "elevationGainM": route["elevationGainM"],
                "pointCount": route["pointCount"],
            }
        ],
        "overlays": {
            "border": "border.json" if border_count else None
        },
        "defaultCamera": {
            "position": [round(width_m * 0.55, 2), round(-depth_m * 0.7, 2), round((height_max - height_min) * 2.2, 2)],
            "target": [round(width_m * 0.52, 2), round(depth_m * 0.52, 2), round((height_min + height_max) / 2, 2)],
            "fov": 42,
        },
        "attribution": [
            elevation_source["name"],
            f"Source GPX: {source_name}",
            "Reference preview generated from imported terrain assets",
        ],
    }
    progress(97, "Finalizing assets")
    (out_dir / "manifest.json").write_text(json.dumps(manifest, indent=2))
    print(f"wrote {out_dir}")
    print(f"  route: {route['distanceKm']} km, +{route['elevationGainM']} m, {route['displayPointCount']} web points")
    print(f"  terrain: {grid_size}x{grid_size}, {width_m:.0f} x {depth_m:.0f} m")


def main(argv=None):
    """CLI entrypoint used by the compatibility wrapper and tests."""
    args = sys.argv[1:] if argv is None else list(argv)
    repo_root = Path(__file__).resolve().parents[3]
    gpx = Path(args[0]) if len(args) > 0 else repo_root / "examples" / "gpx" / "Escursione_mattutina.gpx"
    final = Path(args[1]) if len(args) > 1 else repo_root / "examples" / "reference" / "Escursione_mattutina-final.png"
    angles = Path(args[2]) if len(args) > 2 else repo_root / "examples" / "reference" / "Escursione_mattutina-angles.png"
    out = Path(args[3]) if len(args) > 3 else repo_root / "web" / "public" / "assets" / "escursione-mattutina"
    with otel.root_span("build-assets", **{"gpx.path": gpx.name, "quality.grid": os.environ.get("WEB_GRID", "")}):
        build_assets(gpx, final, angles, out)


if __name__ == "__main__":
    main()
