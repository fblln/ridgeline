use std::collections::HashMap;
use std::fs;
use std::net::SocketAddr;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::{SystemTime, UNIX_EPOCH};

use anyhow::anyhow;
use axum::body::Bytes;
use axum::extract::{Multipart, Path, Query, State};
use axum::http::StatusCode;
use axum::response::IntoResponse;
use axum::routing::{get, post};
use axum::{Json, Router};
use regex::Regex;
use ridgeline_baker::config::Config;
use ridgeline_baker::run;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tokio::net::TcpListener;
use tower_http::services::ServeDir;

type Jobs = Arc<Mutex<HashMap<String, ImportJob>>>;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ImportJob {
    id: String,
    status: String,
    progress: u8,
    step: String,
    quality: String,
    asset_base: Option<String>,
    error: Option<String>,
    detail: Option<String>,
    log_url: Option<String>,
    created_at: u128,
}

#[derive(Debug, Clone)]
struct AppState {
    jobs: Jobs,
    web_root: PathBuf,
}

#[derive(Debug, Deserialize)]
struct ImportQuery {
    quality: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct StartResponse {
    job_id: String,
    status: String,
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    let _trace_guard = ridgeline_baker::trace::init("ridgeline-server");
    let repo_root = std::env::current_dir()?;
    let web_root = std::env::var_os("WEB_ROOT")
        .map(PathBuf::from)
        .unwrap_or_else(|| repo_root.join("web"));
    let generated_root = web_root.join("public/generated");
    fs::create_dir_all(&generated_root)?;

    let state = AppState {
        jobs: Arc::new(Mutex::new(HashMap::new())),
        web_root,
    };
    let generated = ServeDir::new(generated_root);
    let dist = ServeDir::new(state.web_root.join("dist")).append_index_html_on_directories(true);
    let app = Router::new()
        .route("/api/import-gpx", post(start_import))
        .route("/api/import", post(start_import))
        .route("/api/import-jobs/{id}", get(get_job).delete(cancel_job))
        .route("/api/import/{id}", get(get_job).delete(cancel_job))
        .nest_service("/generated", generated)
        .fallback_service(dist)
        .with_state(state);

    let addr: SocketAddr = std::env::var("RIDGELINE_SERVER_ADDR")
        .unwrap_or_else(|_| "127.0.0.1:8787".to_string())
        .parse()?;
    let listener = TcpListener::bind(addr).await?;
    println!("ridgeline rust server listening on http://{addr}");
    axum::serve(listener, app).await?;
    Ok(())
}

async fn start_import(
    State(state): State<AppState>,
    Query(query): Query<ImportQuery>,
    multipart: Multipart,
) -> Result<Json<StartResponse>, ApiError> {
    let upload = read_multipart_gpx(multipart).await?;
    validate_supported_region(&upload.text)?;
    let quality = parse_quality(query.quality.as_deref());
    let job_id = import_job_id(&upload.text, quality);
    let mut should_start = false;
    {
        let mut jobs = state.jobs.lock().expect("jobs lock");
        prune_jobs(&mut jobs, now_ms());
        if !jobs.contains_key(&job_id) {
            jobs.insert(
                job_id.clone(),
                ImportJob {
                    id: job_id.clone(),
                    status: "queued".to_string(),
                    progress: 2,
                    step: "Queued".to_string(),
                    quality: quality.to_string(),
                    asset_base: None,
                    error: None,
                    detail: None,
                    log_url: None,
                    created_at: now_ms(),
                },
            );
            should_start = true;
        }
    }

    if should_start {
        let job_id_for_task = job_id.clone();
        let task_state = state.clone();
        tokio::spawn(async move {
            run_job(task_state, job_id_for_task, upload, quality).await;
        });
    }

    let status = state
        .jobs
        .lock()
        .expect("jobs lock")
        .get(&job_id)
        .map(|job| job.status.clone())
        .unwrap_or_else(|| "queued".to_string());
    Ok(Json(StartResponse { job_id, status }))
}

async fn get_job(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> Result<Json<ImportJob>, ApiError> {
    let jobs = state.jobs.lock().expect("jobs lock");
    jobs.get(&id)
        .cloned()
        .map(Json)
        .ok_or(ApiError::not_found("Unknown import job."))
}

async fn cancel_job(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> Result<Json<ImportJob>, ApiError> {
    let mut jobs = state.jobs.lock().expect("jobs lock");
    let job = jobs
        .get_mut(&id)
        .ok_or(ApiError::not_found("Unknown import job."))?;
    if job.status == "queued" || job.status == "processing" {
        job.status = "error".to_string();
        job.error = Some("Import cancelled.".to_string());
        job.step = "Cancelled".to_string();
    }
    Ok(Json(job.clone()))
}

async fn run_job(state: AppState, job_id: String, upload: UploadedGpx, quality: &'static str) {
    let result = tokio::task::spawn_blocking({
        let state = state.clone();
        let job_id = job_id.clone();
        move || run_job_blocking(state, &job_id, upload, quality)
    })
    .await;

    if let Err(error) = result {
        mark_error(
            &state.jobs,
            &job_id,
            &format!("Import task failed: {error}"),
        );
    }
}

fn run_job_blocking(
    state: AppState,
    job_id: &str,
    upload: UploadedGpx,
    quality: &str,
) -> anyhow::Result<()> {
    let job_span = tracing::info_span!(
        "import-job",
        "import.job_id" = job_id,
        "import.quality" = quality,
        "import.source" = %upload.filename
    );
    let _job_enter = job_span.enter();

    let generated_root = state.web_root.join("public/generated");
    let upload_root = generated_root.join(".uploads");
    let out_dir = generated_root.join(job_id);
    let gpx_path = upload_root.join(format!("{job_id}.gpx"));
    let manifest_path = out_dir.join("manifest.json");
    fs::create_dir_all(&upload_root)?;
    fs::create_dir_all(&out_dir)?;
    fs::write(&gpx_path, &upload.text)?;

    if manifest_path.exists() {
        let mut jobs = state.jobs.lock().expect("jobs lock");
        if let Some(job) = jobs.get_mut(job_id) {
            job.status = "ready".to_string();
            job.progress = 100;
            job.step = "Loaded from cache".to_string();
            job.asset_base = Some(format!("/generated/{job_id}/"));
        }
        return Ok(());
    }

    update_job(&state.jobs, job_id, 5, "Starting worker", None);
    fs::remove_dir_all(&out_dir).ok();
    fs::create_dir_all(&out_dir)?;

    let mut config = Config::from_paths(
        gpx_path,
        upload_root.join(format!("{job_id}-reference-not-required.png")),
        upload_root.join(format!("{job_id}-angles-not-required.png")),
        out_dir.clone(),
    )?;
    apply_quality(&mut config, quality);
    let stem = PathBuf::from(&upload.filename)
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("imported-route")
        .to_string();
    config.route_id = ridgeline_baker::gpx::slugify(&stem);
    config.route_name = title_from_filename(&upload.filename);
    config.source_name = upload.filename.clone();

    let logs = Arc::new(Mutex::new(vec![format!(
        "# {} quality={} source={}",
        now_ms(),
        quality,
        upload.filename
    )]));
    let progress_jobs = state.jobs.clone();
    let progress_id = job_id.to_string();
    let progress_logs = logs.clone();
    let run_result = run(config, |pct, label| {
        progress_logs
            .lock()
            .expect("logs lock")
            .push(format!("progress:{pct} {label}"));
        update_job(&progress_jobs, &progress_id, pct, label, None);
    });

    let log_path = out_dir.join("build.log");
    match run_result {
        Ok(()) => {
            logs.lock().expect("logs lock").push("# exit=0".to_string());
            fs::write(&log_path, logs.lock().expect("logs lock").join("\n")).ok();
            let mut jobs = state.jobs.lock().expect("jobs lock");
            if let Some(job) = jobs.get_mut(job_id) {
                job.status = "ready".to_string();
                job.progress = 100;
                job.step = "Ready".to_string();
                job.asset_base = Some(format!("/generated/{job_id}/"));
                job.log_url = Some(format!("/generated/{job_id}/build.log"));
            }
            Ok(())
        }
        Err(error) => {
            let message = format!("{error:#}");
            logs.lock()
                .expect("logs lock")
                .push(format!("Error: {message}"));
            logs.lock().expect("logs lock").push("# exit=1".to_string());
            fs::write(&log_path, logs.lock().expect("logs lock").join("\n")).ok();
            mark_error(
                &state.jobs,
                job_id,
                &format!("Asset generation failed: Error: {message}"),
            );
            Err(error)
        }
    }
}

fn update_job(jobs: &Jobs, job_id: &str, progress: u8, step: &str, detail: Option<String>) {
    let mut jobs = jobs.lock().expect("jobs lock");
    if let Some(job) = jobs.get_mut(job_id)
        && job.status != "error"
    {
        job.status = "processing".to_string();
        job.progress = progress.min(99);
        job.step = step.chars().take(80).collect();
        job.detail = detail;
    }
}

fn mark_error(jobs: &Jobs, job_id: &str, message: &str) {
    let mut jobs = jobs.lock().expect("jobs lock");
    if let Some(job) = jobs.get_mut(job_id) {
        job.status = "error".to_string();
        job.step = "Import failed".to_string();
        job.error = Some(message.chars().take(300).collect());
    }
}

#[derive(Debug)]
struct UploadedGpx {
    filename: String,
    text: String,
}

async fn read_multipart_gpx(mut multipart: Multipart) -> Result<UploadedGpx, ApiError> {
    while let Some(field) = multipart
        .next_field()
        .await
        .map_err(ApiError::bad_request)?
    {
        if field.name() != Some("file") {
            continue;
        }
        let filename = field
            .file_name()
            .unwrap_or("imported-route.gpx")
            .to_string();
        let bytes: Bytes = field.bytes().await.map_err(ApiError::bad_request)?;
        let text = String::from_utf8(bytes.to_vec()).map_err(ApiError::bad_request)?;
        if !text.contains("<gpx") || !text.contains("<trkpt") {
            return Err(ApiError::bad_request(anyhow!(
                "Uploaded file does not look like a GPX track."
            )));
        }
        return Ok(UploadedGpx { filename, text });
    }
    Err(ApiError::bad_request(anyhow!("Missing GPX file upload.")))
}

fn validate_supported_region(gpx_text: &str) -> Result<(), ApiError> {
    let bounds = parse_bounds(gpx_text)?;
    if bounds.point_count > 250_000 {
        return Err(ApiError::bad_request(anyhow!(
            "GPX has too many points. Simplify it below 250k points first."
        )));
    }
    let france = Region {
        west: -5.3,
        south: 41.2,
        east: 9.75,
        north: 51.3,
    };
    let piemonte = Region {
        west: 6.55,
        south: 44.0,
        east: 9.25,
        north: 46.55,
    };
    if bounds.inside(france) || bounds.inside(piemonte) {
        Ok(())
    } else {
        Err(ApiError::bad_request(anyhow!(
            "This GPX is outside the supported Piemonte/France area."
        )))
    }
}

#[derive(Debug, Clone, Copy)]
struct Region {
    west: f64,
    south: f64,
    east: f64,
    north: f64,
}

#[derive(Debug, Clone, Copy)]
struct GpxBounds {
    west: f64,
    south: f64,
    east: f64,
    north: f64,
    point_count: usize,
}

impl GpxBounds {
    fn inside(self, region: Region) -> bool {
        self.west >= region.west
            && self.east <= region.east
            && self.south >= region.south
            && self.north <= region.north
    }
}

fn parse_bounds(gpx_text: &str) -> Result<GpxBounds, ApiError> {
    let re =
        Regex::new(r#"<trkpt[^>]*lat="([^"]+)"[^>]*lon="([^"]+)""#).expect("valid bounds regex");
    let mut west = f64::INFINITY;
    let mut south = f64::INFINITY;
    let mut east = f64::NEG_INFINITY;
    let mut north = f64::NEG_INFINITY;
    let mut point_count = 0;
    for capture in re.captures_iter(gpx_text) {
        let lat = capture[1].parse::<f64>().map_err(ApiError::bad_request)?;
        let lon = capture[2].parse::<f64>().map_err(ApiError::bad_request)?;
        west = west.min(lon);
        east = east.max(lon);
        south = south.min(lat);
        north = north.max(lat);
        point_count += 1;
    }
    if point_count < 2 {
        return Err(ApiError::bad_request(anyhow!(
            "GPX must contain at least two track points."
        )));
    }
    Ok(GpxBounds {
        west,
        south,
        east,
        north,
        point_count,
    })
}

fn parse_quality(value: Option<&str>) -> &'static str {
    match value {
        Some("fast") => "fast",
        Some("ultra") => "ultra",
        _ => "high",
    }
}

fn apply_quality(config: &mut Config, quality: &str) {
    config.fetch_workers = std::env::var("WEB_FETCH_WORKERS")
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(16);
    match quality {
        "fast" => {
            config.target_res_m = 8.0;
            config.grid_max = 1200;
            config.texture_max = 4096;
            config.tile_zoom = 15;
            config.dem_res_m = 5.0;
            config.route_step_m = 6.0;
            config.forest_px = 1024;
        }
        "ultra" => {
            config.target_res_m = 3.0;
            config.grid_max = 3200;
            config.texture_max = 8192;
            config.tile_zoom = 17;
            config.dem_res_m = 1.0;
            config.route_step_m = 2.0;
            config.forest_px = 2048;
        }
        _ => {
            config.target_res_m = 5.0;
            config.grid_max = 2200;
            config.texture_max = 8192;
            config.tile_zoom = 16;
            config.dem_res_m = 2.0;
            config.route_step_m = 3.0;
            config.forest_px = 1536;
        }
    }
}

fn import_job_id(gpx_text: &str, quality: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(gpx_text.as_bytes());
    hasher.update(quality.as_bytes());
    hasher.update(b"ridgeline-import-v1");
    hex::encode(hasher.finalize())[..16].to_string()
}

fn title_from_filename(filename: &str) -> String {
    let stem = PathBuf::from(filename)
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("Imported route")
        .replace(['_', '-'], " ");
    let title = stem
        .split_whitespace()
        .map(|word| {
            let mut chars = word.chars();
            match chars.next() {
                Some(first) => {
                    first.to_uppercase().collect::<String>() + &chars.as_str().to_lowercase()
                }
                None => String::new(),
            }
        })
        .collect::<Vec<_>>()
        .join(" ");
    if title.is_empty() {
        "Imported route".to_string()
    } else {
        title
    }
}

/// Finished jobs are kept this long so the frontend can read the final status,
/// then evicted to bound memory on a long-running server.
const JOB_TTL_MS: u128 = 3_600_000; // 1 hour

/// Drop terminal ("ready"/"error") jobs older than the TTL. Active jobs
/// ("queued"/"processing") are always retained regardless of age.
fn prune_jobs(jobs: &mut HashMap<String, ImportJob>, now: u128) {
    jobs.retain(|_, job| {
        let terminal = job.status == "ready" || job.status == "error";
        !(terminal && now.saturating_sub(job.created_at) > JOB_TTL_MS)
    });
}

fn now_ms() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
}

#[derive(Debug)]
struct ApiError {
    status: StatusCode,
    message: String,
}

impl ApiError {
    fn bad_request(error: impl Into<anyhow::Error>) -> Self {
        Self {
            status: StatusCode::BAD_REQUEST,
            message: error.into().to_string(),
        }
    }

    fn not_found(message: &str) -> Self {
        Self {
            status: StatusCode::NOT_FOUND,
            message: message.to_string(),
        }
    }
}

impl IntoResponse for ApiError {
    fn into_response(self) -> axum::response::Response {
        (
            self.status,
            Json(serde_json::json!({ "status": "error", "message": self.message })),
        )
            .into_response()
    }
}
