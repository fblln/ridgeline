use ridgeline_baker::gdal_io::{mem_dataset_4326, warp_cubic_4326};

// Regression guard for the GDAL MEM-init bug: GDAL MEM bands start at 0 and
// GDALReprojectImage only writes covered pixels, so without a NaN pre-fill the
// uncovered cells read as 0 (finite) — which made the Piemonte/IGN blend keep 0
// across the border instead of falling through to IGN. The warp must leave
// uncovered cells as NaN.
#[test]
fn warp_leaves_uncovered_cells_nan() {
    // Source covers lon[0,1] x lat[0,1], all elevation 100.
    let (sw, sh) = (8usize, 8usize);
    let src_gt = [0.0, 1.0 / sw as f64, 0.0, 1.0, 0.0, -(1.0 / sh as f64)];
    let src = mem_dataset_4326(&vec![100.0; sw * sh], sw, sh, src_gt).unwrap();

    // Target is twice as wide (lon[0,2]); the right half has no source data.
    let (tw, th) = (16usize, 8usize);
    let dst_gt = [0.0, 2.0 / tw as f64, 0.0, 1.0, 0.0, -(1.0 / th as f64)];
    let out = warp_cubic_4326(&src, dst_gt, tw, th).unwrap();

    let row = 4; // mid-row, away from top/bottom cubic edges
    // Left edge sits over the source -> finite, ~100.
    let left = out[row * tw];
    assert!(
        left.is_finite() && (left - 100.0).abs() < 1.0,
        "covered cell: {left}"
    );
    // Far-right column is well outside the source -> must be NaN, not 0.
    let right = out[row * tw + (tw - 1)];
    assert!(right.is_nan(), "uncovered cell should be NaN, got {right}");
}
