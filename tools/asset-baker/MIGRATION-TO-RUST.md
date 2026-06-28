# Migrating the asset baker from Python to Rust

The only Python in this repo is `tools/asset-baker/` (the GPX→assets baker, ~900 LOC across 5
files). `web/`, `examples/`, and the generated asset format stay. "Migrate all the Python" =
replace that one component with Rust: a baker library + a CLI + (for prod) an HTTP server, A/B'd
behind a flag, then delete the Python.

This single doc is both the **reference** (the contract the Rust code must honor, the dependency
map, the fidelity traps) and the **plan** (locked decisions, crate layout, phased work with a gate
per phase, prod deployment, performance, cutover). Read Part A before writing any Rust; execute
Part B.

**Guiding fact:** the viewer is a *tolerant* consumer (it reads numbers and renders them).
Target **functional/numeric equivalence within a stated tolerance**, not byte-identical files.
Chasing byte-equality on PNG/JPEG encoders and float JSON formatting is wasted effort.

---
---

# Part A — Reference (the contract & risks)

## A1. What must not break (the external contract)

The web import server spawns the baker as a subprocess today (`web/server/importJobs.ts`). The
Rust binary must honor the same four things; in prod the contract moves in-process (Part B,
Production deployment) but the *semantics* below are unchanged.

### A1a. CLI
```
export_web_example.py <gpx> <reference.png> <angles.png> <out_dir>
```
All four positional, all optional with repo-root defaults (`pipeline.py:770`). The server always
passes all four; `<reference.png>`/`<angles.png>` are intentionally non-existent paths in the
import flow (the baker falls back to using the topo texture as the reference render —
`pipeline.py:638,652`).

### A1b. Environment variables (all read at runtime, no config file)

| Var | Default | Used in | Meaning |
|---|---|---|---|
| `WEB_ROUTE_ID` | slug of stem | route id | |
| `WEB_ROUTE_NAME` | titled stem | route name | |
| `WEB_SOURCE_NAME` | gpx filename | attribution | |
| `WEB_GRID` | unset | grid sizing | force fixed grid, bypass res calc |
| `WEB_TARGET_RES_M` | `5` | grid sizing | m/cell target |
| `WEB_GRID_MIN` / `WEB_GRID_MAX` | `700` / `3000` | grid sizing | clamp |
| `WEB_MARGIN` | `0.0025` | bbox | deg padding around route |
| `WEB_DEM_SOURCE` | `mixed` | DEM | `mixed` (Piemonte+IGN) or `ign` |
| `WEB_DEM_RES_M` | `1.0` | IGN/WMS | m/cell for IGN grid |
| `WEB_WMS_MAX` | `5010` | IGN/WMS | max px per WMS tile request |
| `WEB_PIEMONTE_SAMPLE_ORDER` | `1` | sampling | map_coordinates spline order |
| `WEB_TILEZOOM` | `17` | topo | OpenTopoMap zoom |
| `WEB_TEXTURE_MAX` | `8192` | topo | max texture px (thumbnail) |
| `WEB_TEXTURE_SAT/BRIGHT/CONTRAST` | `1.45`/`0.82`/`1.16` | topo | PIL enhance |
| `WEB_ROUTE_STEP_M` | `2.0` | route | simplify spacing |
| `WEB_MESH_SMOOTH` | `0.0` | mesh | gaussian sigma on heights (0 = off) |
| `WEB_RELIEF_SMOOTH` | `0.10` | relief | gaussian sigma for relief |
| `WEB_SLOPE_SMOOTH` | `0.6` | relief | gaussian sigma for slope |
| `WEB_BAKE_RELIEF` | `0` | topo | bake hillshade into topo |
| `WEB_DEM_CONTOURS` | `0` | topo | draw contour lines (off → can defer port) |
| `WEB_CONTOUR_MINOR_M/MAJOR_M` | `40`/`200` | contours | |
| `WEB_FOREST_PX` | `2048` | forest | export width px |
| `WEB_FOREST_MIN_TCD` | `50` | forest | canopy % threshold |
| `WEB_FOREST_URL` | EEA discomap | forest | override |
| `WEB_FETCH_WORKERS` | `16` | all fetches | thread pool size |
| `TREK_CACHE` | `~/.cache/trek` | all fetches | disk cache root |
| `TRACEPARENT`, `OTEL_*` | — | tracing | W3C trace continuation (A5) |

Quality presets (`fast`/`high`/`ultra`) are just env bundles set by the server
(`importValidation.ts:76` → `qualityEnv`). Region/point-count validation also lives server-side
(`validateSupportedRegion`) — **not** in the baker (it moves to the Rust server in Part B).

### A1c. stdout/stderr protocol
The server parses lines (`importJobs.ts:146`):
- `progress:<int> <label>` → headline step (regex `^progress:(\d+)\s+(.*)$`). 9 calls at pct
  8/22/58/70/82/90/97 (`progress()` in `pipeline.py:34`). Keep them.
- any other non-empty line → "detail" (last one wins).
- failure surfaced via `lastErrorLine` (`importValidation.ts:13`): greps the log bottom-up for
  `^\w[\w.]*(Error|Exception|Warning):`. A Rust panic won't match — on fatal error **print
  `Error: <msg>` before exiting non-zero**, or the UI shows a generic "exit N".

*(In the prod server this becomes an in-process progress callback + structured job error — same
semantics, no text parsing. See Part B.)*

### A1d. Exit code
`0` = success (server reads `manifest.json`). Non-zero = failure.

### A1e. Output files written to `<out_dir>`
Viewer reads these (confirmed via grep over `web/src` — it reads `terrain.json` heights+dims,
`route.json` points, `manifest.json`, `border.json`, and textures by filename). Formats are the
hard part:

| File | Format | Notes |
|---|---|---|
| `manifest.json` | JSON, `indent=2` | index; field shapes in `pipeline.py:697`. **Most structurally sensitive.** |
| `terrain.json` | JSON, compact | `{gridSize,widthM,depthM,minHeightM,maxHeightM,heights[]}`; heights `round(_,3)`, row-major `glat` south→north. Biggest file (≤76 MB). |
| `route.json` | JSON, compact | points `{x,y,z,d,lat,lon}`, x/y/z/d `round(_,2)`, lat/lon `round(_,7)`. |
| `border.json` | JSON, compact | `{id,name,color,lines:[[{x,y,z}]]}`; empty `lines` if Overpass fails. |
| `heightmap.png` | 16-bit grayscale (`I;16`) | quantized `(h-min)/(max-min)*65535`. **Verify PNG 16-bit endianness** vs viewer decode; PIL `I;16` and `image` crate `L16` may disagree. |
| `terrain-texture.png` | RGB PNG | topo mosaic, enhanced, ≤`WEB_TEXTURE_MAX`. |
| `terrain-topo-raw.png` | RGB PNG | pre-bake copy of texture. |
| `terrain-hillshade.png` | L PNG | normalized hillshade, north-up (flipud). |
| `terrain-multishade.png` | L PNG | mean of 7 azimuths. |
| `terrain-slope.png` | RGB PNG | classed slope colors over multishade. |
| `terrain-hypso.png` | RGB PNG | hypsometric tint × reference shade. |
| `terrain-normal.png` | RGB PNG | encoded normals, N-S component negated after flip. |
| `terrain-forest.png` | RGB PNG \| absent | Copernicus TCD; **null in manifest if fetch fails** (optional layer). |
| `reference-render.png` | PNG | copied from arg, else topo texture. |
| `reference-preview.jpg` | JPEG q=88 | thumbnail ≤1200×900. |
| `angle-sheet.png` | PNG \| absent | copied only if arg exists. |
| `build.log` | — | **written by the server**, not the baker. Don't emit it. |

All draped textures are saved **north-up**: relief arrays derive from `heights` (south-up, `glat`
runs south→north), so every saved relief image is `flipud`'d, and the normal map's N-S channel is
negated to stay correct (`pipeline.py:394`). Get this wrong and textures render upside-down. **#1
orientation trap.**

## A2. External data sources (all cached on disk by key)

| Source | Endpoint | Wire format | Decode |
|---|---|---|---|
| IGN LiDAR HD | `data.geopf.fr/wms-r` WMS 1.3.0 | `image/x-bil;bits=32`, CRS:84 | raw `<f4` little-endian, reshape (`pipeline.py:117`) |
| Piemonte DTM | `geomap.reteunitaria.piemonte.it` WCS 1.0.0 | `GEOTIFF_16`, EPSG:32632 | GeoTIFF band 1 + nodata + affine (`pipeline.py:150`) |
| OpenTopoMap | `tile.opentopomap.org/{z}/{x}/{y}.png` | PNG 256² | mosaic + crop |
| Copernicus TCD | EEA discomap ImageServer `exportImage` | `tiff` U8, EPSG:4326 | GeoTIFF band 1 |
| Overpass | `overpass-api.de/api/interpreter` | JSON | admin_level=2 ways → lines |

Every fetch retries 3× with `0.4*(n+1)`s backoff (`download`, `pipeline.py:42`) and writes a
`.npy`/`.tif`/`.png`/`.geojson` cache under `TREK_CACHE` keyed by bbox+params. **Preserve the cache
keys** so a Rust run can reuse a Python-warmed cache during A/B testing — the cheapest fidelity
harness (no network in the loop). The IGN cache is `.npy`; either keep reading it or switch the
cache to raw `f32` + a sidecar shape.

## A3. Dependency → Rust crate map

The numeric/geospatial stack is where the port's real cost sits.

| Python | Used for | Rust candidate | Risk |
|---|---|---|---|
| `numpy` | arrays everywhere | `ndarray` | low (mechanical) |
| `scipy.ndimage.map_coordinates` | DEM sampling, order 1 **and** 3 | **none direct** — write bilinear (order 1) + bicubic/spline (order 3) | **HIGH** — scipy order-3 does spline *prefiltering*; naive bicubic won't match. See A4. |
| `scipy.ndimage.gaussian_filter` | mesh/relief/slope smoothing | separable gaussian by hand, or `ndarray-ndimage` | MED — match `truncate=4.0`, `mode='reflect'` |
| `scipy.signal.savgol_filter` | smooth lat/lon (15,2), ele (61,2) | hand-rolled Savitzky-Golay | MED — small, deterministic, get coeffs right |
| `numpy.gradient` | slope/normals | hand-rolled 2nd-order central diff + one-sided edges | MED — match edge handling |
| `np.nanpercentile` | `normalize_to_u8` 2/98 pct | sort + linear-interp percentile | LOW |
| `rasterio` (GDAL) | read Piemonte/forest GeoTIFF + nodata + affine | `tiff` crate (+ manual geotransform) | MED — simple single-band reads; avoids GDAL build |
| `pyproj` (PROJ) | 4326→32632 (UTM 32N) | `proj4rs` (pure Rust) | LOW-MED — standard TM; verify vs pyproj on test points |
| `PIL` | decode/encode PNG/JPEG, resize Lanczos, enhance, thumbnail, `I;16` | `image` (+ `oxipng` for `optimize`) | MED — Lanczos/JPEG/PNG encoders differ; acceptable (tolerant viewer) |
| `PIL ImageEnhance` | topo texture grade | manual linear blends | LOW — replicate PIL's formulas |
| `contourpy` | DEM contour lines | `contour` crate / marching squares | **deferrable** — off by default (`WEB_DEM_CONTOURS=0`). |
| `urllib` + `ThreadPoolExecutor` | parallel I/O fetches | `ureq` (blocking) + `rayon` | LOW — no async runtime needed |
| `opentelemetry-*` | tracing | `opentelemetry` + `opentelemetry-otlp` | LOW — optional, port last |
| `json` | all writers | `serde_json` | LOW — match rounding, not byte layout |
| GPX regex parse | `parse_gpx` | `regex` crate (keep same regex) | LOW |

**No GDAL.** Piemonte/forest are plain single-band rasters; the pure-Rust `tiff` crate reads them
with no system library. `gdal` (binds the native C lib, painful to build) stays only as a fallback
if a real file trips up `tiff`. The whole native stack (`rasterio`+GDAL+`pyproj`+PROJ) collapses to
`tiff` + `proj4rs`, no system deps.

## A4. Numerical-fidelity traps (silent differences)

Won't crash — will produce *slightly* different terrain. Decide tolerance up front; the viewer
renders, it doesn't diff.

1. **`map_coordinates` order=3.** scipy spline-*prefilters* before cubic. Textbook bicubic differs.
   → We standardize on order=1 (Part B, Locked decisions); add bicubic only if a golden diff fails.
2. **`gaussian_filter`** defaults `mode='reflect'`, `truncate=4.0`. Match radius + edge reflection.
3. **`np.gradient(z, dy, dx)`** → 2nd-order interior, 1st-order edges. Used for normals and slope.
4. **`savgol_filter`** windows 15/61, polyorder 2 — raises if route shorter than window; guard it.
5. **`nanpercentile`** linear interpolation — off-by-one shifts every relief texture's 0–255 norm.
6. **NaN-fill chain** (`pipeline.py:195`): Piemonte → IGN fill → flatten remaining to min. Exact
   precedence matters or holes fill differently.
7. **`I;16` PNG endianness** (A1e). PNG spec big-endian; PIL `I;16` historically little-endian on
   save. Confirm against the decoder before trusting `image::Luma<u16>`.
8. **JSON float rounding** (`round` = banker's; Rust `f64::round` = half-away-from-zero) — differ by
   1 ULP on exact halves. Almost never matters; ignore unless a golden diff flags it.

**Cheapest harness:** warm `TREK_CACHE` once with Python on the sample GPX, run Rust against the
same cache (no network), diff (see Part B test harness).

## A5. Tracing

`otel_worker.py` is a thin no-op-safe wrapper: continues the `TRACEPARENT` trace from the Node API,
auto-instruments urllib HTTP as child spans, exposes `root_span`/`span`/`run_in_span`/
`context_binder`. In Rust: `opentelemetry` + `opentelemetry-otlp` (HTTP/proto to
`OTEL_EXPORTER_OTLP_ENDPOINT`, default `http://localhost:4318`), extract `traceparent` via the W3C
propagator, keep the span names (`build-assets`, `parse-gpx`, `elevation-source`,
`sample-elevation`, `textures`, `dem-tile`, `topo-tile`, `warm-forest`, `encode-relief`) so the
existing Jaeger views/README still read. Best-effort: exporter failure must not fail the build
(`otel_worker.py:35`). Lowest priority.

---
---

# Part B — Plan (execution)

**Goal:** the import flow runs a Rust baker instead of `python export_web_example.py`, producing
assets the viewer renders identically (within tolerance), with no other behavioral change — and
that same baker is usable in production (not just the Vite dev server).

**Non-goals (YAGNI):** no new asset features, no tiled-LOD terrain (separate README roadmap item),
no DEM-source plugin system (two sources = an enum), no config files, **no GPU** (see Performance).
One baker lib (flat modules) + thin binaries.

## B1. Locked decisions

The forks that size the job. Decided here so the plan is concrete; override any one before Phase 0.

| Decision | Choice | Why |
|---|---|---|
| **Sampling order** | order=1 bilinear only; treat `WEB_PIEMONTE_SAMPLE_ORDER` as 1. | scipy's order-3 prefilter is the biggest fidelity/effort sink on a 5 m DTM — sub-cell cubic is cosmetic. Add bicubic only if a golden diff demands it. |
| **GeoTIFF reader** | `tiff` crate (no system GDAL). | Single-band reads with a simple geotransform. `gdal` fallback only if `tiff` breaks. |
| **CRS transform** | `proj4rs` (pure Rust). | 4326→UTM 32N is standard TM; no system PROJ. Verify vs pyproj in Phase 4. |
| **HTTP + concurrency** | blocking `ureq` + `rayon`. | Embarrassingly parallel I/O; no async runtime; tiny binary. |
| **Image I/O** | `image` + `oxipng`. | Covers PNG/JPEG/L16/Lanczos. Encoder bytes won't match PIL — fine (tolerant viewer). |
| **Crate shape** | one crate: baker lib + `baker` (CLI) and `server` (axum) bins. | Mirrors today's package + wrapper; adds the prod server. |
| **Fidelity target** | terrain heights ≤ **0.5 m** abs error; relief PNGs ≤ **2%** mean per-pixel variance. | A number now prevents a byte-equality chase. |

## B2. Crate layout

`tools/asset-baker-rs/` (new dir; Python stays alongside until cutover, then both go).

```
tools/asset-baker-rs/
  Cargo.toml
  src/
    bin/
      baker.rs     # CLI: argv -> lib::run() — mirrors export_web_example.py
      server.rs    # axum prod service (Phase 11) — upload/poll/serve, calls lib::run()
    lib.rs         # re-exports; run(config) + progress callback
    config.rs      # all WEB_* env → one Config struct (replaces scattered os.environ)
    progress.rs    # progress(pct,label) + error-line helper (the stdout contract)
    gpx.rs         # parse + metrics            <- gpx.py
    fetch.rs       # ureq + retry + rayon parallel_map + disk cache  <- download/parallel_map
    dem.rs         # IGN BIL, Piemonte GeoTIFF, CRS, sampling, NaN fill  <- fetch_*/sample_*
    smooth.rs      # savgol + gaussian + gradient + percentile        <- scipy bits
    texture.rs     # topo mosaic + enhance + relief/slope/hypso/normal/multishade <- export_*_texture
    overlays.rs    # forest + border (fail-soft)                      <- export_forest/border
    write.rs       # terrain/route/manifest/border JSON + heightmap   <- json writers
    trace.rs       # OTel, no-op-safe                                 <- otel_worker.py
  tests/
    gpx.rs         # ported test_gpx.py vectors
    golden.rs      # cached-input A/B vs Python (#[ignore]; needs warm cache)
```

Deps: `ndarray`, `tiff`, `proj4rs`, `image`, `oxipng`, `ureq`, `rayon`, `regex`,
`serde`/`serde_json`, and (server) `axum`/`tokio`, (tracing) `opentelemetry` + `opentelemetry-otlp`.

## B3. Phases

Each phase is independently verifiable and leaves the tree shippable (Python stays the default
until Phase 10). Estimates assume a dev fluent in Rust + the geospatial stack.

| # | Phase | Work | Gate | Est |
|---|---|---|---|---|
| 0 | **Setup** | Create crate, lock deps, add `RIDGELINE_BAKER` env switch in `importJobs.ts` (spawn Rust when set, else Python). | `cargo build` ok; web still uses Python by default. | 0.5d |
| 1 | **gpx.rs** | Port `parse_gpx`, `haversine`, `cumulative_distance`, `ascent_deadband`, `simplify_by_distance`, `slugify`, `route_title_from_stem`. | Port the exact vectors from `tests/test_gpx.py`; `cargo test` green. | 1d |
| 2 | **Scaffolding** | `baker.rs` CLI (4 args + defaults), `config.rs` (all `WEB_*`), `progress.rs` (`progress:` + `Error:` on fatal). | Binary runs as a stub: prints the 9 progress lines, exits 0. | 0.5d |
| 3 | **Fetch + cache** | `ureq` retry/backoff; `rayon` `parallel_map`; disk cache under `TREK_CACHE` with the **same keys** (A2). | Rust run warms the same cache files Python does. | 1d |
| 4 | **DEM + CRS + sampling** | IGN BIL `<f4`, Piemonte GeoTIFF (band+nodata+affine), `proj4rs` 4326→32632, bilinear sampling, the NaN-fill chain. | proj matches pyproj on 4 corners (<1 m); grid heights ≤0.5 m vs Python on warm cache. | 2–3d |
| 5 | **Smoothing** | Savitzky-Golay (15,2)/(61,2), gaussian (`reflect`, `truncate=4.0`), `np.gradient` edges, `nanpercentile`. | Smoothed arrays match within tolerance. | 1d |
| 6 | **Textures** | Topo mosaic + enhance + Lanczos thumbnail; relief/slope/hypso/normal/multishade. **North-up flip + normal negation** (A1e/A4 — #1 trap). | All textures ≤2% pixel variance; visual spot-check not upside-down. | 2–3d |
| 7 | **Overlays** | Forest (TCD, fail-soft → null) + border (Overpass, fail-soft → empty). | Build succeeds with sources present and forced-failing; manifest nulls correct. | 1d |
| 8 | **JSON writers** | terrain/route/manifest/border with matching rounding (3/2/7 dp); `heightmap.png` L16 (**verify endianness**, A4.7). | `manifest.json` structural diff = 0; terrain/route within tolerance; viewer loads Rust output. | 0.5d |
| 9 | **Tracing** | OTel spans (same names), `TRACEPARENT` extract, OTLP HTTP, best-effort. | Sample import shows the same span tree in Jaeger. | 1d *(optional)* |
| 10 | **Cutover (dev)** | Flip `importJobs.ts` default to Rust; swap CI `python` job for `cargo fmt/clippy/test`; update README; delete `ridgeline_baker/`, `export_web_example.py`, `requirements*.txt`, `pyproject.toml`, `tests/`. | Real GPX import via UI loads correctly with the flag unset. | 0.5d |
| 11 | **Prod server** | `axum` `server` binary + dev/prod unification — see Production deployment. Delete the TS import middleware. | Imports work against a built bundle with no Node running; concurrency cap holds under 2 simultaneous imports. | 2–3d |

**Total: ~13–18 dev-days** (Phase 9 optional). The hard 60% is Phases 4 and 6; the rest is
mechanical. Front-load Phase 1 — a day of pure, fully-testable code that proves the toolchain.

## B4. Test / verification harness (build in Phase 3, use every phase after)

Network in the loop makes diffing impossible. So:
1. Run the **Python** baker once on `examples/gpx/Escursione_mattutina.gpx` with a fixed env →
   warms `TREK_CACHE`, produces the **golden** asset dir.
2. Run the **Rust** baker against the same `TREK_CACHE` (no network) → candidate dir.
3. `tests/golden.rs` (`#[ignore]` — needs the warm cache) diffs:
   - `terrain.json` heights: max abs error ≤ 0.5 m.
   - `route.json`: equal point count, coords within rounding tolerance.
   - `manifest.json`: structural equality (ignore float-format noise).
   - relief PNGs: mean per-pixel variance ≤ 2% (reuse the pixel-variance idea already in
     `web/scripts/capture-readme-media.mjs`).

This is the definition of "done" for every numeric phase. CI runs fast unit tests (`gpx.rs`); the
golden suite runs locally (needs the cache).

## B5. Production deployment

Today the baker runs **only in dev** (Vite dev-server middleware spawns it; a prod build is static
files with no backend — README "Known Limits"). To bake in prod you need a real server. Since the
baker is now Rust, make the server Rust too and delete the Node import layer rather than run two
runtimes.

**Shape: one `axum` `server` binary using the baker as a library; same server in dev and prod.**

| Endpoint | Does |
|---|---|
| `POST /api/import?quality=high` | validate region/point-cap → hash GPX → if asset dir exists return ready → else enqueue → `{jobId}` |
| `GET /api/import/:id` | job progress (in-memory map; completed jobs survive via disk) |
| `GET /generated/:id/*` | serve asset files |
| `/*` (prod only) | serve the built `web/dist` bundle |

- Progress via an in-process channel (`lib::run` takes a progress callback) — no stdout parsing;
  that protocol only existed because Node spawned a foreign process.
- **Dev:** Vite serves React with HMR and **proxies** `/api` + `/generated` to the Rust server
  (`vite.config.ts` → `server.proxy`). **Prod:** the Rust server serves the bundle *and* the API —
  no Node at runtime; ships as one distroless/`scratch` container.
- **Deletes:** `gpxImportServer.ts`, `importJobs.ts`, `importValidation.ts` (port the region/point
  validation + content-hash dedup to Rust; port their test cases). Vite reverts to build-tool +
  dev-proxy only.

Chosen over "keep Node, spawn the Rust binary" because it's one runtime/one container with no
subprocess coupling, and removes the TS server instead of maintaining two languages. Pick
Node-spawns-binary only if forced to keep an existing Node host.

**New prod-only concerns:**
1. **Concurrency cap — required.** Bakes are CPU+network heavy and use every core; gate concurrent
   bakes with a semaphore (start at 1–2), queue the rest.
2. **Restart-safe completed jobs — already free.** job id = content hash + on-disk output ⇒ a
   restart re-serves finished bakes (keep the manifest-exists short-circuit). In-progress jobs are
   lost → client resubmits. Fine for v1.
3. **Storage growth — known limit, defer.** Each unique route ≈ 170 MB; add TTL/LRU eviction later.
4. **Abuse — flag if public.** An open endpoint lets anyone trigger a ~170 MB / ~minute bake; add
   rate-limit/auth if internet-facing.

## B6. Performance

This pipeline is **I/O + compression + serialization bound**, not float-compute bound. A warm-cache
bake spends its CPU on PNG zlib compression (topo ≤8192², relief PNGs ≤3000²) and on serializing
`terrain.json` (≤76 MB of text, ~9M floats). The array math is tens of ms on 9M cells — already
cheap, and already native C in the Python it replaces. Rust's win comes from compression,
serialization, and orchestration, **not** from the only GPU-amenable stage (also the cheapest).

**Levers, in payoff order:**
1. Keep the disk cache (`TREK_CACHE`) — not refetching/recomputing is the biggest win.
2. Fast compression: `libdeflate`/`zlib-ng` over stock zlib; textures are write-once, so a lower
   zlib level is fair. This is where the CPU time actually is.
3. `rayon` + `ndarray` for array ops; `ryu` floats for JSON (serde_json already uses it); release
   `lto = true` + `target-cpu=native` (NEON SIMD on the M1).
4. Pipeline fetch→sample→encode instead of staging them.
5. *(Optional, needs a `web/` change — out of baker scope)* the baker already writes
   `heightmap.png` (16-bit heights). If the viewer read that instead of `terrain.json` `heights[]`,
   the 76 MB JSON disappears — biggest lever on load size and bake time.

**GPU / Metal — deferred, with a trigger.** Skipped by design: one route at a time, so per-bake GPU
upload/download eats the gain on a 9M-cell array CPU SIMD clears in ms, and the real hogs (zlib,
float→string) aren't GPU work. *If* CPU-first profiling later shows the per-pixel
relief/slope/hypso/normal shading at `ultra` exceeds **~30% of a warm-cache bake**, move that **one
stage** to `wgpu` compute (portable; runs on Metal under the hood on the M1) — not hand-written
Metal, not the whole pipeline. Until that number shows up, it's premature optimization.

## B7. Cutover & rollback

- **A/B the whole migration:** `importJobs.ts` reads `RIDGELINE_BAKER` — set ⇒ spawn the Rust
  binary `[gpx, ref, angles, outDir]` (drop the script arg, keep order); else Python. One small
  reversible edit (Phase 0), flipped to default-Rust at Phase 10, removed entirely at Phase 11
  (when the axum server replaces the spawn path).
- **Rollback = unset the env var.** Keep the Python tree until N successful real imports on Rust.
- Delete Python only at Phase 10, one commit, after the flag has defaulted to Rust and stuck.

## B8. Repo changes outside the baker

- **`web/server/importJobs.ts`** — Phase 0 adds the `RIDGELINE_BAKER` spawn switch; Phase 11
  deletes this file (and `gpxImportServer.ts`, `importValidation.ts`) when the axum server takes
  over. Until then: `spawn(rustBinary, [gpx, ref, angles, outDir])`.
- **`vite.config.ts`** — Phase 11 adds `server.proxy` for `/api` + `/generated` → Rust server.
- **`.github/workflows/ci.yml`** (`python` job) — Phase 10 replaces `pip/ruff/pytest` with
  `cargo fmt --check / clippy / test`.
- **`README.md`** — Phase 10/11: `pip install` + `python …` Quickstart/Dev steps become
  `cargo build --release` + the binary/server; note the prod server.
- `pyproject.toml`, `requirements*.txt`, `ridgeline_baker/`, `export_web_example.py` deleted at
  cutover. `tests/test_gpx.py` becomes the spec for `gpx.rs` tests, then is deleted.

## B9. Immediate next step

Phase 1 is a self-contained day with ready-made test vectors (`tests/test_gpx.py`) and no network
or geospatial deps — the cheapest way to stand up the crate and prove the approach. Say the word
and I'll scaffold the crate (Phase 0) and port `gpx.rs` (Phase 1).
