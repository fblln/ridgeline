use std::fs;
use std::path::PathBuf;

use anyhow::Context;
use gdal::Dataset;
use gdal::spatial_ref::{AxisMappingStrategy, CoordTransform, SpatialRef};
use rayon::prelude::*;
use url::form_urlencoded;

use crate::cache;
use crate::config::Config;
use crate::fetch::{download, download_to};
use crate::gdal_io::{mem_dataset_4326, warp_cubic_4326};
use crate::grid::{Grid, linspace};

/// Mean Earth radius (m), used for the local equirectangular XY projection.
/// NOTE: the bbox/span helpers elsewhere use a flat `111_320 m/deg` constant
/// instead — two deliberately different Earth models. Both mirror the Python
/// baker exactly; don't "unify" one without re-checking output parity.
const R: f64 = 6_371_000.0;
const IGN_PROBE_RES: usize = 64;

/// One small WMS GetMap over the whole bbox; true if any cell carries real
/// elevation (IGN returns large-negative nodata outside France coverage).
fn ign_has_coverage(bounds: Bounds) -> anyhow::Result<bool> {
    let bbox = format!(
        "{},{},{},{}",
        bounds.lo_lo, bounds.la_lo, bounds.lo_hi, bounds.la_hi
    );
    let query = form_urlencoded::Serializer::new(String::new())
        .append_pair("SERVICE", "WMS")
        .append_pair("VERSION", "1.3.0")
        .append_pair("REQUEST", "GetMap")
        .append_pair("STYLES", "")
        .append_pair("LAYERS", "ELEVATION.ELEVATIONGRIDCOVERAGE.HIGHRES")
        .append_pair("CRS", "CRS:84")
        .append_pair("BBOX", &bbox)
        .append_pair("WIDTH", &IGN_PROBE_RES.to_string())
        .append_pair("HEIGHT", &IGN_PROBE_RES.to_string())
        .append_pair("FORMAT", "image/x-bil;bits=32")
        .finish();
    let url = format!("https://data.geopf.fr/wms-r/wms?{query}");
    let bytes = download(&url, &[], 30)?;
    // A non-BIL error body just reads as noise -> at worst a false "covered",
    // which falls through to the normal full fetch. Only a genuine all-nodata
    // response (the dry case) reports no coverage. The 64x64 probe misses
    // sub-~100 m coverage slivers, which is fine for a fill source.
    Ok(bil_has_coverage(&bytes))
}

/// True if any 4-byte little-endian f32 sample carries real elevation. IGN
/// returns large-negative nodata (e.g. -99999) outside France coverage, so a
/// fully-dry response is all values `<= -1000`.
fn bil_has_coverage(bytes: &[u8]) -> bool {
    bytes.chunks_exact(4).any(|chunk| {
        let value = f32::from_le_bytes(chunk.try_into().expect("4 bytes"));
        value.is_finite() && value > -1000.0
    })
}

#[derive(Debug, Clone, Copy)]
pub struct Bounds {
    pub lo_lo: f64,
    pub lo_hi: f64,
    pub la_lo: f64,
    pub la_hi: f64,
}

#[derive(Debug, Clone)]
pub struct ElevationSource {
    pub kind: String,
    pub name: String,
    pub ign: Grid,
    pub piemonte: Option<PiemonteSource>,
}

#[derive(Debug, Clone)]
pub struct PiemonteSource {
    /// Path to the cached source DTM GeoTIFF (EPSG:32632); GDAL warps it directly.
    pub path: PathBuf,
}

pub fn grid_for_bounds(config: &Config, bounds: Bounds) -> (usize, f64, f64, f64) {
    let span_w_m = (bounds.lo_hi - bounds.lo_lo)
        * 111_320.0
        * ((bounds.la_lo + bounds.la_hi) / 2.0).to_radians().cos();
    let span_h_m = (bounds.la_hi - bounds.la_lo) * 111_320.0;
    let grid_size = config.grid.unwrap_or_else(|| {
        ((span_w_m.max(span_h_m) / config.target_res_m).round() as usize)
            .clamp(config.grid_min, config.grid_max)
    });
    let cell_m = span_w_m.max(span_h_m) / (grid_size.saturating_sub(1)).max(1) as f64;
    (grid_size, span_w_m, span_h_m, cell_m)
}

pub fn bbox_key(lat_raw: &[f64], lon_raw: &[f64], margin: f64) -> String {
    let lat_min = lat_raw.iter().copied().fold(f64::INFINITY, f64::min);
    let lat_max = lat_raw.iter().copied().fold(f64::NEG_INFINITY, f64::max);
    let lon_min = lon_raw.iter().copied().fold(f64::INFINITY, f64::min);
    let lon_max = lon_raw.iter().copied().fold(f64::NEG_INFINITY, f64::max);
    format!("{lat_min:.3}_{lat_max:.3}_{lon_min:.3}_{lon_max:.3}_m{margin:.4}")
}

pub fn bounds_from_smoothed(lat: &[f64], lon: &[f64], margin: f64) -> Bounds {
    Bounds {
        lo_lo: lon.iter().copied().fold(f64::INFINITY, f64::min) - margin,
        lo_hi: lon.iter().copied().fold(f64::NEG_INFINITY, f64::max) + margin,
        la_lo: lat.iter().copied().fold(f64::INFINITY, f64::min) - margin,
        la_hi: lat.iter().copied().fold(f64::NEG_INFINITY, f64::max) + margin,
    }
}

pub fn meshgrid(bounds: Bounds, grid_size: usize) -> (Vec<f64>, Vec<f64>, Vec<f64>, Vec<f64>) {
    let glat = linspace(bounds.la_lo, bounds.la_hi, grid_size);
    let glon = linspace(bounds.lo_lo, bounds.lo_hi, grid_size);
    let mut lon = Vec::with_capacity(grid_size * grid_size);
    let mut lat = Vec::with_capacity(grid_size * grid_size);
    for &a in &glat {
        for &o in &glon {
            lon.push(o);
            lat.push(a);
        }
    }
    (glon, glat, lon, lat)
}

pub fn build_elevation_source(
    config: &Config,
    bounds: Bounds,
    cache_key: &str,
) -> anyhow::Result<ElevationSource> {
    fs::create_dir_all(&config.cache_dir)?;
    let ign = fetch_ign_grid(config, bounds, cache_key)?;
    if config.dem_source.to_lowercase() == "ign" {
        return Ok(ElevationSource {
            kind: "ign".to_string(),
            name: "IGN LiDAR HD / RGE ALTI".to_string(),
            ign,
            piemonte: None,
        });
    }

    match fetch_piemonte_dtm(config, bounds, cache_key) {
        Ok(piemonte) => Ok(ElevationSource {
            kind: "mixed".to_string(),
            name: "Piemonte ICE 2009-2011 DTM 5m + IGN LiDAR HD fill".to_string(),
            ign,
            piemonte: Some(piemonte),
        }),
        Err(error) => {
            eprintln!("  Piemonte DTM unavailable, falling back to IGN-only: {error:#}");
            Ok(ElevationSource {
                kind: "ign".to_string(),
                name: "IGN LiDAR HD / RGE ALTI".to_string(),
                ign,
                piemonte: None,
            })
        }
    }
}

/// Best-effort: download the IGN grid into the disk cache so a later
/// `build_elevation_source` (the authoritative reader) hits warm cache. Errors
/// are intentionally swallowed by the caller — the authoritative path re-runs.
pub fn warm_ign_cache(config: &Config, bounds: Bounds, cache_key: &str) -> anyhow::Result<()> {
    fs::create_dir_all(&config.cache_dir)?;
    fetch_ign_grid(config, bounds, cache_key).map(|_| ())
}

/// Best-effort: download the Piemonte DTM GeoTIFF into the disk cache.
pub fn warm_piemonte_cache(config: &Config, bounds: Bounds, cache_key: &str) -> anyhow::Result<()> {
    fs::create_dir_all(&config.cache_dir)?;
    fetch_piemonte_dtm(config, bounds, cache_key).map(|_| ())
}

pub fn sample_elevation(
    lon: &[f64],
    _lat: &[f64],
    bounds: Bounds,
    source: &ElevationSource,
) -> anyhow::Result<Grid> {
    // DEM sampling is a GDAL cubic reproject onto the target grid, identical to
    // the Python baker's rasterio.reproject(resampling=cubic, tolerance=0) — both
    // call GDALReprojectImage with the exact transformer, so they match bit-for-
    // bit. Each source warps independently; Piemonte is primary, IGN fills its
    // nodata holes. (GDAL anti-aliases on downsampling, unlike point sampling.)
    let n = (lon.len() as f64).sqrt() as usize;
    let (width, height) = (n, n);
    let dst_gt = node_transform(bounds, width, height);

    // IGN grid (north-up, EPSG:4326) wrapped as a GDAL source, then warped.
    let ign_gt = pixel_transform(bounds, source.ign.width, source.ign.height);
    let ign_ds = mem_dataset_4326(
        &source.ign.data,
        source.ign.width,
        source.ign.height,
        ign_gt,
    )?;
    let ign_warp = warp_cubic_4326(&ign_ds, dst_gt, width, height)?;

    let mut values = if let Some(piemonte) = &source.piemonte {
        let pie_ds = Dataset::open(&piemonte.path)
            .with_context(|| format!("opening {}", piemonte.path.display()))?;
        let pie_warp = warp_cubic_4326(&pie_ds, dst_gt, width, height)?;
        pie_warp
            .iter()
            .zip(&ign_warp)
            .map(|(&p, &i)| if p.is_finite() { p } else { i })
            .collect::<Vec<_>>()
    } else {
        ign_warp
    };

    // Warp output is north-up; flip to south-up (row 0 = la_lo) to match the
    // meshgrid/heights convention used everywhere downstream.
    values = flip_rows(values, width, height);

    // Both sources gapped: flatten remaining NaNs to the lowest known elevation.
    let finite_min = values
        .iter()
        .copied()
        .filter(|v| v.is_finite())
        .fold(f64::INFINITY, f64::min);
    let fill = if finite_min.is_finite() {
        finite_min
    } else {
        0.0
    };
    for value in &mut values {
        if !value.is_finite() {
            *value = fill;
        }
    }
    Grid::from_vec(width, height, values)
}

/// North-up geo-transform whose pixel centers sit on the lon/lat grid nodes
/// (linspace endpoints inclusive) — the node-based target the mesh expects.
fn node_transform(bounds: Bounds, nx: usize, ny: usize) -> [f64; 6] {
    let px = (bounds.lo_hi - bounds.lo_lo) / (nx.max(2) - 1) as f64;
    let py = (bounds.la_hi - bounds.la_lo) / (ny.max(2) - 1) as f64;
    [
        bounds.lo_lo - px / 2.0,
        px,
        0.0,
        bounds.la_hi + py / 2.0,
        0.0,
        -py,
    ]
}

/// North-up geo-transform for a pixel-extent raster (corners = bbox) — the true
/// georeferencing of the WMS-fetched IGN grid.
fn pixel_transform(bounds: Bounds, nx: usize, ny: usize) -> [f64; 6] {
    let px = (bounds.lo_hi - bounds.lo_lo) / nx as f64;
    let py = (bounds.la_hi - bounds.la_lo) / ny as f64;
    [bounds.lo_lo, px, 0.0, bounds.la_hi, 0.0, -py]
}

fn flip_rows(data: Vec<f64>, width: usize, height: usize) -> Vec<f64> {
    let mut out = Vec::with_capacity(data.len());
    for row in (0..height).rev() {
        out.extend_from_slice(&data[row * width..(row + 1) * width]);
    }
    out
}

pub fn sample_grid_elevation(lon: f64, lat: f64, bounds: Bounds, heights: &Grid) -> f64 {
    let c = (lon - bounds.lo_lo) / (bounds.lo_hi - bounds.lo_lo) * (heights.width - 1) as f64;
    let r = (lat - bounds.la_lo) / (bounds.la_hi - bounds.la_lo) * (heights.height - 1) as f64;
    heights.bilinear(r, c)
}

pub fn local_xy(lon: f64, lat: f64, lat0_rad: f64, origin_lon: f64, origin_lat: f64) -> (f64, f64) {
    let x0 = R * origin_lon.to_radians() * lat0_rad.cos();
    let y0 = R * origin_lat.to_radians();
    let x = R * lon.to_radians() * lat0_rad.cos() - x0;
    let y = R * lat.to_radians() - y0;
    (x, y)
}

fn fetch_ign_grid(config: &Config, bounds: Bounds, cache_key: &str) -> anyhow::Result<Grid> {
    let wm = (bounds.lo_hi - bounds.lo_lo)
        * 111_320.0
        * ((bounds.la_lo + bounds.la_hi) / 2.0).to_radians().cos();
    let hm = (bounds.la_hi - bounds.la_lo) * 111_320.0;
    let width = (wm / config.dem_res_m).ceil().max(256.0) as usize;
    let height = (hm / config.dem_res_m).ceil().max(256.0) as usize;
    let cache = config.cache_dir.join(format!(
        "web_ignhd_{cache_key}_{:.2}m_{width}x{height}.{}",
        config.dem_res_m,
        cache::EXT
    ));
    if let Some(grid) =
        cache::read_grid(&cache).with_context(|| format!("reading {}", cache.display()))?
    {
        return Ok(grid);
    }

    // IGN HD only covers France. A border-adjacent Italian track would otherwise
    // download the full (here ~150 MB) all-nodata grid just to discard it, then
    // warp 38M NaN cells. One cheap 64x64 probe settles coverage first; when dry,
    // a tiny all-NaN grid is semantically identical to the old full all-NaN grid.
    if !ign_has_coverage(bounds)? {
        let dem = Grid::new(IGN_PROBE_RES, IGN_PROBE_RES, f64::NAN);
        println!("  ign: no coverage for this area (Piemonte DTM only)");
        cache::write_grid(&cache, &dem)?;
        return Ok(dem);
    }

    let tiles = (0..height)
        .step_by(config.wms_max)
        .flat_map(|y0| {
            (0..width).step_by(config.wms_max).map(move |x0| {
                (
                    x0,
                    (x0 + config.wms_max).min(width),
                    y0,
                    (y0 + config.wms_max).min(height),
                )
            })
        })
        .collect::<Vec<_>>();

    let fetch_pool = rayon::ThreadPoolBuilder::new()
        .num_threads(config.fetch_workers)
        .thread_name(|index| format!("fetch-dem-{index}"))
        .build()?;
    let fetched = fetch_pool.install(|| {
        tiles
            .par_iter()
            .map(|&(x0, x1, y0, y1)| -> anyhow::Result<_> {
                tracing::info_span!(
                    "dem-tile",
                    x0,
                    x1,
                    y0,
                    y1,
                    width = x1 - x0,
                    height = y1 - y0
                )
                .in_scope(|| {
                    let bbox = format!(
                        "{},{},{},{}",
                        bounds.lo_lo + (bounds.lo_hi - bounds.lo_lo) * (x0 as f64 / width as f64),
                        bounds.la_hi - (bounds.la_hi - bounds.la_lo) * (y1 as f64 / height as f64),
                        bounds.lo_lo + (bounds.lo_hi - bounds.lo_lo) * (x1 as f64 / width as f64),
                        bounds.la_hi - (bounds.la_hi - bounds.la_lo) * (y0 as f64 / height as f64),
                    );
                    let query = form_urlencoded::Serializer::new(String::new())
                        .append_pair("SERVICE", "WMS")
                        .append_pair("VERSION", "1.3.0")
                        .append_pair("REQUEST", "GetMap")
                        .append_pair("STYLES", "")
                        .append_pair("LAYERS", "ELEVATION.ELEVATIONGRIDCOVERAGE.HIGHRES")
                        .append_pair("CRS", "CRS:84")
                        .append_pair("BBOX", &bbox)
                        .append_pair("WIDTH", &(x1 - x0).to_string())
                        .append_pair("HEIGHT", &(y1 - y0).to_string())
                        .append_pair("FORMAT", "image/x-bil;bits=32")
                        .finish();
                    let url = format!("https://data.geopf.fr/wms-r/wms?{query}");
                    let bytes = download(&url, &[], 120)?;
                    let tile = bytes
                        .chunks_exact(4)
                        .map(|chunk| {
                            let value =
                                f32::from_le_bytes(chunk.try_into().expect("4 bytes")) as f64;
                            if value < -1000.0 { f64::NAN } else { value }
                        })
                        .collect::<Vec<_>>();
                    Ok(((x0, x1, y0, y1), tile))
                })
            })
            .collect::<anyhow::Result<Vec<_>>>()
    })?;

    let mut dem = Grid::new(width, height, f64::NAN);
    for ((x0, x1, y0, y1), tile) in fetched {
        for row in y0..y1 {
            let src = (row - y0) * (x1 - x0);
            let dst = row * width + x0;
            dem.data[dst..dst + (x1 - x0)].copy_from_slice(&tile[src..src + (x1 - x0)]);
        }
    }
    let valid = dem.data.iter().filter(|v| v.is_finite()).count();
    if valid > 0 {
        let min = dem
            .data
            .iter()
            .copied()
            .filter(|v| v.is_finite())
            .fold(f64::INFINITY, f64::min);
        for value in &mut dem.data {
            if !value.is_finite() {
                *value = min;
            }
        }
        println!("  ign: {valid}/{} cells covered", dem.data.len());
    } else {
        println!("  ign: no coverage for this area (Piemonte DTM only)");
    }
    cache::write_grid(&cache, &dem)?;
    Ok(dem)
}

fn fetch_piemonte_dtm(
    config: &Config,
    bounds: Bounds,
    cache_key: &str,
) -> anyhow::Result<PiemonteSource> {
    let path = config.cache_dir.join(format!("dtm5_{cache_key}.tif"));
    if !path.exists() {
        let corners = [
            lonlat_to_utm32(bounds.lo_lo, bounds.la_lo),
            lonlat_to_utm32(bounds.lo_hi, bounds.la_lo),
            lonlat_to_utm32(bounds.lo_lo, bounds.la_hi),
            lonlat_to_utm32(bounds.lo_hi, bounds.la_hi),
        ];
        let xmin = corners.iter().map(|p| p.0).fold(f64::INFINITY, f64::min);
        let xmax = corners
            .iter()
            .map(|p| p.0)
            .fold(f64::NEG_INFINITY, f64::max);
        let ymin = corners.iter().map(|p| p.1).fold(f64::INFINITY, f64::min);
        let ymax = corners
            .iter()
            .map(|p| p.1)
            .fold(f64::NEG_INFINITY, f64::max);
        let width = ((xmax - xmin) / 5.0).max(1.0) as usize;
        let height = ((ymax - ymin) / 5.0).max(1.0) as usize;
        let url = format!(
            "https://geomap.reteunitaria.piemonte.it/ws/taims/rp-01/taimsdtmwcs/wcs_ice_2009_2011_dtm?service=WCS&version=1.0.0&request=GetCoverage&coverage=DTM&crs=EPSG:32632&bbox={xmin},{ymin},{xmax},{ymax}&width={width}&height={height}&format=GEOTIFF_16"
        );
        download_to(&path, &url, &[], 180)?;
    }
    // GDAL warps the DTM straight from the file (geotransform + nodata handled
    // natively), so we only need to cache the path here.
    Ok(PiemonteSource { path })
}

// EPSG:4326 -> EPSG:32632 via GDAL's bundled PROJ — byte-identical to pyproj
// (rasterio/pyproj use the same PROJ). The transform is built once per thread
// (CoordTransform isn't Sync) and reused across the rayon-parallel hot path.
thread_local! {
    static UTM32: CoordTransform = {
        let mut src = SpatialRef::from_epsg(4326).expect("epsg:4326");
        let mut dst = SpatialRef::from_epsg(32632).expect("epsg:32632");
        // Force lon/lat, easting/northing ordering (GDAL 3 honors CRS axis order).
        src.set_axis_mapping_strategy(AxisMappingStrategy::TraditionalGisOrder);
        dst.set_axis_mapping_strategy(AxisMappingStrategy::TraditionalGisOrder);
        CoordTransform::new(&src, &dst).expect("4326->32632 transform")
    };
}

fn lonlat_to_utm32(lon: f64, lat: f64) -> (f64, f64) {
    // One point per call matches the existing call sites; batch via
    // transform_coords on slices if the per-point FFI ever shows up in a profile.
    UTM32.with(|ct| {
        let mut x = [lon];
        let mut y = [lat];
        let mut z = [0.0];
        ct.transform_coords(&mut x, &mut y, &mut z)
            .expect("utm32 transform");
        (x[0], y[0])
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use gdal::DriverManager;
    use gdal::raster::Buffer;

    fn bil(values: &[f32]) -> Vec<u8> {
        values.iter().flat_map(|v| v.to_le_bytes()).collect()
    }

    fn test_config() -> (tempfile::TempDir, Config) {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        let gpx = root.join("route.gpx");
        fs::write(&gpx, "<gpx><trk><trkseg><trkpt lat=\"45\" lon=\"7\"><ele>1</ele></trkpt><trkpt lat=\"45.001\" lon=\"7.001\"><ele>2</ele></trkpt></trkseg></trk></gpx>").unwrap();
        let out = root.join("out");
        fs::create_dir_all(&out).unwrap();
        let mut config = Config::from_paths(
            gpx,
            root.join("reference.png"),
            root.join("angles.png"),
            out,
        )
        .unwrap();
        config.cache_dir = root.join("cache");
        config.dem_res_m = 20_000.0;
        config.wms_max = 128;
        (dir, config)
    }

    fn ign_cache_path(config: &Config, bounds: Bounds, cache_key: &str) -> (PathBuf, usize, usize) {
        let wm = (bounds.lo_hi - bounds.lo_lo)
            * 111_320.0
            * ((bounds.la_lo + bounds.la_hi) / 2.0).to_radians().cos();
        let hm = (bounds.la_hi - bounds.la_lo) * 111_320.0;
        let width = (wm / config.dem_res_m).ceil().max(256.0) as usize;
        let height = (hm / config.dem_res_m).ceil().max(256.0) as usize;
        let path = config.cache_dir.join(format!(
            "web_ignhd_{cache_key}_{:.2}m_{width}x{height}.{}",
            config.dem_res_m,
            cache::EXT
        ));
        (path, width, height)
    }

    fn write_piemonte_tif(path: &std::path::Path, bounds: Bounds) {
        let corners = [
            lonlat_to_utm32(bounds.lo_lo, bounds.la_lo),
            lonlat_to_utm32(bounds.lo_hi, bounds.la_lo),
            lonlat_to_utm32(bounds.lo_lo, bounds.la_hi),
            lonlat_to_utm32(bounds.lo_hi, bounds.la_hi),
        ];
        let xmin = corners.iter().map(|p| p.0).fold(f64::INFINITY, f64::min);
        let xmax = corners
            .iter()
            .map(|p| p.0)
            .fold(f64::NEG_INFINITY, f64::max);
        let ymin = corners.iter().map(|p| p.1).fold(f64::INFINITY, f64::min);
        let ymax = corners
            .iter()
            .map(|p| p.1)
            .fold(f64::NEG_INFINITY, f64::max);
        let (width, height) = (64usize, 64usize);
        let px = (xmax - xmin) / width as f64;
        let py = (ymax - ymin) / height as f64;
        let driver = DriverManager::get_driver_by_name("GTiff").unwrap();
        let mut ds = driver
            .create_with_band_type::<f64, _>(path, width, height, 1)
            .unwrap();
        ds.set_geo_transform(&[xmin, px, 0.0, ymax, 0.0, -py])
            .unwrap();
        let mut srs = SpatialRef::from_epsg(32632).unwrap();
        srs.set_axis_mapping_strategy(AxisMappingStrategy::TraditionalGisOrder);
        ds.set_spatial_ref(&srs).unwrap();
        let mut band = ds.rasterband(1).unwrap();
        band.set_no_data_value(Some(-9999.0)).unwrap();
        let mut data = Vec::with_capacity(width * height);
        for _row in 0..height {
            for col in 0..width {
                data.push(if col < width / 2 { -9999.0 } else { 500.0 });
            }
        }
        let mut buffer = Buffer::new((width, height), data);
        band.write((0, 0), (width, height), &mut buffer).unwrap();
    }

    #[test]
    fn coverage_predicate_dry_vs_covered() {
        // Fully nodata (IGN large-negative sentinel) -> no coverage.
        assert!(!bil_has_coverage(&bil(&[-99999.0, -99999.0, -99999.0])));
        // Any real elevation among nodata -> covered.
        assert!(bil_has_coverage(&bil(&[-99999.0, 1500.0, -99999.0])));
        // Sea level (0 m) counts as real coverage; -1000 boundary is nodata.
        assert!(bil_has_coverage(&bil(&[0.0])));
        assert!(!bil_has_coverage(&bil(&[-1000.0])));
        // Empty / no full samples -> no coverage (never a false positive).
        assert!(!bil_has_coverage(&[]));
        assert!(!bil_has_coverage(&[0x00, 0x01, 0x02]));
    }

    #[test]
    fn flip_rows_reverses_row_order() {
        // 2x3: rows [0,1,2],[3,4,5] -> [3,4,5],[0,1,2]
        let flipped = flip_rows(vec![0.0, 1.0, 2.0, 3.0, 4.0, 5.0], 3, 2);
        assert_eq!(flipped, vec![3.0, 4.0, 5.0, 0.0, 1.0, 2.0]);
    }

    fn unit_bounds() -> Bounds {
        Bounds {
            lo_lo: 0.0,
            lo_hi: 1.0,
            la_lo: 0.0,
            la_hi: 1.0,
        }
    }

    #[test]
    fn local_xy_is_zero_at_origin_and_grows_east_north() {
        let lat0 = 45.0_f64.to_radians();
        assert_eq!(local_xy(7.0, 45.0, lat0, 7.0, 45.0), (0.0, 0.0));
        let (x, y) = local_xy(7.1, 45.1, lat0, 7.0, 45.0);
        assert!(x > 0.0 && y > 0.0);
    }

    #[test]
    fn sample_grid_elevation_reads_the_terrain() {
        // value == row index; elevation rises with latitude (row maps to lat).
        let data: Vec<f64> = (0..3).flat_map(|r| vec![r as f64; 3]).collect();
        let heights = Grid::from_vec(3, 3, data).unwrap();
        let b = unit_bounds();
        assert!((sample_grid_elevation(0.5, 0.0, b, &heights) - 0.0).abs() < 1e-9);
        assert!((sample_grid_elevation(0.5, 1.0, b, &heights) - 2.0).abs() < 1e-9);
        assert!((sample_grid_elevation(0.5, 0.5, b, &heights) - 1.0).abs() < 1e-9);
    }

    #[test]
    fn bbox_key_is_stable_and_rounded() {
        let key = bbox_key(&[45.1234, 45.6789], &[7.1111, 7.9999], 0.0025);
        assert_eq!(key, "45.123_45.679_7.111_8.000_m0.0025");
    }

    #[test]
    fn geotransforms_match_bbox() {
        let b = Bounds {
            lo_lo: 0.0,
            lo_hi: 2.0,
            la_lo: 0.0,
            la_hi: 2.0,
        };
        // Pixel-extent raster: corners = bbox, north-up (negative y step).
        assert_eq!(pixel_transform(b, 2, 2), [0.0, 1.0, 0.0, 2.0, 0.0, -1.0]);
        // Node-centred raster: pixel centres land on the grid nodes.
        assert_eq!(node_transform(b, 2, 2), [-1.0, 2.0, 0.0, 3.0, 0.0, -2.0]);
    }

    #[test]
    fn meshgrid_shapes_and_corners() {
        let b = unit_bounds();
        let (glon, glat, lon, lat) = meshgrid(b, 3);
        assert_eq!(glon.len(), 3);
        assert_eq!(glat.len(), 3);
        assert_eq!(lon.len(), 9);
        assert_eq!(lat.len(), 9);
        assert_eq!((lon[0], lat[0]), (0.0, 0.0)); // SW corner
        assert_eq!((lon[8], lat[8]), (1.0, 1.0)); // NE corner
    }

    #[test]
    fn grid_for_bounds_honors_override_and_clamps() {
        let dummy = std::path::PathBuf::from("/tmp/x.gpx");
        let mut config =
            Config::from_paths(dummy.clone(), dummy.clone(), dummy.clone(), dummy).unwrap();
        config.grid = Some(900);
        assert_eq!(grid_for_bounds(&config, unit_bounds()).0, 900);
        // Tiny bbox without an override clamps up to grid_min.
        config.grid = None;
        config.grid_min = 700;
        config.grid_max = 3000;
        let tiny = Bounds {
            lo_lo: 7.0,
            lo_hi: 7.001,
            la_lo: 45.0,
            la_hi: 45.001,
        };
        assert_eq!(grid_for_bounds(&config, tiny).0, 700);
    }

    #[test]
    fn lonlat_to_utm32_lands_in_zone() {
        // 7E/45N is west of the zone-32 central meridian (9E) -> easting < 500k.
        let (e, n) = lonlat_to_utm32(7.0, 45.0);
        assert!((200_000.0..500_000.0).contains(&e), "easting {e}");
        assert!((4_000_000.0..5_500_000.0).contains(&n), "northing {n}");
    }

    #[test]
    fn fetch_ign_grid_uses_cached_grid() {
        let (_dir, config) = test_config();
        let bounds = Bounds {
            lo_lo: 7.0,
            lo_hi: 7.02,
            la_lo: 45.0,
            la_hi: 45.02,
        };
        let cache_key = "cached";
        let (path, width, height) = ign_cache_path(&config, bounds, cache_key);
        cache::write_grid(&path, &Grid::new(width, height, 123.0)).unwrap();
        let grid = fetch_ign_grid(&config, bounds, cache_key).unwrap();
        assert_eq!((grid.width, grid.height), (width, height));
        assert!(grid.data.iter().all(|&value| value == 123.0));
        warm_ign_cache(&config, bounds, cache_key).unwrap();
    }

    #[test]
    fn build_elevation_source_uses_cached_piemonte_file() {
        let (_dir, mut config) = test_config();
        config.dem_source = "mixed".to_string();
        let bounds = Bounds {
            lo_lo: 7.0,
            lo_hi: 7.02,
            la_lo: 45.0,
            la_hi: 45.02,
        };
        let cache_key = "mixed";
        let (ign_path, width, height) = ign_cache_path(&config, bounds, cache_key);
        cache::write_grid(&ign_path, &Grid::new(width, height, 100.0)).unwrap();
        let dtm_path = config.cache_dir.join(format!("dtm5_{cache_key}.tif"));
        write_piemonte_tif(&dtm_path, bounds);

        let source = build_elevation_source(&config, bounds, cache_key).unwrap();
        assert_eq!(source.kind, "mixed");
        assert_eq!(
            source.name,
            "Piemonte ICE 2009-2011 DTM 5m + IGN LiDAR HD fill"
        );
        assert!(source.piemonte.is_some());
        warm_piemonte_cache(&config, bounds, cache_key).unwrap();
    }

    #[test]
    fn sample_elevation_blends_piemonte_and_ign() {
        let (_dir, config) = test_config();
        let bounds = Bounds {
            lo_lo: 7.0,
            lo_hi: 7.02,
            la_lo: 45.0,
            la_hi: 45.02,
        };
        let (_, _, lon, lat) = meshgrid(bounds, 32);
        let dtm_path = config.cache_dir.join("dtm5_blend.tif");
        fs::create_dir_all(&config.cache_dir).unwrap();
        write_piemonte_tif(&dtm_path, bounds);
        let source = ElevationSource {
            kind: "mixed".to_string(),
            name: "mixed".to_string(),
            ign: Grid::new(64, 64, 100.0),
            piemonte: Some(PiemonteSource { path: dtm_path }),
        };
        let grid = sample_elevation(&lon, &lat, bounds, &source).unwrap();
        let (min, max) = grid.finite_min_max();
        assert!(min <= 120.0, "min={min}");
        assert!(max >= 450.0, "max={max}");
        assert!(grid.data.iter().all(|value| value.is_finite()));
    }
}
