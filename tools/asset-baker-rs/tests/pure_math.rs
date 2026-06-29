//! Unit tests for the pure-math core shared by every bake: grid sampling/crop,
//! linspace, tile math, and value normalization. No network or GDAL.

use ridgeline_baker::grid::{Grid, linspace};
use ridgeline_baker::smooth::normalize_to_u8;
use ridgeline_baker::texture::deg2num;

#[test]
fn bilinear_interpolates_and_clamps() {
    // 2x2 grid: rows [0,10],[20,30].
    let g = Grid::from_vec(2, 2, vec![0.0, 10.0, 20.0, 30.0]).unwrap();
    // Exact corners.
    assert_eq!(g.bilinear(0.0, 0.0), 0.0);
    assert_eq!(g.bilinear(1.0, 1.0), 30.0);
    // Center is the mean of the four corners.
    assert_eq!(g.bilinear(0.5, 0.5), 15.0);
    // Midpoint of the top edge.
    assert_eq!(g.bilinear(0.0, 0.5), 5.0);
    // Out-of-range coordinates clamp to the edge rather than panicking.
    assert_eq!(g.bilinear(-1.0, -1.0), 0.0);
    assert_eq!(g.bilinear(5.0, 5.0), 30.0);
}

#[test]
fn crop_drops_the_pad_halo() {
    // 4x4 counting grid; crop pad=1 -> the inner 2x2.
    let data: Vec<f64> = (0..16).map(|v| v as f64).collect();
    let cropped = Grid::from_vec(4, 4, data).unwrap().crop(1);
    assert_eq!((cropped.width, cropped.height), (2, 2));
    assert_eq!(cropped.data, vec![5.0, 6.0, 9.0, 10.0]);
    // pad=0 is identity.
    let g = Grid::from_vec(2, 1, vec![1.0, 2.0]).unwrap();
    assert_eq!(g.crop(0).data, vec![1.0, 2.0]);
}

#[test]
fn finite_min_max_ignores_nan() {
    let g = Grid::from_vec(2, 2, vec![3.0, f64::NAN, 1.0, 5.0]).unwrap();
    assert_eq!(g.finite_min_max(), (1.0, 5.0));
    // All-NaN falls back to (0, 0) rather than (inf, -inf).
    let all_nan = Grid::new(2, 2, f64::NAN);
    assert_eq!(all_nan.finite_min_max(), (0.0, 0.0));
}

#[test]
fn linspace_endpoints_inclusive() {
    assert_eq!(linspace(0.0, 1.0, 5), vec![0.0, 0.25, 0.5, 0.75, 1.0]);
    assert_eq!(linspace(2.0, 2.0, 1), vec![2.0]);
    assert!(linspace(0.0, 1.0, 0).is_empty());
}

#[test]
fn normalize_to_u8_scales_and_clamps() {
    // Explicit lo/hi maps the range onto 0..=255 and clamps out-of-range values.
    let out = normalize_to_u8(&[0.0, 50.0, 100.0, 150.0, -10.0], Some(0.0), Some(100.0));
    assert_eq!(out, vec![0, 128, 255, 255, 0]);
    // Degenerate lo==hi must not divide by zero.
    let flat = normalize_to_u8(&[5.0, 5.0], Some(5.0), Some(5.0));
    assert_eq!(flat.len(), 2);
}

#[test]
fn deg2num_matches_known_tile() {
    // Web-Mercator XYZ: lat 45.0, lon 7.0, zoom 8 -> tile x=132, y=92.
    let (x, y) = deg2num(45.0, 7.0, 8);
    assert_eq!((x.floor() as u32, y.floor() as u32), (132, 92));
    // Tile x grows eastward, y grows southward.
    let (x_e, _) = deg2num(45.0, 8.0, 8);
    let (_, y_s) = deg2num(44.0, 7.0, 8);
    assert!(x_e >= x && y_s >= y);
}
