"""Tests for the pure route-metric helpers in ridgeline_baker.gpx."""

import numpy as np
import pytest
from ridgeline_baker.gpx import (
    ascent_deadband,
    cumulative_distance,
    haversine,
    parse_gpx,
    route_title_from_stem,
    simplify_by_distance,
    slugify,
)


def test_haversine_one_degree_latitude():
    # One degree of latitude is ~111.2 km on the baker's spherical earth.
    assert haversine(45.0, 7.0, 46.0, 7.0) == pytest.approx(111195, rel=1e-3)


def test_haversine_zero_for_same_point():
    assert haversine(45.0, 7.0, 45.0, 7.0) == 0.0


def test_cumulative_distance_is_monotonic_and_totals():
    lat = np.array([45.0, 45.0, 45.0])
    lon = np.array([7.0, 7.01, 7.02])
    d = cumulative_distance(lat, lon)
    assert d[0] == 0.0
    assert np.all(np.diff(d) >= 0)
    expected = haversine(45, 7, 45, 7.01) + haversine(45, 7.01, 45, 7.02)
    assert d[-1] == pytest.approx(expected)


def test_ascent_deadband_ignores_jitter_sums_real_climb():
    # Sub-threshold wobble contributes nothing.
    assert ascent_deadband([0, 1, 2, 1, 2], threshold=3.0) == 0.0
    # Real climbs above the deadband accumulate (0->5 then 4->9 = 10).
    assert ascent_deadband([0, 5, 4, 9], threshold=3.0) == pytest.approx(10.0)


def test_simplify_by_distance_keeps_endpoints_and_shrinks():
    lat = np.full(50, 45.0)
    lon = np.linspace(7.0, 7.05, 50)
    idx = simplify_by_distance(lat, lon, np.zeros(50), target_step=200.0)
    assert idx[0] == 0
    assert idx[-1] == len(lat) - 1
    assert len(idx) < len(lat)
    assert np.all(np.diff(idx) > 0)  # strictly increasing, no duplicates


def test_simplify_by_distance_degenerate_route():
    lat = np.array([45.0, 45.0])
    lon = np.array([7.0, 7.0])
    idx = simplify_by_distance(lat, lon, np.zeros(2))
    assert list(idx) == [0, 1]


def test_slugify():
    assert slugify("Morning Hike") == "morning-hike"
    assert slugify("  ") == "imported-route"


def test_route_title_from_stem():
    assert route_title_from_stem("morning_hike-1") == "Morning Hike 1"
    assert route_title_from_stem("") == "Imported route"


def test_parse_gpx_reads_points(tmp_path):
    gpx = tmp_path / "r.gpx"
    gpx.write_text(
        '<gpx><trk><trkseg>'
        '<trkpt lat="45.0" lon="7.0"><ele>100</ele></trkpt>'
        '<trkpt lat="45.1" lon="7.1"><ele>150</ele></trkpt>'
        '</trkseg></trk></gpx>'
    )
    lat, lon, ele = parse_gpx(gpx)
    assert list(lat) == [45.0, 45.1]
    assert list(lon) == [7.0, 7.1]
    assert list(ele) == [100.0, 150.0]


def test_parse_gpx_rejects_too_few_points(tmp_path):
    gpx = tmp_path / "r.gpx"
    gpx.write_text('<gpx><trkpt lat="45.0" lon="7.0"><ele>100</ele></trkpt></gpx>')
    with pytest.raises(ValueError):
        parse_gpx(gpx)
