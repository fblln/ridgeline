use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};

use gdal::DriverManager;
use gdal::raster::Buffer;
use gdal::spatial_ref::{AxisMappingStrategy, SpatialRef};
use image::{GrayImage, Luma, Rgb, RgbImage};
use ridgeline_baker::cache;
use ridgeline_baker::config::Config;
use ridgeline_baker::dem::{Bounds, bbox_key, bounds_from_smoothed, grid_for_bounds};
use ridgeline_baker::gpx::{Track, parse_gpx};
use ridgeline_baker::grid::Grid;
use ridgeline_baker::smooth::savgol_smooth;
use ridgeline_baker::texture::deg2num;
use ridgeline_baker::{run, run_with_stdout_progress};

fn run_lock() -> &'static Mutex<()> {
    static LOCK: OnceLock<Mutex<()>> = OnceLock::new();
    LOCK.get_or_init(|| Mutex::new(()))
}

fn fixture_gpx() -> PathBuf {
    let relative = Path::new("examples/gpx/Escursione_mattutina.gpx");
    for ancestor in Path::new(env!("CARGO_MANIFEST_DIR")).ancestors() {
        let candidate = ancestor.join(relative);
        if candidate.exists() {
            return candidate;
        }
    }
    if let Some(root) = std::env::var_os("RIDGELINE_REPO_ROOT") {
        let candidate = PathBuf::from(root).join(relative);
        if candidate.exists() {
            return candidate;
        }
    }
    panic!("could not locate {}", relative.display());
}

fn topo_tile_extent(bounds: Bounds, zoom: u8) -> (u32, u32, u32, u32) {
    let (x_w, y_n) = deg2num(bounds.la_hi, bounds.lo_lo, zoom);
    let (x_e, y_s) = deg2num(bounds.la_lo, bounds.lo_hi, zoom);
    (
        x_w.floor() as u32,
        x_e.floor() as u32,
        y_n.floor() as u32,
        y_s.floor() as u32,
    )
}

fn subset_track(track: &Track, points: usize) -> Track {
    let len = points.min(track.lat.len()).max(2);
    Track {
        lat: track.lat[..len].to_vec(),
        lon: track.lon[..len].to_vec(),
        ele: track.ele[..len].to_vec(),
    }
}

fn write_track(path: &Path, track: &Track) {
    let mut xml = String::from("<gpx><trk><trkseg>");
    for ((lat, lon), ele) in track.lat.iter().zip(&track.lon).zip(&track.ele) {
        xml.push_str(&format!(
            "<trkpt lat=\"{lat}\" lon=\"{lon}\"><ele>{ele}</ele></trkpt>"
        ));
    }
    xml.push_str("</trkseg></trk></gpx>");
    fs::write(path, xml).unwrap();
}

fn build_config(root: &Path, gpx_path: PathBuf) -> Config {
    let out = root.join("out");
    fs::create_dir_all(&out).unwrap();
    let mut config = Config::from_paths(
        gpx_path,
        root.join("reference.png"),
        root.join("angles.png"),
        out,
    )
    .unwrap();
    config.cache_dir = root.join("cache");
    config.fetch_workers = 2;
    config.compute_threads = 1;
    config.edge_pad = 4;
    config.forest_px = 64;
    config.forest_min_tcd = 45.0;
    config.texture_sat = 1.0;
    config.texture_bright = 1.0;
    config.texture_contrast = 1.0;
    config
}

fn prepare_bounds(track: &Track, margin: f64) -> Bounds {
    let lat = savgol_smooth(&track.lat, 15);
    let lon = savgol_smooth(&track.lon, 15);
    bounds_from_smoothed(&lat, &lon, margin)
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

fn seed_ign_cache(config: &Config, bounds: Bounds, cache_key: &str) {
    let (path, width, height) = ign_cache_path(config, bounds, cache_key);
    let mut data = Vec::with_capacity(width * height);
    for row in 0..height {
        for col in 0..width {
            data.push(
                900.0 + (col as f64 / width as f64) * 250.0 + (row as f64 / height as f64) * 120.0,
            );
        }
    }
    cache::write_grid(&path, &Grid::from_vec(width, height, data).unwrap()).unwrap();
}

fn lonlat_to_utm32(lon: f64, lat: f64) -> (f64, f64) {
    let mut src = SpatialRef::from_epsg(4326).unwrap();
    let mut dst = SpatialRef::from_epsg(32632).unwrap();
    src.set_axis_mapping_strategy(AxisMappingStrategy::TraditionalGisOrder);
    dst.set_axis_mapping_strategy(AxisMappingStrategy::TraditionalGisOrder);
    let transform = gdal::spatial_ref::CoordTransform::new(&src, &dst).unwrap();
    let mut x = [lon];
    let mut y = [lat];
    let mut z = [0.0];
    transform.transform_coords(&mut x, &mut y, &mut z).unwrap();
    (x[0], y[0])
}

fn seed_piemonte_cache(config: &Config, bounds: Bounds, cache_key: &str) {
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
    let width = 160usize;
    let height = 160usize;
    let path = config.cache_dir.join(format!("dtm5_{cache_key}.tif"));
    fs::create_dir_all(path.parent().unwrap()).unwrap();
    let driver = DriverManager::get_driver_by_name("GTiff").unwrap();
    let mut ds = driver
        .create_with_band_type::<f64, _>(&path, width, height, 1)
        .unwrap();
    ds.set_geo_transform(&[
        xmin,
        (xmax - xmin) / width as f64,
        0.0,
        ymax,
        0.0,
        -((ymax - ymin) / height as f64),
    ])
    .unwrap();
    let mut srs = SpatialRef::from_epsg(32632).unwrap();
    srs.set_axis_mapping_strategy(AxisMappingStrategy::TraditionalGisOrder);
    ds.set_spatial_ref(&srs).unwrap();
    let mut band = ds.rasterband(1).unwrap();
    band.set_no_data_value(Some(-9999.0)).unwrap();
    let mut data = Vec::with_capacity(width * height);
    for row in 0..height {
        for col in 0..width {
            let hole = col < width / 5 && row > height / 4 && row < height * 3 / 4;
            data.push(if hole {
                -9999.0
            } else {
                1200.0 + (col as f64 / width as f64) * 320.0
            });
        }
    }
    let mut buffer = Buffer::new((width, height), data);
    band.write((0, 0), (width, height), &mut buffer).unwrap();
}

fn seed_topo_tiles(config: &Config, bounds: Bounds) {
    let (tx0, tx1, ty0, ty1) = topo_tile_extent(bounds, config.tile_zoom);
    let cache = config.cache_dir.join("otm");
    fs::create_dir_all(&cache).unwrap();
    for tx in tx0..=tx1 {
        for ty in ty0..=ty1 {
            let tile = RgbImage::from_fn(256, 256, |x, y| {
                Rgb([(tx % 255) as u8, (ty % 255) as u8, ((x ^ y) % 255) as u8])
            });
            tile.save(cache.join(format!("{}_{}_{}.png", config.tile_zoom, tx, ty)))
                .unwrap();
        }
    }
}

fn seed_forest_cache(config: &Config, bounds: Bounds) {
    let px = config.forest_px;
    let wm = (bounds.lo_hi - bounds.lo_lo)
        * 111_320.0
        * ((bounds.la_lo + bounds.la_hi) / 2.0).to_radians().cos();
    let hm = (bounds.la_hi - bounds.la_lo) * 111_320.0;
    let width = px;
    let height = ((px as f64 * hm / wm).round().max(1.0)) as u32;
    let path = config.cache_dir.join(format!(
        "forest_{:.4}_{:.4}_{:.4}_{:.4}_{width}x{height}.tif",
        bounds.lo_lo, bounds.la_lo, bounds.lo_hi, bounds.la_hi
    ));
    fs::create_dir_all(path.parent().unwrap()).unwrap();
    GrayImage::from_fn(width, height, |x, _| {
        let value = if x < width / 3 {
            25
        } else if x < width * 2 / 3 {
            65
        } else {
            90
        };
        Luma([value as u8])
    })
    .save(path)
    .unwrap();
}

fn seed_border_cache(config: &Config, bounds: Bounds, cache_key: &str) {
    fs::create_dir_all(&config.cache_dir).unwrap();
    let mid_lon = (bounds.lo_lo + bounds.lo_hi) / 2.0;
    let mid_lat = (bounds.la_lo + bounds.la_hi) / 2.0;
    fs::write(
        config.cache_dir.join(format!("border_{cache_key}.geojson")),
        serde_json::json!({
            "type": "FeatureCollection",
            "features": [
                {
                    "type": "Feature",
                    "geometry": {
                        "type": "LineString",
                        "coordinates": [
                            [bounds.lo_lo, bounds.la_lo],
                            [mid_lon, mid_lat],
                            [bounds.lo_hi, bounds.la_hi]
                        ]
                    }
                }
            ]
        })
        .to_string(),
    )
    .unwrap();
}

fn prepare_offline_inputs(
    config: &Config,
    track: &Track,
    with_piemonte: bool,
    with_reference_assets: bool,
) -> (Bounds, String) {
    let bounds = prepare_bounds(track, config.margin);
    let (grid_size, _, _, _) = grid_for_bounds(config, bounds);
    let pad = config.edge_pad;
    let dlon = (bounds.lo_hi - bounds.lo_lo) / (grid_size.max(2) - 1) as f64;
    let dlat = (bounds.la_hi - bounds.la_lo) / (grid_size.max(2) - 1) as f64;
    let pbounds = Bounds {
        lo_lo: bounds.lo_lo - pad as f64 * dlon,
        lo_hi: bounds.lo_hi + pad as f64 * dlon,
        la_lo: bounds.la_lo - pad as f64 * dlat,
        la_hi: bounds.la_hi + pad as f64 * dlat,
    };
    let cache_key = format!("{}_p{pad}", bbox_key(&track.lat, &track.lon, config.margin));
    seed_ign_cache(config, pbounds, &cache_key);
    if with_piemonte {
        seed_piemonte_cache(config, pbounds, &cache_key);
    }
    seed_topo_tiles(config, bounds);
    seed_forest_cache(config, bounds);
    seed_border_cache(config, bounds, &cache_key);
    if with_reference_assets {
        RgbImage::from_pixel(1200, 800, Rgb([20, 30, 40]))
            .save(&config.reference_path)
            .unwrap();
        RgbImage::from_pixel(600, 300, Rgb([40, 50, 60]))
            .save(&config.angles_path)
            .unwrap();
    }
    (bounds, cache_key)
}

fn read_json(path: &Path) -> serde_json::Value {
    serde_json::from_slice(&fs::read(path).unwrap()).unwrap()
}

#[test]
fn simple_real_gpx_bake_runs_offline() {
    let _guard = run_lock().lock().unwrap_or_else(|error| error.into_inner());
    let fixture = parse_gpx(&fixture_gpx()).unwrap();
    let track = subset_track(&fixture, 96);
    let dir = tempfile::tempdir().unwrap();
    let gpx_path = dir.path().join("simple.gpx");
    write_track(&gpx_path, &track);
    let mut config = build_config(dir.path(), gpx_path);
    config.grid = Some(96);
    config.dem_source = "ign".to_string();
    config.dem_res_m = 90.0;
    config.tile_zoom = 10;
    config.texture_max = 128;

    prepare_offline_inputs(&config, &track, false, false);
    run_with_stdout_progress(config.clone()).unwrap();

    let manifest = read_json(&config.out_dir.join("manifest.json"));
    let route = read_json(&config.out_dir.join("route.json"));
    let terrain = read_json(&config.out_dir.join("terrain.json"));
    assert_eq!(manifest["terrain"]["demSource"], "ign");
    assert!(manifest["reference"]["angles"].is_null());
    assert_eq!(route["pointCount"], 96);
    assert_eq!(terrain["gridSize"], 96);
    assert_eq!(terrain["heights"].as_array().unwrap().len(), 96 * 96);
    assert!(config.out_dir.join("heightmap.png").exists());
    assert!(config.out_dir.join("terrain-forest.png").exists());
}

#[test]
fn medium_real_gpx_bake_runs_with_mixed_dem_and_optional_assets() {
    let _guard = run_lock().lock().unwrap_or_else(|error| error.into_inner());
    let fixture = parse_gpx(&fixture_gpx()).unwrap();
    let track = subset_track(&fixture, 4096);
    let dir = tempfile::tempdir().unwrap();
    let gpx_path = dir.path().join("medium.gpx");
    write_track(&gpx_path, &track);
    let mut config = build_config(dir.path(), gpx_path);
    config.grid = Some(256);
    config.dem_source = "mixed".to_string();
    config.dem_res_m = 80.0;
    config.tile_zoom = 11;
    config.texture_max = 256;

    prepare_offline_inputs(&config, &track, true, true);
    let progress = Mutex::new(Vec::new());
    run(config.clone(), |pct, label| {
        progress.lock().unwrap().push((pct, label.to_string()));
    })
    .unwrap();

    let progress = progress.lock().unwrap();
    assert_eq!(
        progress.as_slice(),
        &[
            (8, "Reading GPX track".to_string()),
            (22, "Fetching elevation (DEM)".to_string()),
            (58, "Sampling route & terrain".to_string()),
            (70, "Building map textures".to_string()),
            (82, "Rendering relief & slope".to_string()),
            (90, "Adding forest layer".to_string()),
            (97, "Finalizing assets".to_string()),
        ]
    );

    let manifest = read_json(&config.out_dir.join("manifest.json"));
    let route = read_json(&config.out_dir.join("route.json"));
    assert_eq!(manifest["terrain"]["demSource"], "mixed");
    assert_eq!(manifest["reference"]["angles"], "angle-sheet.png");
    assert_eq!(manifest["terrain"]["forestTexture"], "terrain-forest.png");
    assert_eq!(manifest["overlays"]["border"], "border.json");
    assert_eq!(route["pointCount"], 4096);
    assert!(route["displayPointCount"].as_u64().unwrap() < 4096);
}

#[test]
fn complex_real_gpx_bake_handles_full_fixture_large_outputs() {
    let _guard = run_lock().lock().unwrap_or_else(|error| error.into_inner());
    let track = parse_gpx(&fixture_gpx()).unwrap();
    let dir = tempfile::tempdir().unwrap();
    let mut config = build_config(dir.path(), fixture_gpx());
    config.grid = Some(512);
    config.dem_source = "mixed".to_string();
    config.dem_res_m = 60.0;
    config.tile_zoom = 11;
    config.texture_max = 512;
    config.bake_relief = true;
    config.dem_contours = true;

    prepare_offline_inputs(&config, &track, true, false);
    run(config.clone(), |_, _| {}).unwrap();

    let route = read_json(&config.out_dir.join("route.json"));
    let terrain = read_json(&config.out_dir.join("terrain.json"));
    let manifest = read_json(&config.out_dir.join("manifest.json"));
    let texture = image::open(config.out_dir.join("terrain-texture.png"))
        .unwrap()
        .to_rgb8();
    assert!(route["pointCount"].as_u64().unwrap() > 20_000);
    assert!(route["displayPointCount"].as_u64().unwrap() > 1_000);
    assert_eq!(terrain["gridSize"], 512);
    assert_eq!(terrain["heights"].as_array().unwrap().len(), 512 * 512);
    assert!(texture.width() > 0);
    assert!(texture.height() > 0);
    assert_eq!(manifest["terrain"]["demSource"], "mixed");
    assert!(config.out_dir.join("reference-preview.jpg").exists());
    assert!(config.out_dir.join("terrain-normal.png").exists());
    assert!(config.out_dir.join("border.json").exists());
}
