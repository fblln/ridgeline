use std::fs;

use image::{ImageBuffer, Luma};
use serde::Serialize;

use crate::config::Config;
use crate::dem::{Bounds, ElevationSource};
use crate::grid::Grid;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RoutePoint {
    pub x: f64,
    pub y: f64,
    pub z: f64,
    pub d: f64,
    pub lat: f64,
    pub lon: f64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RouteJson {
    pub id: String,
    pub name: String,
    pub source: String,
    pub point_count: usize,
    pub display_point_count: usize,
    pub distance_km: f64,
    pub elevation_gain_m: f64,
    pub min_elevation_m: f64,
    pub max_elevation_m: f64,
    pub points: Vec<RoutePoint>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TerrainJson {
    pub grid_size: usize,
    pub width_m: f64,
    pub depth_m: f64,
    pub min_height_m: f64,
    pub max_height_m: f64,
    pub heights: Vec<f64>,
}

pub fn write_route(config: &Config, route: &RouteJson) -> anyhow::Result<()> {
    fs::write(
        config.out_dir.join("route.json"),
        serde_json::to_string(route)?,
    )?;
    Ok(())
}

pub fn write_terrain(config: &Config, terrain: &TerrainJson) -> anyhow::Result<()> {
    fs::write(
        config.out_dir.join("terrain.json"),
        serde_json::to_string(terrain)?,
    )?;
    Ok(())
}

pub fn write_heightmap(
    config: &Config,
    heights: &Grid,
    height_min: f64,
    height_max: f64,
) -> anyhow::Result<()> {
    let denom = (height_max - height_min).max(1e-9);
    let data = heights
        .data
        .iter()
        .map(|&height| {
            (((height - height_min) / denom) * 65_535.0)
                .round()
                .clamp(0.0, 65_535.0) as u16
        })
        .collect::<Vec<_>>();
    let image = ImageBuffer::<Luma<u16>, Vec<u16>>::from_raw(
        heights.width as u32,
        heights.height as u32,
        data,
    )
    .ok_or_else(|| anyhow::anyhow!("failed to build heightmap image"))?;
    image.save(config.out_dir.join("heightmap.png"))?;
    Ok(())
}

#[allow(clippy::too_many_arguments)]
pub fn write_manifest(
    config: &Config,
    bounds: Bounds,
    lat0_deg: f64,
    route: &RouteJson,
    elevation_source: &ElevationSource,
    texture_zoom: u8,
    forest_texture: Option<String>,
    border_count: usize,
    grid_size: usize,
    width_m: f64,
    depth_m: f64,
    height_min: f64,
    height_max: f64,
) -> anyhow::Result<()> {
    let manifest = serde_json::json!({
        "id": config.route_id,
        "name": config.route_name,
        "bounds": [round(bounds.lo_lo, 7), round(bounds.la_lo, 7), round(bounds.lo_hi, 7), round(bounds.la_hi, 7)],
        "projection": {
            "kind": "local-equirectangular",
            "lat0": round(lat0_deg, 7),
            "originLon": round(bounds.lo_lo, 7),
            "originLat": round(bounds.la_lo, 7),
        },
        "terrain": {
            "data": "terrain.json",
            "heightmap": "heightmap.png",
            "texture": "terrain-texture.png",
            "rawTexture": "terrain-topo-raw.png",
            "textureZoom": texture_zoom,
            "hillshadeTexture": "terrain-hillshade.png",
            "multiHillshadeTexture": "terrain-multishade.png",
            "slopeTexture": "terrain-slope.png",
            "hypsoTexture": "terrain-hypso.png",
            "forestTexture": forest_texture,
            "normalTexture": "terrain-normal.png",
            "demSource": elevation_source.kind,
            "demSourceLabel": elevation_source.name,
            "piemonteSampleOrder": 1,
            "sourceResolutionM": if elevation_source.kind == "mixed" { 5.0 } else { config.dem_res_m },
            "ignFillResolutionM": config.dem_res_m,
            "meshSmoothingSigma": config.mesh_smooth,
            "reliefSmoothingSigma": config.relief_smooth,
            "slopeSmoothingSigma": config.slope_smooth,
            "routeSampleStepM": config.route_step_m,
            "gridSize": grid_size,
            "widthM": round(width_m, 2),
            "depthM": round(depth_m, 2),
            "minHeightM": round(height_min, 2),
            "maxHeightM": round(height_max, 2),
        },
        "reference": {
            "render": "reference-render.png",
            "preview": "reference-preview.jpg",
            "angles": if config.angles_path.exists() { Some("angle-sheet.png") } else { None::<&str> },
        },
        "routes": [{
            "id": route.id,
            "name": route.name,
            "path": "route.json",
            "distanceKm": route.distance_km,
            "elevationGainM": route.elevation_gain_m,
            "pointCount": route.point_count,
        }],
        "overlays": {
            "border": if border_count > 0 { Some("border.json") } else { None::<&str> },
        },
        "defaultCamera": {
            "position": [round(width_m * 0.55, 2), round(-depth_m * 0.7, 2), round((height_max - height_min) * 2.2, 2)],
            "target": [round(width_m * 0.52, 2), round(depth_m * 0.52, 2), round((height_min + height_max) / 2.0, 2)],
            "fov": 42,
        },
        "attribution": [
            elevation_source.name,
            format!("Source GPX: {}", config.source_name),
            "Reference preview generated from imported terrain assets",
        ],
    });
    fs::write(
        config.out_dir.join("manifest.json"),
        serde_json::to_string_pretty(&manifest)?,
    )?;
    Ok(())
}

pub fn round(value: f64, places: i32) -> f64 {
    let factor = 10_f64.powi(places);
    (value * factor).round() / factor
}

#[cfg(test)]
mod tests {
    use super::*;
    use image::ImageReader;

    fn sample_config() -> (tempfile::TempDir, Config) {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        let gpx = root.join("route.gpx");
        fs::write(&gpx, "<gpx/>").unwrap();
        let reference = root.join("reference.png");
        let angles = root.join("angles.png");
        let out = root.join("out");
        fs::create_dir_all(&out).unwrap();
        let config = Config::from_paths(gpx, reference, angles, out).unwrap();
        (dir, config)
    }

    fn sample_route() -> RouteJson {
        RouteJson {
            id: "route".to_string(),
            name: "Route".to_string(),
            source: "route.gpx".to_string(),
            point_count: 3,
            display_point_count: 2,
            distance_km: 1.23,
            elevation_gain_m: 45.0,
            min_elevation_m: 100.0,
            max_elevation_m: 200.0,
            points: vec![
                RoutePoint {
                    x: 1.0,
                    y: 2.0,
                    z: 100.0,
                    d: 0.0,
                    lat: 45.0,
                    lon: 7.0,
                },
                RoutePoint {
                    x: 2.0,
                    y: 3.0,
                    z: 150.0,
                    d: 1.0,
                    lat: 45.1,
                    lon: 7.1,
                },
            ],
        }
    }

    #[test]
    fn write_route_and_terrain_emit_json() {
        let (_dir, config) = sample_config();
        let route = sample_route();
        let terrain = TerrainJson {
            grid_size: 2,
            width_m: 100.0,
            depth_m: 120.0,
            min_height_m: 10.0,
            max_height_m: 50.0,
            heights: vec![10.0, 20.0, 30.0, 40.0],
        };
        write_route(&config, &route).unwrap();
        write_terrain(&config, &terrain).unwrap();

        let route_json: serde_json::Value =
            serde_json::from_slice(&fs::read(config.out_dir.join("route.json")).unwrap()).unwrap();
        assert_eq!(route_json["id"], "route");
        assert_eq!(route_json["displayPointCount"], 2);

        let terrain_json: serde_json::Value =
            serde_json::from_slice(&fs::read(config.out_dir.join("terrain.json")).unwrap())
                .unwrap();
        assert_eq!(terrain_json["gridSize"], 2);
        assert_eq!(terrain_json["heights"].as_array().unwrap().len(), 4);
    }

    #[test]
    fn write_heightmap_scales_to_u16_png() {
        let (_dir, config) = sample_config();
        let heights = Grid::from_vec(2, 2, vec![10.0, 20.0, 30.0, 40.0]).unwrap();
        write_heightmap(&config, &heights, 10.0, 40.0).unwrap();
        let image = ImageReader::open(config.out_dir.join("heightmap.png"))
            .unwrap()
            .decode()
            .unwrap()
            .to_luma16();
        assert_eq!((image.width(), image.height()), (2, 2));
        assert_eq!(image.get_pixel(0, 0)[0], 0);
        assert_eq!(image.get_pixel(1, 1)[0], 65_535);
    }

    #[test]
    fn write_manifest_respects_optional_assets() {
        let (_dir, mut config) = sample_config();
        image::RgbImage::from_pixel(4, 3, image::Rgb([1, 2, 3]))
            .save(&config.reference_path)
            .unwrap();
        image::RgbImage::from_pixel(2, 2, image::Rgb([4, 5, 6]))
            .save(&config.angles_path)
            .unwrap();
        config.source_name = "source.gpx".to_string();
        config.route_id = "manifest-route".to_string();
        config.route_name = "Manifest Route".to_string();
        config.route_step_m = 4.0;
        config.mesh_smooth = 0.1;
        config.relief_smooth = 0.2;
        config.slope_smooth = 0.3;
        config.dem_res_m = 2.0;

        let route = sample_route();
        let elevation_source = ElevationSource {
            kind: "mixed".to_string(),
            name: "Mixed DEM".to_string(),
            ign: Grid::new(1, 1, 100.0),
            piemonte: None,
        };
        write_manifest(
            &config,
            Bounds {
                lo_lo: 7.0,
                la_lo: 45.0,
                lo_hi: 7.2,
                la_hi: 45.1,
            },
            45.05,
            &route,
            &elevation_source,
            12,
            Some("terrain-forest.png".to_string()),
            2,
            512,
            1234.5,
            987.6,
            100.0,
            456.0,
        )
        .unwrap();
        let manifest: serde_json::Value =
            serde_json::from_slice(&fs::read(config.out_dir.join("manifest.json")).unwrap())
                .unwrap();
        assert_eq!(manifest["id"], "manifest-route");
        assert_eq!(manifest["terrain"]["demSource"], "mixed");
        assert_eq!(manifest["terrain"]["sourceResolutionM"], 5.0);
        assert_eq!(manifest["reference"]["angles"], "angle-sheet.png");
        assert_eq!(manifest["overlays"]["border"], "border.json");
        assert_eq!(manifest["attribution"][1], "Source GPX: source.gpx");
    }

    #[test]
    fn round_handles_decimal_places() {
        assert_eq!(round(12.3456, 2), 12.35);
        assert_eq!(round(12.3456, 0), 12.0);
        assert_eq!(round(1234.0, -2), 1200.0);
    }
}
