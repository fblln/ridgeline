use std::fs;
use std::io::BufWriter;
use std::path::PathBuf;

use image::codecs::jpeg::JpegEncoder;
use image::imageops::{self, FilterType};
use image::{GrayImage, Luma, Rgb, RgbImage};
use rayon::prelude::*;

use crate::config::Config;
use crate::dem::Bounds;
use crate::fetch::download_to;
use crate::grid::Grid;
use crate::smooth::{gaussian_filter, gradient, normalize_to_u8};

#[derive(Debug, Clone)]
pub struct Relief {
    pub hillshade: Grid,
    pub multishade: Grid,
    pub reference: Grid,
}

/// Inclusive tile-index extent (tx0, tx1, ty0, ty1) covering the bbox at `zoom`.
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

/// Best-effort: download every OpenTopoMap tile for the bbox into the disk
/// cache (bounded parallel, OTM-polite). `export_topographic_texture` calls this
/// too, so prefetching it is just a warm-cache no-op there.
pub fn warm_topo_cache(config: &Config, bounds: Bounds) -> anyhow::Result<()> {
    let zoom = config.tile_zoom;
    let (tx0, tx1, ty0, ty1) = topo_tile_extent(bounds, zoom);
    let tiles = (tx0..=tx1)
        .flat_map(|tx| (ty0..=ty1).map(move |ty| (tx, ty)))
        .collect::<Vec<_>>();
    let topo_workers = config.fetch_workers.clamp(1, 4);
    let fetch_pool = rayon::ThreadPoolBuilder::new()
        .num_threads(topo_workers)
        .thread_name(|index| format!("fetch-topo-{index}"))
        .build()?;
    fetch_pool.install(|| {
        tiles
            .par_iter()
            .try_for_each(|&(tx, ty)| ensure_opentopo_tile(config, tx, ty, zoom).map(|_| ()))
    })
}

pub fn export_topographic_texture(config: &Config, bounds: Bounds) -> anyhow::Result<u8> {
    let zoom = config.tile_zoom;
    warm_topo_cache(config, bounds)?;
    let (x_w, y_n) = deg2num(bounds.la_hi, bounds.lo_lo, zoom);
    let (x_e, y_s) = deg2num(bounds.la_lo, bounds.lo_hi, zoom);
    let (tx0, tx1, ty0, ty1) = topo_tile_extent(bounds, zoom);
    let tiles = (tx0..=tx1)
        .flat_map(|tx| (ty0..=ty1).map(move |ty| (tx, ty)))
        .collect::<Vec<_>>();

    let mut mosaic = RgbImage::new((tx1 - tx0 + 1) * 256, (ty1 - ty0 + 1) * 256);
    for &(tx, ty) in &tiles {
        let tile = opentopo_tile(config, tx, ty, zoom)?;
        imageops::replace(
            &mut mosaic,
            &tile,
            i64::from((tx - tx0) * 256),
            i64::from((ty - ty0) * 256),
        );
    }

    let crop_x = ((x_w - f64::from(tx0)) * 256.0).floor().max(0.0) as u32;
    let crop_y = ((y_n - f64::from(ty0)) * 256.0).floor().max(0.0) as u32;
    let crop_right = ((x_e - f64::from(tx0)) * 256.0)
        .floor()
        .max(crop_x as f64 + 1.0) as u32;
    let crop_bottom = ((y_s - f64::from(ty0)) * 256.0)
        .floor()
        .max(crop_y as f64 + 1.0) as u32;
    let crop_w = (crop_right - crop_x).min(mosaic.width() - crop_x);
    let crop_h = (crop_bottom - crop_y).min(mosaic.height() - crop_y);
    let mut texture = imageops::crop_imm(&mosaic, crop_x, crop_y, crop_w, crop_h).to_image();
    enhance_rgb(
        &mut texture,
        config.texture_sat,
        config.texture_bright,
        config.texture_contrast,
    );
    if texture.width() > config.texture_max || texture.height() > config.texture_max {
        texture = thumbnail_rgb(&texture, config.texture_max, config.texture_max);
    }
    let raw_path = config.out_dir.join("terrain-topo-raw.png");
    let texture_path = config.out_dir.join("terrain-texture.png");
    texture.save(&raw_path)?;
    fs::copy(&raw_path, &texture_path)?;
    Ok(zoom)
}

pub fn export_reference_images(config: &Config) -> anyhow::Result<()> {
    let reference_source = if config.reference_path.exists() {
        fs::copy(
            &config.reference_path,
            config.out_dir.join("reference-render.png"),
        )?;
        config.reference_path.clone()
    } else {
        fs::copy(
            config.out_dir.join("terrain-texture.png"),
            config.out_dir.join("reference-render.png"),
        )?;
        config.out_dir.join("terrain-texture.png")
    };
    if config.angles_path.exists() {
        fs::copy(&config.angles_path, config.out_dir.join("angle-sheet.png"))?;
    }
    let preview = image::open(reference_source)?.to_rgb8();
    let preview = thumbnail_rgb(&preview, 1200, 900);
    // JPEG quality 88 to match the Python baker (the image crate defaults to 75 —
    // visibly lower quality). Encoders still differ byte-for-byte across libs.
    let file = fs::File::create(config.out_dir.join("reference-preview.jpg"))?;
    JpegEncoder::new_with_quality(BufWriter::new(file), 88).encode_image(&preview)?;
    Ok(())
}

pub fn export_relief_textures(
    config: &Config,
    heights: &Grid,
    width_m: f64,
    depth_m: f64,
    pad: usize,
) -> anyhow::Result<Relief> {
    let (width_p, height_p) = (heights.width, heights.height);
    let dy = depth_m / (heights.height - 1) as f64;
    let dx = width_m / (heights.width - 1) as f64;
    let (dy_grid, dx_grid) = gradient(heights, dy, dx);
    let slope_surface = gaussian_filter(heights, config.slope_smooth);
    let (slope_dy, slope_dx) = gradient(&slope_surface, dy, dx);
    let slope = slope_dx
        .data
        .iter()
        .zip(&slope_dy.data)
        .map(|(&x, &y)| x.hypot(y))
        .collect::<Vec<_>>();

    let (hillshade, normal_x, normal_y, normal_z) =
        relief_shade(&dx_grid, &dy_grid, 315.0, 36.0, 0.34);
    let mut shade_acc = vec![0.0; heights.data.len()];
    for az in [0.0, 45.0, 90.0, 135.0, 225.0, 270.0, 315.0] {
        let (shade, _, _, _) = relief_shade(&dx_grid, &dy_grid, az, 38.0, 0.28);
        for (dst, value) in shade_acc.iter_mut().zip(shade.data) {
            *dst += value / 7.0;
        }
    }
    let multishade = Grid::from_vec(heights.width, heights.height, shade_acc)?;
    let reference = Grid::from_vec(
        heights.width,
        heights.height,
        hillshade
            .data
            .iter()
            .zip(&multishade.data)
            .map(|(&h, &m)| (0.68 * h + 0.32 * m).clamp(0.0, 1.0))
            .collect(),
    )?;

    // Crop the apron now: every field above used padded neighbours for its
    // gradient/smoothing, so the visible-edge cells are artifact-free. Saves and
    // normalization below run on the cropped (visible) grid, matching the mesh.
    let heights = heights.crop(pad);
    let slope = Grid::from_vec(width_p, height_p, slope)?.crop(pad).data;
    let hillshade = hillshade.crop(pad);
    let multishade = multishade.crop(pad);
    let reference = reference.crop(pad);
    let normal_x = normal_x.crop(pad);
    let normal_y = normal_y.crop(pad);
    let normal_z = normal_z.crop(pad);
    let (vw, vh) = (heights.width, heights.height);

    tracing::info_span!("encode-relief", file = "terrain-hillshade.png").in_scope(|| {
        save_luma_flipped(
            &config.out_dir.join("terrain-hillshade.png"),
            &normalize_to_u8(&hillshade.data, Some(0.0), Some(1.0)),
            vw,
            vh,
        )
    })?;
    tracing::info_span!("encode-relief", file = "terrain-multishade.png").in_scope(|| {
        save_luma_flipped(
            &config.out_dir.join("terrain-multishade.png"),
            &normalize_to_u8(&multishade.data, Some(0.0), Some(1.0)),
            vw,
            vh,
        )
    })?;
    tracing::info_span!("encode-relief", file = "terrain-slope.png")
        .in_scope(|| save_slope(config, &slope, &multishade, vw, vh))?;
    tracing::info_span!("encode-relief", file = "terrain-hypso.png")
        .in_scope(|| save_hypso(config, &heights, &reference))?;
    tracing::info_span!("encode-relief", file = "terrain-normal.png")
        .in_scope(|| save_normal(config, &normal_x, &normal_y, &normal_z))?;

    if config.bake_relief {
        bake_hillshade_into_topo(config, &reference)?;
    }

    Ok(Relief {
        hillshade,
        multishade,
        reference,
    })
}

pub fn deg2num(lat: f64, lon: f64, zoom: u8) -> (f64, f64) {
    let n = 2.0_f64.powi(i32::from(zoom));
    let x = (lon + 180.0) / 360.0 * n;
    let y = (1.0 - lat.to_radians().tan().asinh() / std::f64::consts::PI) / 2.0 * n;
    (x, y)
}

fn opentopo_tile(config: &Config, tx: u32, ty: u32, zoom: u8) -> anyhow::Result<RgbImage> {
    tracing::info_span!("topo-tile", tx, ty, zoom).in_scope(|| {
        let path = ensure_opentopo_tile(config, tx, ty, zoom)?;
        Ok(image::open(path)?.to_rgb8())
    })
}

fn ensure_opentopo_tile(config: &Config, tx: u32, ty: u32, zoom: u8) -> anyhow::Result<PathBuf> {
    let cache = config.cache_dir.join("otm");
    fs::create_dir_all(&cache)?;
    let path = cache.join(format!("{zoom}_{tx}_{ty}.png"));
    if !path.exists() {
        let url = format!("https://tile.opentopomap.org/{zoom}/{tx}/{ty}.png");
        download_to(&path, &url, &[("User-Agent", "trek-camera-viewer/1.0")], 60)?;
    }
    Ok(path)
}

fn enhance_rgb(image: &mut RgbImage, saturation: f32, brightness: f32, contrast: f32) {
    let saturation = f64::from(saturation);
    let brightness = f64::from(brightness);
    let contrast = f64::from(contrast);

    // Match Pillow's ImageEnhance pipeline used by the Python baker:
    // Color blends against an RGB image converted through L, Brightness blends
    // against black, and Contrast blends against the post-brightness mean L.
    image.as_mut().par_chunks_exact_mut(3).for_each(|pixel| {
        let [r, g, b] = [pixel[0], pixel[1], pixel[2]];
        let gray = pil_luma_u8(r, g, b);
        pixel[0] = blend_u8(gray, r, saturation);
        pixel[1] = blend_u8(gray, g, saturation);
        pixel[2] = blend_u8(gray, b, saturation);
    });

    image
        .as_mut()
        .par_iter_mut()
        .for_each(|channel| *channel = blend_u8(0, *channel, brightness));

    let pixel_count = u64::from(image.width()) * u64::from(image.height());
    let mean_luma = if pixel_count == 0 {
        0
    } else {
        let sum = image
            .as_raw()
            .par_chunks_exact(3)
            .map(|pixel| {
                let [r, g, b] = [pixel[0], pixel[1], pixel[2]];
                u64::from(pil_luma_u8(r, g, b))
            })
            .sum::<u64>();
        ((sum as f64 / pixel_count as f64) + 0.5) as u8
    };
    image
        .as_mut()
        .par_iter_mut()
        .for_each(|channel| *channel = blend_u8(mean_luma, *channel, contrast));
}

fn pil_luma_u8(r: u8, g: u8, b: u8) -> u8 {
    ((299_u32 * u32::from(r) + 587_u32 * u32::from(g) + 114_u32 * u32::from(b) + 500) / 1000) as u8
}

fn blend_u8(degenerate: u8, source: u8, factor: f64) -> u8 {
    (f64::from(degenerate) + (f64::from(source) - f64::from(degenerate)) * factor).clamp(0.0, 255.0)
        as u8
}

fn thumbnail_rgb(image: &RgbImage, max_w: u32, max_h: u32) -> RgbImage {
    let scale = (max_w as f64 / image.width() as f64)
        .min(max_h as f64 / image.height() as f64)
        .min(1.0);
    let width = (image.width() as f64 * scale).round().max(1.0) as u32;
    let height = (image.height() as f64 * scale).round().max(1.0) as u32;
    imageops::resize(image, width, height, FilterType::Lanczos3)
}

fn relief_shade(
    dx: &Grid,
    dy: &Grid,
    azimuth_deg: f64,
    altitude_deg: f64,
    ambient: f64,
) -> (Grid, Grid, Grid, Grid) {
    let az = azimuth_deg.to_radians();
    let alt = altitude_deg.to_radians();
    let light = [alt.cos() * az.sin(), alt.cos() * az.cos(), alt.sin()];
    let mut shade = Grid::new(dx.width, dx.height, 0.0);
    let mut normal_x = Grid::new(dx.width, dx.height, 0.0);
    let mut normal_y = Grid::new(dx.width, dx.height, 0.0);
    let mut normal_z = Grid::new(dx.width, dx.height, 0.0);
    for i in 0..dx.data.len() {
        let mut nx = -dx.data[i];
        let mut ny = -dy.data[i];
        let mut nz = 1.0;
        let norm = (nx * nx + ny * ny + nz * nz).sqrt();
        nx /= norm;
        ny /= norm;
        nz /= norm;
        let lit = (nx * light[0] + ny * light[1] + nz * light[2]).clamp(0.0, 1.0);
        shade.data[i] = ambient + (1.0 - ambient) * lit;
        normal_x.data[i] = nx;
        normal_y.data[i] = ny;
        normal_z.data[i] = nz;
    }
    (shade, normal_x, normal_y, normal_z)
}

fn save_luma_flipped(
    path: &std::path::Path,
    data: &[u8],
    width: usize,
    height: usize,
) -> anyhow::Result<()> {
    let mut out = GrayImage::new(width as u32, height as u32);
    for row in 0..height {
        for col in 0..width {
            out.put_pixel(
                col as u32,
                (height - 1 - row) as u32,
                Luma([data[row * width + col]]),
            );
        }
    }
    out.save(path)?;
    Ok(())
}

fn save_slope(
    config: &Config,
    slope: &[f64],
    multishade: &Grid,
    width: usize,
    height: usize,
) -> anyhow::Result<()> {
    let base = normalize_to_u8(&multishade.data, Some(0.0), Some(1.0));
    let mut out = RgbImage::new(width as u32, height as u32);
    for row in 0..height {
        for col in 0..width {
            let i = row * width + col;
            let slope_deg = slope[i].atan().to_degrees();
            let mut rgb = [base[i], base[i], base[i]];
            for (threshold, color) in [
                (20.0, [244.0, 226.0, 130.0]),
                (27.0, [237.0, 167.0, 64.0]),
                (30.0, [224.0, 91.0, 53.0]),
                (35.0, [180.0, 61.0, 116.0]),
                (40.0, [94.0, 52.0, 118.0]),
                (45.0, [38.0, 35.0, 48.0]),
            ] {
                if slope_deg >= threshold {
                    let factor = 0.72 + 0.34 * multishade.data[i];
                    rgb = color.map(|channel| (channel * factor).round().clamp(0.0, 255.0) as u8);
                }
            }
            out.put_pixel(col as u32, (height - 1 - row) as u32, Rgb(rgb));
        }
    }
    out.save(config.out_dir.join("terrain-slope.png"))?;
    Ok(())
}

fn save_hypso(config: &Config, heights: &Grid, reference: &Grid) -> anyhow::Result<()> {
    let (min_h, max_h) = heights.finite_min_max();
    let h_u8 = normalize_to_u8(&heights.data, Some(min_h), Some(max_h));
    let mut out = RgbImage::new(heights.width as u32, heights.height as u32);
    for row in 0..heights.height {
        for col in 0..heights.width {
            let i = row * heights.width + col;
            let h = f64::from(h_u8[i]);
            let r = interp(h, &[0.0, 80.0, 150.0, 255.0], &[62.0, 118.0, 184.0, 245.0]);
            let g = interp(h, &[0.0, 80.0, 150.0, 255.0], &[94.0, 142.0, 178.0, 239.0]);
            let b = interp(h, &[0.0, 80.0, 150.0, 255.0], &[88.0, 94.0, 132.0, 230.0]);
            let factor = 0.50 + 0.50 * reference.data[i];
            out.put_pixel(
                col as u32,
                (heights.height - 1 - row) as u32,
                Rgb([
                    (r * factor).clamp(0.0, 255.0) as u8,
                    (g * factor).clamp(0.0, 255.0) as u8,
                    (b * factor).clamp(0.0, 255.0) as u8,
                ]),
            );
        }
    }
    out.save(config.out_dir.join("terrain-hypso.png"))?;
    Ok(())
}

fn save_normal(
    config: &Config,
    normal_x: &Grid,
    normal_y: &Grid,
    normal_z: &Grid,
) -> anyhow::Result<()> {
    let mut out = RgbImage::new(normal_x.width as u32, normal_x.height as u32);
    for row in 0..normal_x.height {
        for col in 0..normal_x.width {
            let i = row * normal_x.width + col;
            out.put_pixel(
                col as u32,
                (normal_x.height - 1 - row) as u32,
                Rgb([
                    ((normal_x.data[i] * 0.5 + 0.5) * 255.0).clamp(0.0, 255.0) as u8,
                    ((normal_z.data[i] * 0.5 + 0.5) * 255.0).clamp(0.0, 255.0) as u8,
                    ((-normal_y.data[i] * 0.5 + 0.5) * 255.0).clamp(0.0, 255.0) as u8,
                ]),
            );
        }
    }
    out.save(config.out_dir.join("terrain-normal.png"))?;
    Ok(())
}

fn bake_hillshade_into_topo(config: &Config, reference: &Grid) -> anyhow::Result<()> {
    let path = config.out_dir.join("terrain-texture.png");
    let mut texture = image::open(&path)?.to_rgb8();
    let shade_data = normalize_to_u8(&reference.data, Some(0.0), Some(1.0));
    let mut shade = GrayImage::new(reference.width as u32, reference.height as u32);
    for row in 0..reference.height {
        for col in 0..reference.width {
            shade.put_pixel(
                col as u32,
                (reference.height - 1 - row) as u32,
                Luma([shade_data[row * reference.width + col]]),
            );
        }
    }
    let shade = imageops::resize(
        &shade,
        texture.width(),
        texture.height(),
        FilterType::CatmullRom,
    );
    for (pixel, shade_pixel) in texture.pixels_mut().zip(shade.pixels()) {
        let factor = 0.50 + 0.78 * f32::from(shade_pixel[0]) / 255.0;
        pixel.0 = pixel
            .0
            .map(|channel| (f32::from(channel) * factor).clamp(0.0, 255.0) as u8);
    }
    texture.save(path)?;
    Ok(())
}

fn interp(x: f64, xp: &[f64], fp: &[f64]) -> f64 {
    for i in 1..xp.len() {
        if x <= xp[i] {
            let t = (x - xp[i - 1]) / (xp[i] - xp[i - 1]);
            return fp[i - 1] * (1.0 - t) + fp[i] * t;
        }
    }
    *fp.last().unwrap()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn deg2num_axis_directions() {
        // x grows east, y grows south; floor matches a known tile.
        let (x, y) = deg2num(45.0, 7.0, 8);
        assert_eq!((x.floor() as u32, y.floor() as u32), (132, 92));
        assert!(deg2num(45.0, 8.0, 8).0 > x);
        assert!(deg2num(44.0, 7.0, 8).1 > y);
    }

    #[test]
    fn topo_tile_extent_covers_bbox_in_order() {
        let b = Bounds {
            lo_lo: 7.0,
            lo_hi: 7.2,
            la_lo: 45.0,
            la_hi: 45.2,
        };
        let (tx0, tx1, ty0, ty1) = topo_tile_extent(b, 12);
        assert!(tx0 <= tx1 && ty0 <= ty1);
        // West edge tile index == floor(deg2num x of the west lon).
        assert_eq!(tx0, deg2num(b.la_hi, b.lo_lo, 12).0.floor() as u32);
    }

    #[test]
    fn interp_is_piecewise_linear_and_clamps_past_the_last_knot() {
        let xp = [0.0, 10.0];
        let fp = [0.0, 100.0];
        assert_eq!(interp(0.0, &xp, &fp), 0.0);
        assert_eq!(interp(5.0, &xp, &fp), 50.0);
        assert_eq!(interp(10.0, &xp, &fp), 100.0);
        assert_eq!(interp(99.0, &xp, &fp), 100.0); // beyond last -> last value
    }

    #[test]
    fn pil_luma_matches_pillow_weights() {
        assert_eq!(pil_luma_u8(255, 255, 255), 255);
        assert_eq!(pil_luma_u8(0, 0, 0), 0);
        assert_eq!(pil_luma_u8(255, 0, 0), 76); // 0.299 * 255
        assert_eq!(pil_luma_u8(0, 255, 0), 150); // 0.587 * 255
    }

    #[test]
    fn blend_interpolates_and_clamps() {
        assert_eq!(blend_u8(0, 100, 0.0), 0); // factor 0 -> degenerate
        assert_eq!(blend_u8(0, 100, 1.0), 100); // factor 1 -> source
        assert_eq!(blend_u8(0, 100, 0.5), 50);
        assert_eq!(blend_u8(0, 255, 2.0), 255); // overshoot clamps
    }

    #[test]
    fn relief_shade_of_flat_surface_faces_up() {
        let zero = Grid::new(2, 2, 0.0);
        let (shade, nx, ny, nz) = relief_shade(&zero, &zero, 315.0, 90.0, 0.3);
        // Sun at the zenith on a flat surface -> fully lit, normals point up.
        for i in 0..4 {
            assert!((shade.data[i] - 1.0).abs() < 1e-9);
            assert!((nx.data[i]).abs() < 1e-9);
            assert!((ny.data[i]).abs() < 1e-9);
            assert!((nz.data[i] - 1.0).abs() < 1e-9);
        }
    }

    fn test_config() -> (tempfile::TempDir, Config) {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        let gpx = root.join("route.gpx");
        std::fs::write(&gpx, "<gpx/>").unwrap();
        let out = root.join("out");
        std::fs::create_dir_all(&out).unwrap();
        let mut config = Config::from_paths(
            gpx,
            root.join("reference.png"),
            root.join("angles.png"),
            out,
        )
        .unwrap();
        config.cache_dir = root.join("cache");
        config.tile_zoom = 10;
        config.texture_max = 96;
        config.texture_sat = 1.0;
        config.texture_bright = 1.0;
        config.texture_contrast = 1.0;
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

    fn seed_topo_tiles(config: &Config, bounds: Bounds) {
        let (tx0, tx1, ty0, ty1) = topo_tile_extent(bounds, config.tile_zoom);
        let cache = config.cache_dir.join("otm");
        std::fs::create_dir_all(&cache).unwrap();
        for tx in tx0..=tx1 {
            for ty in ty0..=ty1 {
                let image = RgbImage::from_fn(256, 256, |x, y| {
                    Rgb([(tx % 255) as u8, (ty % 255) as u8, ((x + y) % 255) as u8])
                });
                image
                    .save(cache.join(format!("{}_{}_{}.png", config.tile_zoom, tx, ty)))
                    .unwrap();
            }
        }
    }

    #[test]
    fn export_topographic_texture_mosaics_cached_tiles() {
        let (_dir, config) = test_config();
        let bounds = test_bounds();
        seed_topo_tiles(&config, bounds);
        let zoom = export_topographic_texture(&config, bounds).unwrap();
        assert_eq!(zoom, config.tile_zoom);
        let raw = image::open(config.out_dir.join("terrain-topo-raw.png"))
            .unwrap()
            .to_rgb8();
        let baked = image::open(config.out_dir.join("terrain-texture.png"))
            .unwrap()
            .to_rgb8();
        assert!(raw.width() <= config.texture_max);
        assert!(raw.height() <= config.texture_max);
        assert_eq!(raw.dimensions(), baked.dimensions());
    }

    #[test]
    fn export_reference_images_prefers_reference_then_falls_back_to_texture() {
        let (_dir, config) = test_config();
        RgbImage::from_pixel(1600, 1200, Rgb([10, 20, 30]))
            .save(&config.reference_path)
            .unwrap();
        RgbImage::from_pixel(300, 150, Rgb([40, 50, 60]))
            .save(&config.angles_path)
            .unwrap();
        RgbImage::from_pixel(640, 480, Rgb([70, 80, 90]))
            .save(config.out_dir.join("terrain-texture.png"))
            .unwrap();

        export_reference_images(&config).unwrap();
        assert!(config.out_dir.join("reference-render.png").exists());
        assert!(config.out_dir.join("reference-preview.jpg").exists());
        assert!(config.out_dir.join("angle-sheet.png").exists());
        let preview = image::open(config.out_dir.join("reference-preview.jpg"))
            .unwrap()
            .to_rgb8();
        assert!(preview.width() <= 1200);
        assert!(preview.height() <= 900);

        std::fs::remove_file(&config.reference_path).unwrap();
        std::fs::remove_file(&config.angles_path).unwrap();
        export_reference_images(&config).unwrap();
        assert!(config.out_dir.join("reference-render.png").exists());
    }
}
