use std::fs;

use ridgeline_baker::gpx::{
    ascent_deadband, cumulative_distance, haversine, parse_gpx, route_title_from_stem,
    simplify_by_distance, slugify,
};

#[test]
fn haversine_one_degree_latitude() {
    let distance = haversine(45.0, 7.0, 46.0, 7.0);
    assert!((distance - 111_195.0).abs() / 111_195.0 < 1e-3);
}

#[test]
fn haversine_zero_for_same_point() {
    assert_eq!(haversine(45.0, 7.0, 45.0, 7.0), 0.0);
}

#[test]
fn cumulative_distance_is_monotonic_and_totals() {
    let lat = [45.0, 45.0, 45.0];
    let lon = [7.0, 7.01, 7.02];
    let d = cumulative_distance(&lat, &lon);
    assert_eq!(d[0], 0.0);
    assert!(d.windows(2).all(|w| w[1] >= w[0]));
    let expected = haversine(45.0, 7.0, 45.0, 7.01) + haversine(45.0, 7.01, 45.0, 7.02);
    assert!((d[d.len() - 1] - expected).abs() < 1e-9);
}

#[test]
fn ascent_deadband_ignores_jitter_sums_real_climb() {
    assert_eq!(ascent_deadband(&[0.0, 1.0, 2.0, 1.0, 2.0], 3.0), 0.0);
    assert!((ascent_deadband(&[0.0, 5.0, 4.0, 9.0], 3.0) - 10.0).abs() < 1e-9);
}

#[test]
fn simplify_by_distance_keeps_endpoints_and_shrinks() {
    let lat = vec![45.0; 50];
    let lon = (0..50)
        .map(|i| 7.0 + 0.05 * i as f64 / 49.0)
        .collect::<Vec<_>>();
    let idx = simplify_by_distance(&lat, &lon, 200.0);
    assert_eq!(idx[0], 0);
    assert_eq!(idx[idx.len() - 1], lat.len() - 1);
    assert!(idx.len() < lat.len());
    assert!(idx.windows(2).all(|w| w[1] > w[0]));
}

#[test]
fn simplify_by_distance_degenerate_route() {
    let lat = [45.0, 45.0];
    let lon = [7.0, 7.0];
    assert_eq!(simplify_by_distance(&lat, &lon, 16.0), vec![0, 1]);
}

#[test]
fn slugify_matches_python_vectors() {
    assert_eq!(slugify("Morning Hike"), "morning-hike");
    assert_eq!(slugify("  "), "imported-route");
}

#[test]
fn route_title_from_stem_matches_python_vectors() {
    assert_eq!(route_title_from_stem("morning_hike-1"), "Morning Hike 1");
    assert_eq!(route_title_from_stem(""), "Imported route");
}

#[test]
fn parse_gpx_reads_points() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("r.gpx");
    fs::write(
        &path,
        r#"<gpx><trk><trkseg><trkpt lat="45.0" lon="7.0"><ele>100</ele></trkpt><trkpt lat="45.1" lon="7.1"><ele>150</ele></trkpt></trkseg></trk></gpx>"#,
    )
    .unwrap();
    let track = parse_gpx(&path).unwrap();
    assert_eq!(track.lat, vec![45.0, 45.1]);
    assert_eq!(track.lon, vec![7.0, 7.1]);
    assert_eq!(track.ele, vec![100.0, 150.0]);
}

#[test]
fn parse_gpx_rejects_too_few_points() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("r.gpx");
    fs::write(
        &path,
        r#"<gpx><trkpt lat="45.0" lon="7.0"><ele>100</ele></trkpt></gpx>"#,
    )
    .unwrap();
    assert!(parse_gpx(&path).is_err());
}
