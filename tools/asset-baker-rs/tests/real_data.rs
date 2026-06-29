use std::path::PathBuf;

use ridgeline_baker::config::Config;
use ridgeline_baker::dem::{Bounds, grid_for_bounds, sample_grid_elevation};
use ridgeline_baker::gpx::{cumulative_distance, parse_gpx, parse_gpx_text, simplify_by_distance};
use ridgeline_baker::grid::Grid;

fn fixture_gpx() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../examples/gpx/Escursione_mattutina.gpx")
}

#[test]
fn real_fixture_gpx_has_plausible_route_metrics() {
    let track = parse_gpx(&fixture_gpx()).unwrap();
    assert!(
        track.lat.len() > 100,
        "fixture should be a real recorded route"
    );
    assert_eq!(track.lat.len(), track.lon.len());
    assert_eq!(track.lat.len(), track.ele.len());

    let distance_m = cumulative_distance(&track.lat, &track.lon)
        .last()
        .copied()
        .unwrap();
    assert!(
        (1_000.0..100_000.0).contains(&distance_m),
        "unexpected fixture distance: {distance_m}"
    );
    assert!(track.ele.iter().all(|value| value.is_finite()));
}

#[test]
fn generated_large_gpx_parses_and_simplifies_without_losing_endpoints() {
    let mut gpx = String::from("<gpx><trk><trkseg>");
    for i in 0..12_000 {
        let t = i as f64;
        let lat = 45.0 + t * 0.000003;
        let lon = 7.0 + (t * 0.000002) + (t / 200.0).sin() * 0.00008;
        let ele = 800.0 + (t / 50.0).sin() * 35.0 + t * 0.01;
        gpx.push_str(&format!(
            r#"<trkpt lat="{lat:.7}" lon="{lon:.7}"><ele>{ele:.2}</ele></trkpt>"#
        ));
    }
    gpx.push_str("</trkseg></trk></gpx>");

    let track = parse_gpx_text(&gpx).unwrap();
    assert_eq!(track.lat.len(), 12_000);
    let simplified = simplify_by_distance(&track.lat, &track.lon, 25.0);
    assert_eq!(simplified[0], 0);
    assert_eq!(simplified[simplified.len() - 1], track.lat.len() - 1);
    assert!(simplified.len() > 100);
    assert!(simplified.len() < track.lat.len() / 2);
}

#[test]
fn large_map_grid_samples_route_points_across_full_extent() {
    let size = 1024usize;
    let bounds = Bounds {
        lo_lo: 7.0,
        lo_hi: 7.08,
        la_lo: 45.0,
        la_hi: 45.05,
    };
    let mut heights = Grid::new(size, size, 0.0);
    for row in 0..size {
        for col in 0..size {
            let ridge = ((col as f64 / 19.0).sin() + (row as f64 / 31.0).cos()) * 15.0;
            heights.set(
                row,
                col,
                1200.0 + row as f64 * 0.2 + col as f64 * 0.1 + ridge,
            );
        }
    }

    let mut samples = Vec::new();
    for i in 0..2_000 {
        let f = i as f64 / 1_999.0;
        let lon = bounds.lo_lo + (bounds.lo_hi - bounds.lo_lo) * f;
        let lat = bounds.la_lo
            + (bounds.la_hi - bounds.la_lo) * (0.5 - 0.5 * (f * std::f64::consts::TAU).cos());
        samples.push(sample_grid_elevation(lon, lat, bounds, &heights));
    }

    assert_eq!(samples.len(), 2_000);
    assert!(samples.iter().all(|value| value.is_finite()));
    let min = samples.iter().copied().fold(f64::INFINITY, f64::min);
    let max = samples.iter().copied().fold(f64::NEG_INFINITY, f64::max);
    assert!(
        max - min > 100.0,
        "large map samples should span meaningful relief"
    );
}

#[test]
fn grid_for_realistic_large_map_respects_configured_bounds() {
    let dir = tempfile::tempdir().unwrap();
    let gpx = dir.path().join("route.gpx");
    std::fs::write(&gpx, "<gpx/>").unwrap();
    let mut config = Config::from_paths(
        gpx,
        dir.path().join("reference.png"),
        dir.path().join("angles.png"),
        dir.path().join("out"),
    )
    .unwrap();
    config.grid = None;
    config.target_res_m = 1.0;
    config.grid_min = 128;
    config.grid_max = 2048;

    let (grid, width_m, depth_m, cell_m) = grid_for_bounds(
        &config,
        Bounds {
            lo_lo: 6.95,
            lo_hi: 7.20,
            la_lo: 44.90,
            la_hi: 45.12,
        },
    );
    assert_eq!(grid, 2048);
    assert!(width_m > 19_000.0);
    assert!(depth_m > 24_000.0);
    assert!(cell_m > 10.0);
}
