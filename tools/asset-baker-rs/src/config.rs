use std::env;
use std::path::{Path, PathBuf};

use anyhow::{Context, anyhow};

use crate::gpx::{route_title_from_stem, slugify};

#[derive(Debug, Clone)]
pub struct Config {
    pub gpx_path: PathBuf,
    pub reference_path: PathBuf,
    pub angles_path: PathBuf,
    pub out_dir: PathBuf,
    pub route_id: String,
    pub route_name: String,
    pub source_name: String,
    pub cache_dir: PathBuf,
    pub grid: Option<usize>,
    pub target_res_m: f64,
    pub grid_min: usize,
    pub grid_max: usize,
    pub margin: f64,
    pub edge_pad: usize,
    pub dem_source: String,
    pub dem_res_m: f64,
    pub wms_max: usize,
    pub piemonte_sample_order: usize,
    pub tile_zoom: u8,
    pub texture_max: u32,
    pub texture_sat: f32,
    pub texture_bright: f32,
    pub texture_contrast: f32,
    pub route_step_m: f64,
    pub mesh_smooth: f64,
    pub relief_smooth: f64,
    pub slope_smooth: f64,
    pub bake_relief: bool,
    pub dem_contours: bool,
    pub contour_minor_m: f64,
    pub contour_major_m: f64,
    pub forest_px: u32,
    pub forest_min_tcd: f32,
    pub forest_url: String,
    pub fetch_workers: usize,
    /// Threads for the rayon global pool used by CPU compute (texture passes).
    /// 0 = rayon default (all cores). 1 = single-threaded compute (rayon off).
    /// Does not affect the explicitly-sized fetch pools.
    pub compute_threads: usize,
}

pub fn cli_args_to_config(args: &[PathBuf]) -> anyhow::Result<Config> {
    let repo_root = repo_root()?;
    let gpx_path = args
        .first()
        .cloned()
        .unwrap_or_else(|| repo_root.join("examples/gpx/Escursione_mattutina.gpx"));
    let reference_path = args
        .get(1)
        .cloned()
        .unwrap_or_else(|| repo_root.join("examples/reference/Escursione_mattutina-final.png"));
    let angles_path = args
        .get(2)
        .cloned()
        .unwrap_or_else(|| repo_root.join("examples/reference/Escursione_mattutina-angles.png"));
    let out_dir = args
        .get(3)
        .cloned()
        .unwrap_or_else(|| repo_root.join("web/public/assets/escursione-mattutina"));

    Config::from_paths(gpx_path, reference_path, angles_path, out_dir)
}

impl Config {
    pub fn from_paths(
        gpx_path: PathBuf,
        reference_path: PathBuf,
        angles_path: PathBuf,
        out_dir: PathBuf,
    ) -> anyhow::Result<Self> {
        let stem = gpx_path
            .file_stem()
            .and_then(|s| s.to_str())
            .ok_or_else(|| anyhow!("GPX path has no UTF-8 file stem: {}", gpx_path.display()))?;
        let filename = gpx_path
            .file_name()
            .and_then(|s| s.to_str())
            .unwrap_or("route.gpx")
            .to_string();

        Self {
            route_id: env_string("WEB_ROUTE_ID").unwrap_or_else(|| slugify(stem)),
            route_name: env_string("WEB_ROUTE_NAME").unwrap_or_else(|| route_title_from_stem(stem)),
            source_name: env_string("WEB_SOURCE_NAME").unwrap_or(filename),
            cache_dir: env_path("TREK_CACHE").unwrap_or_else(default_cache_dir),
            grid: env_optional("WEB_GRID")?,
            target_res_m: env_parse("WEB_TARGET_RES_M", 5.0)?,
            grid_min: env_parse("WEB_GRID_MIN", 700)?,
            grid_max: env_parse("WEB_GRID_MAX", 3000)?,
            margin: env_parse("WEB_MARGIN", 0.0025)?,
            edge_pad: env_parse("WEB_EDGE_PAD", 8)?,
            dem_source: env_string("WEB_DEM_SOURCE").unwrap_or_else(|| "mixed".to_string()),
            dem_res_m: env_parse("WEB_DEM_RES_M", 1.0)?,
            wms_max: env_parse("WEB_WMS_MAX", 1200)?,
            piemonte_sample_order: env_parse("WEB_PIEMONTE_SAMPLE_ORDER", 1)?,
            tile_zoom: env_parse("WEB_TILEZOOM", 17)?,
            texture_max: env_parse("WEB_TEXTURE_MAX", 8192)?,
            texture_sat: env_parse("WEB_TEXTURE_SAT", 1.45)?,
            texture_bright: env_parse("WEB_TEXTURE_BRIGHT", 0.82)?,
            texture_contrast: env_parse("WEB_TEXTURE_CONTRAST", 1.16)?,
            route_step_m: env_parse("WEB_ROUTE_STEP_M", 2.0)?,
            mesh_smooth: env_parse("WEB_MESH_SMOOTH", 0.0)?,
            relief_smooth: env_parse("WEB_RELIEF_SMOOTH", 0.10)?,
            slope_smooth: env_parse("WEB_SLOPE_SMOOTH", 0.6)?,
            bake_relief: env_bool("WEB_BAKE_RELIEF", false),
            dem_contours: env_bool("WEB_DEM_CONTOURS", false),
            contour_minor_m: env_parse("WEB_CONTOUR_MINOR_M", 40.0)?,
            contour_major_m: env_parse("WEB_CONTOUR_MAJOR_M", 200.0)?,
            forest_px: env_parse("WEB_FOREST_PX", 2048)?,
            forest_min_tcd: env_parse("WEB_FOREST_MIN_TCD", 50.0)?,
            forest_url: env_string("WEB_FOREST_URL").unwrap_or_else(|| {
                "https://image.discomap.eea.europa.eu/arcgis/rest/services/GioLandPublic/HRL_TreeCoverDensity_2018/ImageServer/exportImage".to_string()
            }),
            fetch_workers: env_parse("WEB_FETCH_WORKERS", 10)?.clamp(1, 10),
            compute_threads: env_parse("WEB_COMPUTE_THREADS", 0)?,
            gpx_path,
            reference_path,
            angles_path,
            out_dir,
        }
        .validated()
    }

    /// Fail fast on out-of-range env knobs with a clear message, rather than
    /// panicking or producing garbage deep inside GDAL / image encoding.
    pub fn validated(self) -> anyhow::Result<Self> {
        let positive_f64 = [
            ("WEB_TARGET_RES_M", self.target_res_m),
            ("WEB_DEM_RES_M", self.dem_res_m),
        ];
        for (name, value) in positive_f64 {
            if !(value.is_finite() && value > 0.0) {
                anyhow::bail!("{name} must be a positive finite number, got {value}");
            }
        }
        if self.margin < 0.0 || !self.margin.is_finite() {
            anyhow::bail!("WEB_MARGIN must be >= 0, got {}", self.margin);
        }
        if self.grid_min == 0 || self.grid_min > self.grid_max {
            anyhow::bail!(
                "WEB_GRID_MIN ({}) must be in 1..=WEB_GRID_MAX ({})",
                self.grid_min,
                self.grid_max
            );
        }
        if let Some(grid) = self.grid
            && grid < 2
        {
            anyhow::bail!("WEB_GRID must be >= 2, got {grid}");
        }
        if self.wms_max == 0 {
            anyhow::bail!("WEB_WMS_MAX must be >= 1");
        }
        if self.forest_px == 0 {
            anyhow::bail!("WEB_FOREST_PX must be >= 1");
        }
        if self.texture_max == 0 {
            anyhow::bail!("WEB_TEXTURE_MAX must be >= 1");
        }
        if self.tile_zoom > 22 {
            anyhow::bail!("WEB_TILEZOOM must be 0..=22, got {}", self.tile_zoom);
        }
        Ok(self)
    }
}

fn repo_root() -> anyhow::Result<PathBuf> {
    let manifest_dir = Path::new(env!("CARGO_MANIFEST_DIR"));
    manifest_dir
        .ancestors()
        .nth(2)
        .map(Path::to_path_buf)
        .context("failed to resolve repository root")
}

fn env_string(name: &str) -> Option<String> {
    env::var(name).ok().filter(|value| !value.is_empty())
}

fn env_path(name: &str) -> Option<PathBuf> {
    env_string(name).map(PathBuf::from)
}

fn env_bool(name: &str, default: bool) -> bool {
    match env_string(name).as_deref() {
        Some("1" | "true" | "yes") => true,
        Some("0" | "false" | "no") => false,
        Some(_) => default,
        None => default,
    }
}

fn env_optional<T>(name: &str) -> anyhow::Result<Option<T>>
where
    T: std::str::FromStr,
    T::Err: std::error::Error + Send + Sync + 'static,
{
    env_string(name)
        .map(|value| {
            value
                .parse::<T>()
                .with_context(|| format!("invalid {name}={value:?}"))
        })
        .transpose()
}

fn env_parse<T>(name: &str, default: T) -> anyhow::Result<T>
where
    T: std::str::FromStr,
    T::Err: std::error::Error + Send + Sync + 'static,
{
    match env_string(name) {
        Some(value) => value
            .parse::<T>()
            .with_context(|| format!("invalid {name}={value:?}")),
        None => Ok(default),
    }
}

fn default_cache_dir() -> PathBuf {
    env::var_os("HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("."))
        .join(".cache/trek")
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::ffi::OsString;
    use std::sync::{Mutex, OnceLock};

    fn env_lock() -> &'static Mutex<()> {
        static LOCK: OnceLock<Mutex<()>> = OnceLock::new();
        LOCK.get_or_init(|| Mutex::new(()))
    }

    struct EnvGuard {
        saved: Vec<(&'static str, Option<OsString>)>,
    }

    impl EnvGuard {
        fn set(pairs: &[(&'static str, &str)]) -> Self {
            let mut saved = Vec::with_capacity(pairs.len());
            for &(name, value) in pairs {
                saved.push((name, env::var_os(name)));
                unsafe { env::set_var(name, value) };
            }
            Self { saved }
        }
    }

    impl Drop for EnvGuard {
        fn drop(&mut self) {
            for (name, value) in self.saved.drain(..).rev() {
                match value {
                    Some(value) => unsafe { env::set_var(name, value) },
                    None => unsafe { env::remove_var(name) },
                }
            }
        }
    }

    fn sample_paths() -> (PathBuf, PathBuf, PathBuf, PathBuf) {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.keep();
        (
            root.join("Morning_Hike.gpx"),
            root.join("reference.png"),
            root.join("angles.png"),
            root.join("out"),
        )
    }

    #[test]
    fn from_paths_reads_env_overrides() {
        let _guard = env_lock().lock().unwrap();
        let _env = EnvGuard::set(&[
            ("WEB_ROUTE_ID", "custom-id"),
            ("WEB_ROUTE_NAME", "Custom Route"),
            ("WEB_SOURCE_NAME", "custom.gpx"),
            ("TREK_CACHE", "/tmp/ridgeline-cache"),
            ("WEB_GRID", "1024"),
            ("WEB_TARGET_RES_M", "8.5"),
            ("WEB_GRID_MIN", "128"),
            ("WEB_GRID_MAX", "2048"),
            ("WEB_MARGIN", "0.01"),
            ("WEB_EDGE_PAD", "4"),
            ("WEB_DEM_SOURCE", "ign"),
            ("WEB_DEM_RES_M", "2.5"),
            ("WEB_WMS_MAX", "512"),
            ("WEB_PIEMONTE_SAMPLE_ORDER", "2"),
            ("WEB_TILEZOOM", "12"),
            ("WEB_TEXTURE_MAX", "4096"),
            ("WEB_TEXTURE_SAT", "1.2"),
            ("WEB_TEXTURE_BRIGHT", "0.9"),
            ("WEB_TEXTURE_CONTRAST", "1.1"),
            ("WEB_ROUTE_STEP_M", "6.0"),
            ("WEB_MESH_SMOOTH", "0.4"),
            ("WEB_RELIEF_SMOOTH", "0.2"),
            ("WEB_SLOPE_SMOOTH", "0.8"),
            ("WEB_BAKE_RELIEF", "yes"),
            ("WEB_DEM_CONTOURS", "true"),
            ("WEB_CONTOUR_MINOR_M", "25"),
            ("WEB_CONTOUR_MAJOR_M", "100"),
            ("WEB_FOREST_PX", "512"),
            ("WEB_FOREST_MIN_TCD", "60"),
            ("WEB_FOREST_URL", "https://example.test/forest"),
            ("WEB_FETCH_WORKERS", "99"),
            ("WEB_COMPUTE_THREADS", "3"),
        ]);
        let (gpx, reference, angles, out) = sample_paths();
        let config = Config::from_paths(gpx, reference, angles, out).unwrap();
        assert_eq!(config.route_id, "custom-id");
        assert_eq!(config.route_name, "Custom Route");
        assert_eq!(config.source_name, "custom.gpx");
        assert_eq!(config.cache_dir, PathBuf::from("/tmp/ridgeline-cache"));
        assert_eq!(config.grid, Some(1024));
        assert_eq!(config.target_res_m, 8.5);
        assert_eq!(config.grid_min, 128);
        assert_eq!(config.grid_max, 2048);
        assert_eq!(config.margin, 0.01);
        assert_eq!(config.edge_pad, 4);
        assert_eq!(config.dem_source, "ign");
        assert_eq!(config.dem_res_m, 2.5);
        assert_eq!(config.wms_max, 512);
        assert_eq!(config.piemonte_sample_order, 2);
        assert_eq!(config.tile_zoom, 12);
        assert_eq!(config.texture_max, 4096);
        assert_eq!(config.texture_sat, 1.2);
        assert_eq!(config.texture_bright, 0.9);
        assert_eq!(config.texture_contrast, 1.1);
        assert_eq!(config.route_step_m, 6.0);
        assert_eq!(config.mesh_smooth, 0.4);
        assert_eq!(config.relief_smooth, 0.2);
        assert_eq!(config.slope_smooth, 0.8);
        assert!(config.bake_relief);
        assert!(config.dem_contours);
        assert_eq!(config.contour_minor_m, 25.0);
        assert_eq!(config.contour_major_m, 100.0);
        assert_eq!(config.forest_px, 512);
        assert_eq!(config.forest_min_tcd, 60.0);
        assert_eq!(config.forest_url, "https://example.test/forest");
        assert_eq!(config.fetch_workers, 10);
        assert_eq!(config.compute_threads, 3);
    }

    #[test]
    fn from_paths_uses_stem_defaults_and_invalid_bool_falls_back() {
        let _guard = env_lock().lock().unwrap();
        let _env = EnvGuard::set(&[("WEB_BAKE_RELIEF", "maybe"), ("WEB_DEM_CONTOURS", "wat")]);
        let (gpx, reference, angles, out) = sample_paths();
        let config = Config::from_paths(gpx, reference, angles, out).unwrap();
        assert_eq!(config.route_id, "morning-hike");
        assert_eq!(config.route_name, "Morning Hike");
        assert_eq!(config.source_name, "Morning_Hike.gpx");
        assert!(!config.bake_relief);
        assert!(!config.dem_contours);
    }

    #[test]
    fn validated_rejects_invalid_ranges() {
        let (gpx, reference, angles, out) = sample_paths();
        let mut config = Config::from_paths(gpx, reference, angles, out).unwrap();

        config.target_res_m = 0.0;
        assert!(config.clone().validated().is_err());

        config.target_res_m = 5.0;
        config.margin = -0.1;
        assert!(config.clone().validated().is_err());

        config.margin = 0.0025;
        config.grid_min = 0;
        assert!(config.clone().validated().is_err());

        config.grid_min = 10;
        config.grid_max = 9;
        assert!(config.clone().validated().is_err());

        config.grid_max = 20;
        config.grid = Some(1);
        assert!(config.clone().validated().is_err());

        config.grid = Some(20);
        config.wms_max = 0;
        assert!(config.clone().validated().is_err());

        config.wms_max = 1;
        config.forest_px = 0;
        assert!(config.clone().validated().is_err());

        config.forest_px = 1;
        config.texture_max = 0;
        assert!(config.clone().validated().is_err());

        config.texture_max = 1;
        config.tile_zoom = 23;
        assert!(config.validated().is_err());
    }

    #[test]
    fn cli_args_to_config_honors_explicit_paths() {
        let _guard = env_lock().lock().unwrap();
        let args = vec![
            PathBuf::from("/tmp/in.gpx"),
            PathBuf::from("/tmp/ref.png"),
            PathBuf::from("/tmp/angles.png"),
            PathBuf::from("/tmp/out"),
        ];
        let config = cli_args_to_config(&args).unwrap();
        assert_eq!(config.gpx_path, args[0]);
        assert_eq!(config.reference_path, args[1]);
        assert_eq!(config.angles_path, args[2]);
        assert_eq!(config.out_dir, args[3]);
    }
}
