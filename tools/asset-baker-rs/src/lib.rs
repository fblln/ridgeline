pub mod cache;
pub mod config;
pub mod dem;
pub mod fetch;
pub mod gdal_io;
pub mod gpx;
pub mod grid;
pub mod overlays;
pub mod progress;
pub mod smooth;
pub mod texture;
pub mod trace;
pub mod write;

use config::Config;
use dem::{
    Bounds, bbox_key, bounds_from_smoothed, build_elevation_source, grid_for_bounds, local_xy,
    meshgrid, sample_elevation, sample_grid_elevation, warm_ign_cache, warm_piemonte_cache,
};
use gpx::{ascent_deadband, cumulative_distance, simplify_by_distance};
use grid::Grid;
use smooth::{gaussian_filter, savgol_smooth};
use write::{RouteJson, RoutePoint, TerrainJson, round};

pub use config::cli_args_to_config;

pub fn run_with_stdout_progress(config: Config) -> anyhow::Result<()> {
    run(config, progress::stdout_progress)
}

pub fn run<F>(config: Config, mut progress: F) -> anyhow::Result<()>
where
    F: FnMut(u8, &str),
{
    // WEB_COMPUTE_THREADS caps the rayon global pool that drives CPU compute (the
    // texture passes). 1 = single-threaded compute (rayon parallelism off); 0 =
    // all cores. The explicitly-sized fetch pools are separate and unaffected.
    if config.compute_threads > 0 {
        rayon::ThreadPoolBuilder::new()
            .num_threads(config.compute_threads)
            .build_global()
            .ok();
    }
    let root = trace::root_span("build-assets");
    let _enter = root.enter();
    run_inner(config, &mut progress)
}

/// Join a best-effort prefetch thread. Its result is intentionally not
/// propagated — the authoritative build/export stage re-fetches on a cache miss
/// — but a *panic* is a real bug, so surface it rather than swallow it silently.
fn settle(label: &str, joined: std::thread::Result<anyhow::Result<()>>) {
    match joined {
        Ok(Ok(())) => {}
        Ok(Err(error)) => tracing::debug!("prefetch {label} failed (will refetch): {error:#}"),
        Err(_) => tracing::warn!("prefetch {label} panicked (will refetch)"),
    }
}

/// Local-equirectangular extents (metres) of the visible and padded bboxes,
/// both projected from the same origin so they share per-cell spacing.
fn local_extents(bounds: Bounds, pbounds: Bounds, lat0_rad: f64) -> (f64, f64, f64, f64) {
    let extent = |b: Bounds| {
        let (x_min, y_min) = local_xy(b.lo_lo, b.la_lo, lat0_rad, bounds.lo_lo, bounds.la_lo);
        let (x_max, y_max) = local_xy(b.lo_hi, b.la_hi, lat0_rad, bounds.lo_lo, bounds.la_lo);
        (x_max - x_min, y_max - y_min)
    };
    let (width_m, depth_m) = extent(bounds);
    let (width_m_p, depth_m_p) = extent(pbounds);
    (width_m, depth_m, width_m_p, depth_m_p)
}

/// Build the route JSON: simplify the track, sample terrain elevation at each
/// kept point, project to local XY, and roll up the summary stats.
#[allow(clippy::too_many_arguments)] // cohesive route inputs; a struct would add noise
fn build_route_json(
    config: &Config,
    point_count: usize,
    lat: &[f64],
    lon: &[f64],
    ele: &[f64],
    heights: &Grid,
    bounds: Bounds,
    lat0_rad: f64,
) -> RouteJson {
    let idx = simplify_by_distance(lat, lon, config.route_step_m);
    let route_lat = idx.iter().map(|&i| lat[i]).collect::<Vec<_>>();
    let route_lon = idx.iter().map(|&i| lon[i]).collect::<Vec<_>>();
    let route_d = cumulative_distance(&route_lat, &route_lon);
    let mut route_z = Vec::with_capacity(idx.len());
    let mut route_points = Vec::with_capacity(idx.len());
    for (i, (&a, &o)) in route_lat.iter().zip(&route_lon).enumerate() {
        let z = sample_grid_elevation(o, a, bounds, heights);
        let (x, y) = local_xy(o, a, lat0_rad, bounds.lo_lo, bounds.la_lo);
        route_z.push(z);
        route_points.push(RoutePoint {
            x: round(x, 2),
            y: round(y, 2),
            z: round(z, 2),
            d: round(route_d[i], 2),
            lat: round(a, 7),
            lon: round(o, 7),
        });
    }
    let route_distance = cumulative_distance(lat, lon).last().copied().unwrap_or(0.0) / 1000.0;
    RouteJson {
        id: config.route_id.clone(),
        name: config.route_name.clone(),
        source: config.source_name.clone(),
        point_count,
        display_point_count: route_points.len(),
        distance_km: round(route_distance, 2),
        elevation_gain_m: round(ascent_deadband(ele, 3.0), 0),
        min_elevation_m: round(route_z.iter().copied().fold(f64::INFINITY, f64::min), 0),
        max_elevation_m: round(route_z.iter().copied().fold(f64::NEG_INFINITY, f64::max), 0),
        points: route_points,
    }
}

fn build_terrain_json(
    grid_size: usize,
    width_m: f64,
    depth_m: f64,
    heights: &Grid,
    height_min: f64,
    height_max: f64,
) -> TerrainJson {
    TerrainJson {
        grid_size,
        width_m: round(width_m, 2),
        depth_m: round(depth_m, 2),
        min_height_m: round(height_min, 2),
        max_height_m: round(height_max, 2),
        heights: heights.data.iter().map(|&v| round(v, 3)).collect(),
    }
}

fn run_inner<F>(config: Config, progress: &mut F) -> anyhow::Result<()>
where
    F: FnMut(u8, &str),
{
    progress(8, "Reading GPX track");
    let track = tracing::info_span!("parse-gpx").in_scope(|| gpx::parse_gpx(&config.gpx_path))?;

    let lat = savgol_smooth(&track.lat, 15);
    let lon = savgol_smooth(&track.lon, 15);
    let ele = savgol_smooth(&track.ele, 61);
    let bounds = bounds_from_smoothed(&lat, &lon, config.margin);
    let (grid_size, span_w_m, span_h_m, cell_m) = grid_for_bounds(&config, bounds);
    println!(
        "  grid: {grid_size}x{grid_size}, ~{cell_m:.1} m/cell over {:.1} km",
        span_w_m.max(span_h_m) / 1000.0
    );

    // Edge apron: fetch + sample + process a grid padded with `pad` cells of real
    // extra DEM on every side, then crop back to `grid_size` before any output.
    // Gradient/gaussian stencils at the visible edge then see real neighbours
    // instead of clamped/reflected ones, so relief & mesh edges come out clean.
    let pad = config.edge_pad;
    let dlon = (bounds.lo_hi - bounds.lo_lo) / (grid_size.max(2) - 1) as f64;
    let dlat = (bounds.la_hi - bounds.la_lo) / (grid_size.max(2) - 1) as f64;
    let pbounds = Bounds {
        lo_lo: bounds.lo_lo - pad as f64 * dlon,
        lo_hi: bounds.lo_hi + pad as f64 * dlon,
        la_lo: bounds.la_lo - pad as f64 * dlat,
        la_hi: bounds.la_hi + pad as f64 * dlat,
    };
    let pgrid = grid_size + 2 * pad;
    // pad is in the cache key: a padded DEM fetch covers a larger bbox, so it must
    // not collide with an unpadded one.
    let cache_key = format!("{}_p{pad}", bbox_key(&track.lat, &track.lon, config.margin));
    let (_glon, _glat, grid_lon, grid_lat) = meshgrid(pbounds, pgrid);

    progress(22, "Fetching elevation (DEM)");
    // All five remote sources are independent downloads (each needs only the
    // bbox); only the DEM *result* feeds the compute chain. Fire them all at once
    // and gate each compute on the join of exactly its input — a hand-wired
    // dependency DAG. The warm_* fills are best-effort: the build/export calls
    // below stay authoritative and re-fetch on a cache miss, so output is
    // identical to the sequential version, only the I/O now overlaps.
    std::thread::scope(|s| -> anyhow::Result<()> {
        let h_ign = s.spawn(|| warm_ign_cache(&config, pbounds, &cache_key));
        let h_pie = (config.dem_source.to_lowercase() != "ign")
            .then(|| s.spawn(|| warm_piemonte_cache(&config, pbounds, &cache_key)));
        let h_topo = s.spawn(|| texture::warm_topo_cache(&config, bounds));
        let h_forest = s.spawn(|| overlays::warm_forest_cache(&config, bounds));
        let h_border = s.spawn(|| overlays::warm_border_cache(&config, bounds, &cache_key));

        // edge: ign + piemonte -> elevation source (start as soon as both land,
        // without waiting on the topo/forest/border downloads).
        settle("ign", h_ign.join());
        if let Some(h) = h_pie {
            settle("piemonte", h.join());
        }
        let elevation_source = tracing::info_span!(
            "elevation-source",
            "dem.bbox" = %cache_key,
            "dem.grid" = pgrid
        )
        .in_scope(|| build_elevation_source(&config, pbounds, &cache_key))?;

        progress(58, "Sampling route & terrain");
        let raw_heights =
            tracing::info_span!("sample-elevation", "dem.source" = %elevation_source.kind)
                .in_scope(|| sample_elevation(&grid_lon, &grid_lat, pbounds, &elevation_source))?;
        let heights_p = gaussian_filter(&raw_heights, config.mesh_smooth);
        let relief_p = gaussian_filter(&heights_p, config.relief_smooth);
        let heights = heights_p.crop(pad);

        std::fs::create_dir_all(&config.out_dir)?;

        let lat0 = lat.iter().sum::<f64>() / lat.len() as f64;
        let lat0_rad = lat0.to_radians();
        // Padded extents share the visible grid's per-cell spacing, so relief
        // gradients run on the apron then crop (see edge-apron note above).
        let (width_m, depth_m, width_m_p, depth_m_p) = local_extents(bounds, pbounds, lat0_rad);

        let route = build_route_json(
            &config,
            track.lat.len(),
            &lat,
            &lon,
            &ele,
            &heights,
            bounds,
            lat0_rad,
        );
        write::write_route(&config, &route)?;

        progress(70, "Building map textures");
        // edge: topo tiles -> mosaic
        settle("topo", h_topo.join());
        let texture_zoom = tracing::info_span!("textures")
            .in_scope(|| texture::export_topographic_texture(&config, bounds))?;
        tracing::info_span!("reference-preview")
            .in_scope(|| texture::export_reference_images(&config))?;

        let (height_min, height_max) = heights.finite_min_max();
        write::write_heightmap(&config, &heights, height_min, height_max)?;

        progress(82, "Rendering relief & slope");
        let relief = tracing::info_span!("encode-relief").in_scope(|| {
            texture::export_relief_textures(&config, &relief_p, width_m_p, depth_m_p, pad)
        })?;
        if config.dem_contours {
            println!(
                "  DEM contours are not implemented in the Rust baker yet; skipping optional contour layer"
            );
        }

        progress(90, "Adding forest layer");
        // edge: forest TCD + relief -> forest layer
        settle("forest", h_forest.join());
        let forest_texture = tracing::info_span!("warm-forest")
            .in_scope(|| overlays::export_forest_texture(&config, bounds, &relief));
        // edge: border lines + heights -> border overlay
        settle("border", h_border.join());
        let border_count =
            overlays::export_border_overlay(&config, bounds, lat0_rad, &heights, &cache_key)?;

        let terrain = build_terrain_json(
            grid_size, width_m, depth_m, &heights, height_min, height_max,
        );
        write::write_terrain(&config, &terrain)?;

        progress(97, "Finalizing assets");
        write::write_manifest(
            &config,
            bounds,
            lat0,
            &route,
            &elevation_source,
            texture_zoom,
            forest_texture,
            border_count,
            grid_size,
            width_m,
            depth_m,
            height_min,
            height_max,
        )?;
        println!("wrote {}", config.out_dir.display());
        println!(
            "  route: {} km, +{} m, {} web points",
            route.distance_km, route.elevation_gain_m, route.display_point_count
        );
        println!("  terrain: {grid_size}x{grid_size}, {width_m:.0} x {depth_m:.0} m");
        Ok(())
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{Arc, Mutex};

    fn sample_config(dir: &std::path::Path) -> Config {
        let gpx = dir.join("route.gpx");
        std::fs::write(
            &gpx,
            "<gpx><trk><trkseg><trkpt lat=\"45\" lon=\"7\"><ele>100</ele></trkpt><trkpt lat=\"45.001\" lon=\"7.001\"><ele>130</ele></trkpt></trkseg></trk></gpx>",
        )
        .unwrap();
        let out = dir.join("out");
        std::fs::create_dir_all(&out).unwrap();
        Config::from_paths(gpx, dir.join("reference.png"), dir.join("angles.png"), out).unwrap()
    }

    fn invalid_run_config(dir: &std::path::Path) -> Config {
        let gpx = dir.join("invalid.gpx");
        std::fs::write(
            &gpx,
            "<gpx><trk><trkseg><trkpt lat=\"45\" lon=\"7\"><ele>100</ele></trkpt></trkseg></trk></gpx>",
        )
        .unwrap();
        let out = dir.join("out-invalid");
        std::fs::create_dir_all(&out).unwrap();
        Config::from_paths(gpx, dir.join("reference.png"), dir.join("angles.png"), out).unwrap()
    }

    #[test]
    fn settle_handles_success_error_and_panic() {
        settle("ok", Ok(Ok(())));
        settle("err", Ok(Err(anyhow::anyhow!("expected"))));
        let panic = std::thread::spawn(|| panic!("boom")).join();
        settle("panic", panic.map(|_| Ok(())));
    }

    #[test]
    fn local_extents_project_visible_and_padded_bounds() {
        let bounds = Bounds {
            lo_lo: 7.0,
            lo_hi: 7.02,
            la_lo: 45.0,
            la_hi: 45.01,
        };
        let pbounds = Bounds {
            lo_lo: 6.99,
            lo_hi: 7.03,
            la_lo: 44.99,
            la_hi: 45.02,
        };
        let (width, depth, width_p, depth_p) =
            local_extents(bounds, pbounds, 45.005_f64.to_radians());
        assert!(width > 0.0 && depth > 0.0);
        assert!(width_p > width);
        assert!(depth_p > depth);
    }

    #[test]
    fn build_route_json_summarizes_track_metrics() {
        let dir = tempfile::tempdir().unwrap();
        let mut config = sample_config(dir.path());
        config.route_id = "route-id".to_string();
        config.route_name = "Route Name".to_string();
        config.source_name = "route.gpx".to_string();
        config.route_step_m = 10.0;
        let heights = Grid::from_vec(
            3,
            3,
            vec![
                100.0, 110.0, 120.0, 130.0, 140.0, 150.0, 160.0, 170.0, 180.0,
            ],
        )
        .unwrap();
        let lat = vec![45.0, 45.0005, 45.001];
        let lon = vec![7.0, 7.0005, 7.001];
        let ele = vec![100.0, 120.0, 130.0];
        let route = build_route_json(
            &config,
            3,
            &lat,
            &lon,
            &ele,
            &heights,
            Bounds {
                lo_lo: 7.0,
                lo_hi: 7.001,
                la_lo: 45.0,
                la_hi: 45.001,
            },
            45.0005_f64.to_radians(),
        );
        assert_eq!(route.id, "route-id");
        assert_eq!(route.name, "Route Name");
        assert_eq!(route.point_count, 3);
        assert!(route.display_point_count >= 2);
        assert!(route.distance_km > 0.0);
        assert!(route.elevation_gain_m >= 30.0);
        assert_eq!(route.points.first().unwrap().lat, 45.0);
    }

    #[test]
    fn build_terrain_json_rounds_values() {
        let heights = Grid::from_vec(2, 2, vec![1.1111, 2.2222, 3.3333, 4.4444]).unwrap();
        let terrain = build_terrain_json(2, 123.456, 78.901, &heights, 1.1111, 4.4444);
        assert_eq!(terrain.grid_size, 2);
        assert_eq!(terrain.width_m, 123.46);
        assert_eq!(terrain.depth_m, 78.9);
        assert_eq!(terrain.min_height_m, 1.11);
        assert_eq!(terrain.max_height_m, 4.44);
        assert_eq!(terrain.heights, vec![1.111, 2.222, 3.333, 4.444]);
    }

    #[test]
    fn run_reports_initial_progress_before_failing_without_cache() {
        let dir = tempfile::tempdir().unwrap();
        let config = invalid_run_config(dir.path());
        let calls = Arc::new(Mutex::new(Vec::new()));
        let seen = Arc::clone(&calls);
        let result = run(config, |pct, label| {
            seen.lock().unwrap().push((pct, label.to_string()))
        });
        assert!(
            result.is_err(),
            "full run should fail without seeded offline caches"
        );
        let calls = calls.lock().unwrap();
        assert_eq!(calls.first().unwrap().0, 8);
        assert_eq!(calls.first().unwrap().1, "Reading GPX track");
    }

    #[test]
    fn run_with_stdout_progress_is_callable() {
        let dir = tempfile::tempdir().unwrap();
        let config = invalid_run_config(dir.path());
        assert!(run_with_stdout_progress(config).is_err());
    }
}
