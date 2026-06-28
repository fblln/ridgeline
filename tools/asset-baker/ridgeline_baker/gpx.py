"""GPX parsing and route metrics for the static asset baker."""

import math
import re
from pathlib import Path

import numpy as np

EARTH_RADIUS_M = 6371000.0


def slugify(value: str):
    """Create a stable route id for generated web assets."""
    slug = re.sub(r"[^a-z0-9]+", "-", value.lower()).strip("-")
    return slug or "imported-route"


def route_title_from_stem(stem: str):
    """Turn a GPX filename stem into a display name."""
    return re.sub(r"[_-]+", " ", stem).strip().title() or "Imported route"


def parse_gpx(path: Path):
    """Read GPX track points as latitude, longitude, elevation arrays."""
    text = path.read_text()
    pts = [
        (float(lat), float(lon), float(ele))
        for lat, lon, ele in re.findall(
            r'<trkpt lat="([^"]+)" lon="([^"]+)">.*?<ele>([^<]+)</ele>',
            text,
            flags=re.S,
        )
    ]
    if len(pts) < 2:
        raise ValueError(f"No track points found in {path}")
    lat = np.array([p[0] for p in pts], dtype=float)
    lon = np.array([p[1] for p in pts], dtype=float)
    ele = np.array([p[2] for p in pts], dtype=float)
    return lat, lon, ele


def haversine(a1, o1, a2, o2):
    """Great-circle distance between two WGS84 points in meters."""
    p1, p2 = math.radians(a1), math.radians(a2)
    h = (
        math.sin((p2 - p1) / 2) ** 2
        + math.cos(p1) * math.cos(p2) * math.sin(math.radians(o2 - o1) / 2) ** 2
    )
    return 2 * EARTH_RADIUS_M * math.asin(math.sqrt(h))


def cumulative_distance(lat, lon):
    """Cumulative route distance in meters for parallel lat/lon arrays."""
    d = np.zeros(len(lat), dtype=float)
    for i in range(1, len(lat)):
        d[i] = d[i - 1] + haversine(lat[i - 1], lon[i - 1], lat[i], lon[i])
    return d


def ascent_deadband(z, threshold=3.0):
    """Positive elevation gain with a small deadband for DEM noise."""
    total = 0.0
    low = float(z[0])
    for v in z[1:]:
        v = float(v)
        if v > low + threshold:
            total += v - low
            low = v
        elif v < low:
            low = v
    return total


def simplify_by_distance(lat, lon, ele, target_step=16.0):
    """Choose source point indexes spaced by route distance."""
    d = cumulative_distance(lat, lon)
    if d[-1] <= 0:
        return np.array([0, len(lat) - 1])
    samples = np.arange(0, d[-1], target_step)
    idx = np.searchsorted(d, samples)
    idx = np.clip(idx, 0, len(lat) - 1)
    idx = np.unique(np.r_[idx, len(lat) - 1])
    return idx
