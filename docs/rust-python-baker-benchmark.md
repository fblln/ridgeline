# Rust vs Python Asset Baker — Cold/Warm Benchmark

Date: 2026-06-29

This note benchmarks the two Ridgeline asset-baker implementations (Rust and
Python) on the same GPX route, and documents the fetch-layer work that made the
**cold** (empty-cache) path fast. An earlier version of this doc measured only
the warm path on a smaller route; those compute-only findings are preserved at
the end.

Route: `Morning_Hike.gpx` — a ~27 km local test track (not in the repo).

| | |
|---|---|
| Distance | 26.72 km, +2056 m |
| Terrain grid | 1257 × 1257 (~5 m/cell over 6.3 km) |
| Terrain extent | 5911 × 6279 m |
| Texture | 7025 × 7462 px (OpenTopoMap z17) |
| Region | Piemonte, IT — **outside IGN HD coverage** |

Rust is built `--release` with `lto = true`, `codegen-units = 1`. "Cold" points
`TREK_CACHE` at an empty directory; "warm" reuses a populated cache. Cold numbers
are the median of 3 fresh-cache runs; government DEM servers (Piemonte WCS, EEA
forest) vary several seconds run-to-run, so treat cold wall as ±a few seconds.

## The five remote sources

A cold bake pulls five independent sources, each needing only the route bbox:

| Source | What | Server character |
|---|---|---|
| IGN HD | French elevation (BIL float32, chunked WMS) | fast CDN, **France-only** |
| Piemonte DTM | Italian 5 m elevation (WCS GeoTIFF) | slow, server-side generated |
| OpenTopoMap | styled topo tiles (PNG, z17 → ~870 tiles) | rate-limited, polite cap |
| Copernicus TCD | forest canopy (ArcGIS ImageServer GeoTIFF) | slow, server-side generated |
| Overpass | FR/IT border lines (GeoJSON) | small, occasionally slow |

Only the **DEM result** feeds the compute chain; topo/forest/border downloads
feed only their own later compute. That independence is what the DAG exploits.

## Fetch-layer optimizations (cold path)

Three changes, in order of impact on this route:

1. **Pooled HTTP.** A single process-wide `ureq` agent reuses connections per
   host (previously a fresh one-shot client per request). In-memory reads carry
   an explicit body limit; cache writes stream to a temp file + atomic rename.
   This also removed an old 10 MiB body-limit failure on large WMS responses.

2. **IGN coverage probe.** IGN HD only covers France, so an Italian track would
   download the full grid (here `5994 × 6366`, ~150 MB of BIL) only to discard it,
   then warp 38 M nodata cells. One 64 × 64 WMS probe settles coverage first:

   | | before | after |
   |---|---:|---:|
   | IGN `.npy` cached | 146 MB | **16 KB** |
   | total cold cache | 167.7 MB | 22.2 MB |
   | peak RSS | 1.76 GiB | 791 MiB |
   | texture output | `7517ecf7…` | `7517ecf7…` (identical) |

   Verified the probe keeps IGN where it should: Chamonix (FR) → 4096/4096 cells
   → full fetch; Bardonecchia (FR/IT border straddle) → 4092/4096 → full fetch;
   this track (IT interior) → 0/4096 → skipped. Mirrored in the Python baker.

3. **All-sources DAG.** `run_inner` fires all five downloads at once in a
   `std::thread::scope` and gates each compute on the join of *exactly* its input
   — DEM build waits on IGN+Piemonte and starts immediately, without waiting on
   the topo/forest/border downloads; topo mosaic waits on tiles; forest on the
   TCD; border on Overpass. The `warm_*` fills are best-effort: the build/export
   stages stay authoritative and re-fetch on a cache miss, so output is byte-
   identical to a sequential run — only the I/O overlaps.

   ```
   bbox
    ├─ IGN  ─┐
    ├─ Pie  ─┴─► elevation ─► sample ─► heights ─► relief ─┬─► hillshade/slope/…
    ├─ topo ───────────────────────────────────────────► mosaic ─┘ (bake needs relief)
    ├─ forest ─────────────────────────────────────────────────► forest (needs relief)
    └─ border ─────────────────────────────────────────────────► border (needs heights)
   ```

   Cold wall drops to ≈ the **slowest single source** instead of their sum:
   sequential(+probe) ~40 s → DAG **~21 s**.

The Python baker now runs the same DAG: a 5-source `ThreadPoolExecutor` with
per-stage `settle()` gates, replacing the old opt-in partial prefetch.

## The rayon flag

`WEB_COMPUTE_THREADS` sizes the rayon **global** pool that drives CPU compute
(the texture enhance/mean passes over the 7025 × 7462 image). `1` = single-
threaded compute (rayon parallelism off); `0` (default) = all cores. It does
**not** touch the explicitly-sized fetch pools, so fetch parallelism is retained
either way. Output is byte-identical with rayon on or off.

## Results

All on `Morning_Hike.gpx`, this machine, **median of 3** runs each, measured with
`/usr/bin/time -l`. "Wall" is real time; "User"/"Sys" are total CPU seconds across
all threads; "CPU%" = (user+sys)/real (>100% = multiple cores busy). "Max RSS" is
the OS maximum resident set; "Peak" is macOS peak memory footprint (dirty/anon).

| Implementation | Phase | Wall | User | Sys | CPU% | Max RSS | Peak |
|---|---|---:|---:|---:|---:|---:|---:|
| **Rust**, rayon on (default) | cold | 21.4 s | 3.04 s | 1.36 s | 21% | 788 MiB | 758 MiB |
| | warm | **2.26 s** | 2.63 s | 0.17 s | **124%** | 781 MiB | 762 MiB |
| **Rust**, rayon off (`WEB_COMPUTE_THREADS=1`) | cold | 20.5 s | 3.01 s | 1.50 s | 22% | 789 MiB | 760 MiB |
| | warm | 2.72 s | 2.54 s | 0.19 s | **100%** | 783 MiB | 764 MiB |
| **Python** (DAG) | cold | 33.5 s | 20.5 s | 2.0 s | 67% | 1679 MiB | 1193 MiB |
| | warm | 16.9 s | 17.9 s | 0.83 s | 111% | 1665 MiB | 1182 MiB |

Variance was tight this batch (e.g. Rust warm `2.25 / 2.26 / 2.28`; Python cold
`35.2 / 33.5 / 33.4`). Government DEM servers still swing several seconds run-to-
run, so cold wall is ±a few seconds; cold *CPU* is stable.

Texture output is byte-identical with rayon on or off (`7517ecf7…`). Rust and
Python texture hashes differ (different PNG encoders); the pixel delta is ≤ 2/255.

### Reading the numbers

**rayon (warm, the network-free signal).** Same total user CPU — 2.63 s (on) vs
2.54 s (off) — but rayon spreads it across cores: **124% CPU → 2.26 s wall** vs
**100% CPU → 2.72 s wall**. So rayon buys ~0.46 s (~18%) of wall on the texture
enhance/mean passes by using >1 core, at no extra CPU cost. The rest of the warm
path (GDAL warps, serial relief loops, single-threaded PNG encode) is unaffected,
which is why the win is modest. Memory is unchanged (~780 MiB) either way.

**Cold is network-bound.** Both Rust configs sit at **21–22% CPU** during a cold
bake — only ~4.4 s of CPU across a ~21 s wall; the rest is waiting on sockets.
rayon is irrelevant here (21% vs 22%), and cold wall is equal within noise.
`cold − warm` ≈ **~19 s** of network the DAG could not hide behind compute — the
shared floor (slowest single source). Beating it needs a faster server (e.g.
Copernicus GLO-30 as a COG via `/vsicurl/`), not more threads.

**Rust vs Python is a compute + memory story.**

- *Compute:* Python's warm user CPU is **17.9 s vs Rust's 2.63 s** — ~7× the CPU
  work for the same output (interpreter + large temporary arrays + native-lib
  orchestration), so warm wall is 16.9 s vs 2.26 s.
- *Memory:* Python peaks at **~1.67 GiB RSS / 1.18 GiB footprint vs Rust's
  ~0.78 GiB** — ~2×, from NumPy/rasterio temporaries.
- *Network:* nearly equal — Python's cold−warm (~17 s) ≈ Rust's (~19 s). The DAG
  works the same in both; the gap is entirely compute and memory.
- Python warm runs at only 111% CPU (mostly the relief-encode workers); it is not
  meaningfully parallel, which matches the earlier free-threaded result — the
  workload is native-library- and memory-bound, not GIL-bound.

## Prior findings (warm compute, smaller route)

These were measured earlier on a different, smaller route
(`Giro Serpentera`, 700 × 700 grid, 3024 × 2972 texture) and remain valid for
understanding the warm/compute gap. The absolute numbers are smaller than above
because the route and texture are smaller.

- **Output parity.** Rust and Python textures were visually equivalent: max
  channel delta `2/255`, mean ~`0.03/255`. Route/terrain metadata matched.
- **The GIL was not the bottleneck.** Free-threaded Python 3.14t
  (`Py_GIL_DISABLED=1`) did **not** improve this workload — most expensive work is
  already inside native NumPy/SciPy/rasterio/Pillow/GDAL.
- **Thread count is not a strategy.** A moderate 4-worker Python profile recovered
  almost all wall-clock vs a 16–20 thread fan-out, with smaller thread spikes.
- **Memory was temporary arrays.** A 101-entry `float32` forest color LUT
  (indexed by the `uint8` TCD raster, shade applied in place) cut Python peak RSS
  from ~1.0 GiB to ~710 MiB with byte-identical output — still idiomatic NumPy,
  not a Rust-style rewrite.
- **Why Rust is faster:** implementation shape. Rust expresses the pipeline as
  explicit buffers and direct loops (tight allocation lifetimes); Python expresses
  it as vectorized array ops (concise, but large temporaries). Both idiomatic.

## Reproduce

```sh
# cold (empty cache); add WEB_COMPUTE_THREADS=1 for single-threaded compute
TREK_CACHE=$(mktemp -d) baker Morning_Hike.gpx ref.png angles.png out/
# warm: rerun with the same TREK_CACHE
```
