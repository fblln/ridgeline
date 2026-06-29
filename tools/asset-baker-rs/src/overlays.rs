use std::fs;
use std::path::PathBuf;

use anyhow::Context;
use image::imageops::{self, FilterType};
use image::{GrayImage, Rgb, RgbImage};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use url::form_urlencoded;

use crate::config::Config;
use crate::dem::{Bounds, local_xy, sample_grid_elevation};
use crate::fetch::{download, download_to};
use crate::gdal_io::read_band_f64;
use crate::grid::Grid;
use crate::texture::Relief;

#[derive(Debug, Serialize, Deserialize)]
pub struct Border {
    pub id: String,
    pub name: String,
    pub color: String,
    pub lines: Vec<Vec<BorderPoint>>,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct BorderPoint {
    pub x: f64,
    pub y: f64,
    pub z: f64,
}

pub fn export_forest_texture(config: &Config, bounds: Bounds, relief: &Relief) -> Option<String> {
    match export_forest_texture_inner(config, bounds, relief) {
        Ok(path) => path,
        Err(error) => {
            println!("  Copernicus tree-cover unavailable, skipping forest layer: {error:#}");
            None
        }
    }
}

/// Download the Copernicus TCD GeoTIFF into the disk cache and return its path
/// and dimensions. Idempotent: a present cache file is reused.
fn fetch_forest_tcd(config: &Config, bounds: Bounds) -> anyhow::Result<(PathBuf, u32, u32)> {
    let px = config.forest_px;
    let wm = (bounds.lo_hi - bounds.lo_lo)
        * 111_320.0
        * ((bounds.la_lo + bounds.la_hi) / 2.0).to_radians().cos();
    let hm = (bounds.la_hi - bounds.la_lo) * 111_320.0;
    let width = px;
    let height = ((px as f64 * hm / wm).round().max(1.0)) as u32;
    let query = form_urlencoded::Serializer::new(String::new())
        .append_pair(
            "bbox",
            &format!(
                "{},{},{},{}",
                bounds.lo_lo, bounds.la_lo, bounds.lo_hi, bounds.la_hi
            ),
        )
        .append_pair("bboxSR", "4326")
        .append_pair("imageSR", "4326")
        .append_pair("size", &format!("{width},{height}"))
        .append_pair("format", "tiff")
        .append_pair("pixelType", "U8")
        .append_pair("interpolation", "RSP_BilinearInterpolation")
        .append_pair("f", "image")
        .finish();
    let path = config.cache_dir.join(format!(
        "forest_{:.4}_{:.4}_{:.4}_{:.4}_{width}x{height}.tif",
        bounds.lo_lo, bounds.la_lo, bounds.lo_hi, bounds.la_hi
    ));
    if !path.exists() {
        download_to(&path, &format!("{}?{query}", config.forest_url), &[], 180)?;
    }
    Ok((path, width, height))
}

/// Best-effort: warm the forest TCD cache so `export_forest_texture` reads local.
pub fn warm_forest_cache(config: &Config, bounds: Bounds) -> anyhow::Result<()> {
    fetch_forest_tcd(config, bounds).map(|_| ())
}

/// Best-effort: warm the Overpass border-line cache so `export_border_overlay`
/// reads local.
pub fn warm_border_cache(config: &Config, bounds: Bounds, cache_key: &str) -> anyhow::Result<()> {
    load_border_lines(config, bounds, cache_key).map(|_| ())
}

pub fn export_border_overlay(
    config: &Config,
    bounds: Bounds,
    lat0: f64,
    heights: &Grid,
    cache_key: &str,
) -> anyhow::Result<usize> {
    let border = match load_border_lines(config, bounds, cache_key) {
        Ok(lines) => build_border(bounds, lat0, heights, lines),
        Err(_) => Border {
            id: "france-italy-border".to_string(),
            name: "France / Italy border".to_string(),
            color: "#1f6bff".to_string(),
            lines: Vec::new(),
        },
    };
    let count = border.lines.len();
    fs::write(
        config.out_dir.join("border.json"),
        serde_json::to_string(&border)?,
    )?;
    Ok(count)
}

fn export_forest_texture_inner(
    config: &Config,
    bounds: Bounds,
    relief: &Relief,
) -> anyhow::Result<Option<String>> {
    let (path, _, _) = fetch_forest_tcd(config, bounds)?;
    let tcd = decode_tcd_luma8(&path)?;
    let (width, height) = tcd.dimensions();
    let mut shade = image::GrayImage::new(
        relief.reference.width as u32,
        relief.reference.height as u32,
    );
    for row in 0..relief.reference.height {
        for col in 0..relief.reference.width {
            let value = (relief.reference.data[row * relief.reference.width + col].clamp(0.0, 1.0)
                * 255.0)
                .round() as u8;
            shade.put_pixel(col as u32, row as u32, image::Luma([value]));
        }
    }
    let shade = imageops::resize(&shade, width, height, FilterType::CatmullRom);
    let mut rgb = RgbImage::new(width, height);
    let threshold = config.forest_min_tcd;
    for y in 0..height {
        for x in 0..width {
            let south_up_y = height - 1 - y;
            let raw = tcd.get_pixel(x, y)[0];
            let canopy = if raw > 100 { 0.0 } else { f32::from(raw) };
            let d = ((canopy - threshold) / (100.0 - threshold)).clamp(0.0, 1.0);
            let cream = [243.0, 239.0, 226.0];
            let g_lo = [120.0, 162.0, 104.0];
            let g_hi = [42.0, 86.0, 44.0];
            let green = [
                g_lo[0] + (g_hi[0] - g_lo[0]) * d,
                g_lo[1] + (g_hi[1] - g_lo[1]) * d,
                g_lo[2] + (g_hi[2] - g_lo[2]) * d,
            ];
            let vis = (d * 3.0).clamp(0.0, 1.0);
            let factor = 0.55 + 0.62 * f32::from(shade.get_pixel(x, south_up_y)[0]) / 255.0;
            let color = [0, 1, 2].map(|i| {
                ((cream[i] * (1.0 - vis) + green[i] * vis) * factor)
                    .round()
                    .clamp(0.0, 255.0) as u8
            });
            rgb.put_pixel(x, height - 1 - south_up_y, Rgb(color));
        }
    }
    rgb.save(config.out_dir.join("terrain-forest.png"))?;
    println!("  forest: exported TCD layer");
    Ok(Some("terrain-forest.png".to_string()))
}

/// Decode a single-band u8 GeoTIFF (Copernicus TCD) to a luma image via GDAL.
///
/// The EEA ImageServer returns a tiled GeoTIFF with sparse tiles (empty areas
/// have byte-count 0); GDAL zero-fills them natively, matching rasterio — no
/// hand-rolled tile handling needed.
fn decode_tcd_luma8(path: &std::path::Path) -> anyhow::Result<GrayImage> {
    let band = read_band_f64(path)?;
    let data: Vec<u8> = band
        .data
        .iter()
        .map(|&v| v.clamp(0.0, 255.0) as u8)
        .collect();
    GrayImage::from_raw(band.width as u32, band.height as u32, data)
        .context("TCD buffer size mismatch")
}

fn load_border_lines(
    config: &Config,
    bounds: Bounds,
    cache_key: &str,
) -> anyhow::Result<Vec<Vec<(f64, f64)>>> {
    let path = config.cache_dir.join(format!("border_{cache_key}.geojson"));
    if !path.exists() {
        let overpass = format!(
            r#"[out:json][timeout:25];way["boundary"="administrative"]["admin_level"="2"]({},{},{},{});out geom;"#,
            bounds.la_lo, bounds.lo_lo, bounds.la_hi, bounds.lo_hi
        );
        let query = form_urlencoded::Serializer::new(String::new())
            .append_pair("data", &overpass)
            .finish();
        let bytes = download(
            &format!("https://overpass-api.de/api/interpreter?{query}"),
            &[("User-Agent", "trek-camera-viewer/1.0")],
            60,
        )?;
        // Cache as a GeoJSON FeatureCollection — the exact shape the Python baker
        // writes — so the border_*.geojson cache is interoperable between the two
        // pipelines. (Previously this stored raw Overpass JSON, which the Python
        // reader couldn't parse, and vice-versa: whichever baker ran first won and
        // the other silently produced an empty border.)
        let raw: Value = serde_json::from_slice(&bytes)?;
        let features: Vec<Value> = raw
            .get("elements")
            .and_then(Value::as_array)
            .map(|elements| {
                elements
                    .iter()
                    .filter(|w| w.get("type").and_then(Value::as_str) == Some("way"))
                    .filter_map(|w| w.get("geometry").and_then(Value::as_array))
                    .map(|geom| {
                        let coords: Vec<Value> = geom
                            .iter()
                            .filter_map(|p| {
                                Some(serde_json::json!([
                                    p.get("lon")?.as_f64()?,
                                    p.get("lat")?.as_f64()?
                                ]))
                            })
                            .collect();
                        serde_json::json!({
                            "type": "Feature",
                            "geometry": {"type": "LineString", "coordinates": coords},
                        })
                    })
                    .collect()
            })
            .unwrap_or_default();
        let collection = serde_json::json!({"type": "FeatureCollection", "features": features});
        fs::write(&path, serde_json::to_vec(&collection)?)?;
    }
    // Parse with the geojson crate (georust): a LineString is one segment, a
    // MultiLineString is several. Each position is [lon, lat, ...].
    let geojson = fs::read_to_string(&path)?.parse::<geojson::GeoJson>()?;
    let mut lines = Vec::new();
    if let geojson::GeoJson::FeatureCollection(collection) = geojson {
        for feature in collection.features {
            let Some(geometry) = feature.geometry else {
                continue;
            };
            match geometry.value {
                geojson::GeometryValue::LineString { coordinates } => {
                    push_line(&mut lines, coordinates)
                }
                geojson::GeometryValue::MultiLineString { coordinates } => {
                    for points in coordinates {
                        push_line(&mut lines, points);
                    }
                }
                _ => {}
            }
        }
    }
    Ok(lines)
}

fn push_line(lines: &mut Vec<Vec<(f64, f64)>>, points: Vec<geojson::Position>) {
    let line: Vec<(f64, f64)> = points
        .iter()
        .filter_map(|p| {
            let coords = p.as_slice();
            Some((*coords.first()?, *coords.get(1)?))
        })
        .collect();
    if line.len() > 1 {
        lines.push(line);
    }
}

fn build_border(bounds: Bounds, lat0: f64, heights: &Grid, lines: Vec<Vec<(f64, f64)>>) -> Border {
    let mut overlays = Vec::new();
    for line in lines {
        let mut run = Vec::new();
        for (lon, lat) in line {
            let inside = lon >= bounds.lo_lo
                && lon <= bounds.lo_hi
                && lat >= bounds.la_lo
                && lat <= bounds.la_hi;
            if inside {
                let (x, y) = local_xy(lon, lat, lat0, bounds.lo_lo, bounds.la_lo);
                let z = sample_grid_elevation(lon, lat, bounds, heights);
                run.push(BorderPoint {
                    x: round2(x),
                    y: round2(y),
                    z: round2(z),
                });
            } else if run.len() > 1 {
                overlays.push(std::mem::take(&mut run));
            } else {
                run.clear();
            }
        }
        if run.len() > 1 {
            overlays.push(run);
        }
    }
    Border {
        id: "france-italy-border".to_string(),
        name: "France / Italy border".to_string(),
        color: "#1f6bff".to_string(),
        lines: overlays,
    }
}

fn round2(value: f64) -> f64 {
    (value * 100.0).round() / 100.0
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::texture::Relief;

    fn test_config() -> (tempfile::TempDir, Config) {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        let gpx = root.join("route.gpx");
        fs::write(&gpx, "<gpx/>").unwrap();
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
        config.forest_px = 8;
        config.forest_min_tcd = 50.0;
        (dir, config)
    }

    fn test_bounds() -> Bounds {
        Bounds {
            lo_lo: 7.0,
            lo_hi: 7.02,
            la_lo: 45.0,
            la_hi: 45.01,
        }
    }

    fn forest_cache_path(config: &Config, bounds: Bounds) -> PathBuf {
        let px = config.forest_px;
        let wm = (bounds.lo_hi - bounds.lo_lo)
            * 111_320.0
            * ((bounds.la_lo + bounds.la_hi) / 2.0).to_radians().cos();
        let hm = (bounds.la_hi - bounds.la_lo) * 111_320.0;
        let width = px;
        let height = ((px as f64 * hm / wm).round().max(1.0)) as u32;
        config.cache_dir.join(format!(
            "forest_{:.4}_{:.4}_{:.4}_{:.4}_{width}x{height}.tif",
            bounds.lo_lo, bounds.la_lo, bounds.lo_hi, bounds.la_hi
        ))
    }

    fn sample_relief() -> Relief {
        let reference = Grid::from_vec(
            4,
            4,
            vec![
                0.1, 0.2, 0.3, 0.4, 0.2, 0.3, 0.4, 0.5, 0.3, 0.4, 0.5, 0.6, 0.4, 0.5, 0.6, 0.7,
            ],
        )
        .unwrap();
        Relief {
            hillshade: reference.clone(),
            multishade: reference.clone(),
            reference,
        }
    }

    #[test]
    fn export_forest_texture_reads_cached_tiff() {
        let (_dir, config) = test_config();
        let bounds = test_bounds();
        let path = forest_cache_path(&config, bounds);
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        image::GrayImage::from_fn(8, 4, |x, _| image::Luma([if x < 4 { 10 } else { 90 }]))
            .save(&path)
            .unwrap();

        warm_forest_cache(&config, bounds).unwrap();
        let forest = export_forest_texture(&config, bounds, &sample_relief());
        assert_eq!(forest, Some("terrain-forest.png".to_string()));
        assert!(config.out_dir.join("terrain-forest.png").exists());
    }

    #[test]
    fn export_forest_texture_gracefully_skips_errors() {
        let (_dir, mut config) = test_config();
        config.forest_url = "http://127.0.0.1:9/forest".to_string();
        let bounds = test_bounds();
        assert_eq!(
            export_forest_texture(&config, bounds, &sample_relief()),
            None
        );
    }

    #[test]
    fn export_border_overlay_reads_cached_geojson() {
        let (_dir, config) = test_config();
        let bounds = test_bounds();
        let cache_key = "border";
        fs::create_dir_all(&config.cache_dir).unwrap();
        fs::write(
            config.cache_dir.join(format!("border_{cache_key}.geojson")),
            serde_json::json!({
                "type": "FeatureCollection",
                "features": [
                    {
                        "type": "Feature",
                        "geometry": {
                            "type": "LineString",
                            "coordinates": [[7.001, 45.001], [7.005, 45.005], [7.03, 45.02]]
                        }
                    },
                    {
                        "type": "Feature",
                        "geometry": {
                            "type": "MultiLineString",
                            "coordinates": [
                                [[7.002, 45.002], [7.003, 45.003]],
                                [[7.004, 45.004], [7.006, 45.006]]
                            ]
                        }
                    }
                ]
            })
            .to_string(),
        )
        .unwrap();
        let heights = Grid::new(8, 8, 120.0);
        warm_border_cache(&config, bounds, cache_key).unwrap();
        let count = export_border_overlay(
            &config,
            bounds,
            45.005_f64.to_radians(),
            &heights,
            cache_key,
        )
        .unwrap();
        assert_eq!(count, 3);
        let border: serde_json::Value =
            serde_json::from_slice(&fs::read(config.out_dir.join("border.json")).unwrap()).unwrap();
        assert_eq!(border["lines"].as_array().unwrap().len(), 3);
        assert!(
            border["lines"]
                .as_array()
                .unwrap()
                .iter()
                .all(|line| line.as_array().unwrap().len() >= 2)
        );
    }

    #[test]
    fn export_border_overlay_falls_back_to_empty_border() {
        let (_dir, config) = test_config();
        let bounds = test_bounds();
        let cache_key = "broken";
        fs::create_dir_all(&config.cache_dir).unwrap();
        fs::write(
            config.cache_dir.join(format!("border_{cache_key}.geojson")),
            "{not-json",
        )
        .unwrap();
        let count = export_border_overlay(
            &config,
            bounds,
            45.005_f64.to_radians(),
            &Grid::new(4, 4, 0.0),
            cache_key,
        )
        .unwrap();
        assert_eq!(count, 0);
    }
}
