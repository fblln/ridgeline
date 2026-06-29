# ridgeline-asset-baker (Rust)

Rust port of the asset baker. Two binaries:

- `baker` — CLI: `baker <gpx> <reference.png> <angles.png> <out-dir>`. The Node dev
  server spawns this by default (set `RIDGELINE_BAKER=python` to use the Python
  baker instead; see `web/server/importJobs.ts`).
- `server` — Axum HTTP service: serves the built web frontend (`web/dist`) and bakes
  uploaded GPX. This is the deployable worker. Binds `RIDGELINE_SERVER_ADDR`
  (default `127.0.0.1:8787`).

## System requirement: GDAL 3.4–3.12

DEM reading, the EPSG:4326→32632 transform, and the bicubic DEM resampling all go
through GDAL (matching the Python baker's rasterio/PROJ bit-for-bit). The `gdal`
0.19 / `gdal-sys` 0.12 crates ship **prebuilt bindings for GDAL 3.4–3.12** — no
bindgen/libclang needed as long as the installed GDAL is in that range.

> GDAL **3.13+ is not yet supported** by the crate. Homebrew's `gdal` is 3.13, so
> on macOS use a 3.12 from conda-forge (below) rather than brew.

### Local build

The build finds GDAL via `gdal-config` on `PATH` (or `pkg-config`).

- **Linux**: `apt-get install libgdal-dev` (Debian/Ubuntu GDAL is in range), then
  `cargo build --release --bins`.
- **macOS / pinned GDAL** (e.g. conda): create `.cargo/config.toml` in this crate
  (gitignored — it's machine-specific) pointing at your GDAL and embedding an rpath
  so the binaries find `libgdal` at runtime:

  ```toml
  [env]
  GDAL_HOME = "/opt/miniconda3/envs/gdal312"
  PKG_CONFIG_PATH = "/opt/miniconda3/envs/gdal312/lib/pkgconfig"

  [build]
  rustflags = ["-C", "link-args=-Wl,-rpath,/opt/miniconda3/envs/gdal312/lib"]
  ```

  Set up that env once with: `conda create -n gdal312 -c conda-forge 'gdal=3.12'`.

`cargo test` exercises the GDAL warp path, so it needs GDAL available too.

## Container

A multi-stage `Dockerfile` (repo root) builds the web frontend + the Rust workers
and ships the `server` on Debian bookworm (GDAL 3.6, in range):

```sh
docker build -t ridgeline-server .
docker run -p 8787:8787 ridgeline-server      # http://localhost:8787
# or, with persistent DEM cache + outputs:
docker compose up --build
```

Runtime env: `RIDGELINE_SERVER_ADDR` (bind addr), `WEB_ROOT` (frontend dir),
`TREK_CACHE` (DEM/tile cache), `RUST_LOG`, `OTEL_EXPORTER_OTLP_ENDPOINT` (optional
trace export).

## Fetch architecture

A cold bake pulls five independent remote sources, each needing only the route
bbox: IGN elevation (France), Piemonte DTM (Italy), OpenTopoMap tiles, Copernicus
forest TCD, and an Overpass border query. Three things keep the cold path fast:

- **Pooled HTTP** — a single process-wide `ureq` agent (`fetch.rs`) reuses
  connections per host; in-memory reads carry an explicit body limit and cache
  writes stream to a temp file + atomic rename.
- **IGN coverage probe** — IGN HD only covers France, so for an Italian (or any
  non-French) track the full grid would be downloaded and discarded. One 64×64
  WMS probe settles coverage first; when dry it skips the full fetch (here
  ~150 MB → 16 KB). A border-straddling track still fetches, because the probe
  sees French cells. Same logic mirrored in the Python baker.
- **All-sources DAG** — `run_inner` fires all five downloads at once in a
  `std::thread::scope` and gates each compute on the join of exactly its input
  (DEM build waits on IGN+Piemonte; topo mosaic on tiles; forest on the TCD;
  border on Overpass). The `warm_*` fills are best-effort — the build/export
  stages stay authoritative and re-fetch on a cache miss, so output is identical
  to a sequential run, only the I/O overlaps. Cold wall drops to ≈ the slowest
  single source instead of their sum.

## Tuning (environment variables)

All knobs are `WEB_*` env vars (the CLI takes only the four positional paths).
Common ones:

| Var | Default | Effect |
|---|---|---|
| `WEB_COMPUTE_THREADS` | `0` (all cores) | rayon global pool for CPU compute (texture passes). `1` = single-threaded compute (rayon parallelism off). Does **not** touch the fetch pools. |
| `WEB_FETCH_WORKERS` | `10` | parallel workers for the chunked IGN WMS fetch (clamped 1–10). |
| `WEB_TILEZOOM` | `17` | OpenTopoMap zoom. Each step down is ~4× fewer tiles and ~½ the texture resolution. |
| `WEB_TEXTURE_MAX` | `8192` | max texture edge in px (downscales above this). |
| `WEB_DEM_RES_M` | `1.0` | IGN grid resolution in metres (drives the IGN fetch size). |
| `WEB_DEM_SOURCE` | `mixed` | `ign` to skip Piemonte (and its prefetch) entirely. |
| `TREK_CACHE` | `~/.cache/trek` | DEM/tile/forest disk cache; point at an empty dir to force a cold bake. |

### Benchmark

On `Morning_Hike.gpx` (26.72 km, 1257×1257 grid; Piemonte/IT), median of 3,
`/usr/bin/time -l`:

| | Cold wall | Warm wall | Warm CPU% | Peak RSS |
|---|---:|---:|---:|---:|
| Rust (rayon on) | 21.4 s | **2.26 s** | 124% | 788 MiB |
| Rust (rayon off) | 20.5 s | 2.72 s | 100% | 789 MiB |
| Python (same DAG) | 33.5 s | 16.9 s | 111% | 1679 MiB |

Cold is network-bound (~21% CPU) and equal across the Rust configs — the DAG
floors it at the slowest single source (~20 s). Warm is pure compute: rayon
spreads the texture passes across cores for ~17% less wall at the same total CPU.
Rust vs Python is a compute + memory story (~7× CPU, ~2× RSS); the network halves
are nearly equal. Full breakdown and the rayon flag: `docs/rust-python-baker-benchmark.md`.

## CI / publish

- `.github/workflows/ci.yml` (`rust-baker` job) installs `libgdal-dev`, then runs
  `cargo fmt`/`clippy`/`test`.
- `.github/workflows/docker.yml` builds the image and pushes it to
  `ghcr.io/<owner>/<repo>` on `main` and `v*` tags.
