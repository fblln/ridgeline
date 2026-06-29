//! GPX-driven offline pipeline test.
//!
//! Runs the real compute path on a real GPX fixture — parse → smooth → bounds →
//! grid → meshgrid → GDAL sample → relief encode → asset write — with a
//! *synthetic* in-memory DEM so it needs no network. Asserts the produced
//! terrain assets are well-formed and deterministic.

use std::path::PathBuf;

use ridgeline_baker::config::Config;
use ridgeline_baker::dem::{
    Bounds, ElevationSource, bounds_from_smoothed, grid_for_bounds, meshgrid, sample_elevation,
};
use ridgeline_baker::gpx::parse_gpx;
use ridgeline_baker::grid::Grid;
use ridgeline_baker::smooth::savgol_smooth;
use ridgeline_baker::texture::export_relief_textures;

fn fixture_gpx() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../examples/gpx/Escursione_mattutina.gpx")
}

/// A smooth synthetic DEM spanning `bounds`: a tilted plane, all finite, so the
/// GDAL warp produces real (non-NaN) terrain everywhere.
fn synthetic_dem(bounds: Bounds) -> ElevationSource {
    let (w, h) = (120usize, 120usize);
    let mut data = Vec::with_capacity(w * h);
    for row in 0..h {
        for col in 0..w {
            // North (row 0) high, south low; east higher than west.
            let z =
                1000.0 + (col as f64 / w as f64) * 500.0 + (1.0 - row as f64 / h as f64) * 300.0;
            data.push(z);
        }
    }
    let _ = bounds;
    ElevationSource {
        kind: "ign".to_string(),
        name: "synthetic".to_string(),
        ign: Grid::from_vec(w, h, data).unwrap(),
        piemonte: None,
    }
}

fn sample_fixture() -> (Config, Bounds, usize, Grid) {
    let out = std::env::temp_dir().join(format!("ridgeline-pipeline-test-{}", std::process::id()));
    let missing = out.join("missing.png");
    let config = Config::from_paths(fixture_gpx(), missing.clone(), missing, out).unwrap();

    let track = parse_gpx(&config.gpx_path).unwrap();
    let lat = savgol_smooth(&track.lat, 15);
    let lon = savgol_smooth(&track.lon, 15);
    let bounds = bounds_from_smoothed(&lat, &lon, config.margin);
    let (grid_size, _, _, _) = grid_for_bounds(&config, bounds);
    let (_, _, grid_lon, grid_lat) = meshgrid(bounds, grid_size);

    let source = synthetic_dem(bounds);
    let heights = sample_elevation(&grid_lon, &grid_lat, bounds, &source).unwrap();
    (config, bounds, grid_size, heights)
}

#[test]
fn sample_produces_square_finite_terrain_in_plane_range() {
    let (_, _, grid_size, heights) = sample_fixture();
    assert_eq!((heights.width, heights.height), (grid_size, grid_size));
    assert!(heights.data.iter().all(|v| v.is_finite()));
    let (min, max) = heights.finite_min_max();
    // The synthetic plane spans 1000..1800 m; the warped subset must sit inside it.
    assert!(
        min >= 1000.0 - 1.0 && max <= 1800.0 + 1.0,
        "min={min} max={max}"
    );
    assert!(max - min > 1.0, "terrain should not be flat");
}

#[test]
fn sampling_is_deterministic() {
    let (_, _, _, a) = sample_fixture();
    let (_, _, _, b) = sample_fixture();
    assert_eq!(a.data, b.data);
}

#[test]
fn relief_export_writes_well_formed_assets() {
    let (config, _, grid_size, heights) = sample_fixture();
    std::fs::create_dir_all(&config.out_dir).unwrap();
    // No edge apron in the test -> pad = 0, visible grid == sampled grid.
    let relief = export_relief_textures(&config, &heights, 5000.0, 5000.0, 0).unwrap();
    assert_eq!(
        (relief.hillshade.width, relief.hillshade.height),
        (grid_size, grid_size)
    );

    for name in [
        "terrain-hillshade.png",
        "terrain-multishade.png",
        "terrain-slope.png",
        "terrain-hypso.png",
        "terrain-normal.png",
    ] {
        let bytes =
            std::fs::read(config.out_dir.join(name)).unwrap_or_else(|e| panic!("{name}: {e}"));
        // PNG magic + a plausible payload for a grid_size x grid_size image.
        assert!(bytes.starts_with(b"\x89PNG\r\n\x1a\n"), "{name} not a PNG");
        assert!(bytes.len() > 100, "{name} suspiciously small");
    }
    std::fs::remove_dir_all(&config.out_dir).ok();
}
