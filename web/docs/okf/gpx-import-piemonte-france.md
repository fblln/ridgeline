---
type: Product Plan
title: GPX Import for Piemonte and France
description: Plan for on-demand GPX upload, terrain generation, caching, and viewer handoff for Piemonte and France.
tags: [gpx, import, terrain, piemonte, france, backend]
timestamp: 2026-06-28T00:00:00Z
---

# GPX Import Plan: Piemonte + France

## Goal

Allow users to upload any GPX route in Piemonte or France and get the same Ridgeline experience:

- 3D terrain
- Draped map/terrain textures
- Route replay
- Cinematic route-follow camera
- No Python or command-line work for users
- Loading screen while assets are generated
- Fast enough for interactive use
- High-quality terrain where source data allows it

## Scope

Supported regions:

- Piemonte, Italy
- France

Out of scope for now:

- All Italy
- Switzerland
- Global fallback
- Fully client-side terrain generation

The app should reject unsupported GPX bounds clearly instead of silently producing poor results.

## Core Approach

Use an on-demand backend asset pipeline.

The browser uploads a GPX. The backend generates a static terrain package, stores it, and returns an `assetBase` URL. The existing Three.js viewer then loads that generated package exactly like it does today.

```text
User uploads GPX
  -> API creates import job
  -> worker builds terrain + route assets
  -> frontend polls progress
  -> viewer loads generated manifest
```

## User Flow

1. User opens Ridgeline.
2. User selects `Import GPX`.
3. User uploads `.gpx`.
4. App validates:
   - GPX has track points
   - route bounds are inside Piemonte and/or France
   - route length and area are within limits
5. App shows loading screen:
   - Reading GPX
   - Fetching terrain
   - Building mesh
   - Generating map layers
   - Preparing route replay
6. When complete, app loads the generated route.
7. User can orbit, replay, export, and save views.

## Backend API

### `POST /api/import-gpx`

Uploads a GPX and starts generation.

Request:

- multipart form
- file: `.gpx`
- optional settings:
  - quality: `fast | high | ultra`
  - marginKm
  - routeName

Response:

```json
{
  "jobId": "abc123",
  "status": "queued"
}
```

### `GET /api/import-jobs/:jobId`

Returns job progress.

```json
{
  "jobId": "abc123",
  "status": "processing",
  "progress": 62,
  "step": "Generating hillshade"
}
```

### `GET /api/import-jobs/:jobId/result`

Returns generated asset location.

```json
{
  "status": "ready",
  "assetBase": "/generated/abc123/"
}
```

## Generated Asset Contract

Each generated route produces:

```text
/generated/<job-id>/
  manifest.json
  terrain.json
  route.json
  heightmap.png
  terrain-texture.png
  terrain-topo-raw.png
  terrain-hillshade.png
  terrain-multishade.png
  terrain-slope.png
  terrain-hypso.png
  terrain-normal.png
  reference-preview.jpg
```

Optional:

```text
  border.json
  terrain-forest.png
```

The frontend should not care whether assets are prebuilt or generated. It only needs `assetBase`.

## Terrain Sources

### Piemonte

Primary:

- Piemonte ICE 2009-2011 DTM 5m

Use it for all GPX bounds fully inside Piemonte.

Fallback:

- France IGN fill only if the route crosses into France.
- Reject if outside supported area.

### France

Primary:

- IGN LiDAR HD / RGE ALTI where available

Fallback:

- IGN RGE ALTI lower-resolution coverage where high-res is unavailable.

For MVP, use the same IGN endpoint strategy already used in the exporter.

## Region Detection

After parsing GPX:

1. Compute route bounding box.
2. Add margin.
3. Check whether the area intersects:
   - Piemonte supported bounds
   - France supported bounds
4. Pick source strategy:
   - Piemonte-only: Piemonte DTM
   - France-only: IGN
   - Cross-border Piemonte/France: mixed Piemonte + IGN
5. If outside supported bounds, return an actionable error.

Example error:

```json
{
  "status": "error",
  "message": "This GPX is outside the supported Piemonte/France area."
}
```

## Quality Modes

Optimize for both speed and high quality by using quality presets.

### Fast

For quick preview.

- DEM sampling: 5m target
- Terrain grid: `900 x 900`
- Texture max: `4096 px`
- Route sample step: `6m`
- Expected time: fastest
- Use for immediate preview

### High

Default.

- DEM sampling: best available source
- Terrain grid: `1600 x 1600`
- Texture max: `8192 px`
- Route sample step: `3m`
- Expected time: moderate
- Good visual quality

### Ultra

For export-quality sessions.

- DEM sampling: best available source
- Terrain grid: `2500-3000 x 3000`
- Texture max: `8192-12000 px`
- Route sample step: `2m`
- Expected time: slower
- Cache aggressively

Default should be `High`.

## Speed Strategy

Use a two-stage generation flow.

### Stage 1: Preview Package

Generate quickly:

```text
terrain.json       lower grid
route.json         full route or lightly simplified
terrain-hillshade  quick
terrain-texture    lower resolution
manifest.json
```

The viewer can open this as soon as it is ready.

### Stage 2: Upgrade Package

Continue in the background:

```text
higher grid terrain
better textures
slope/hypso/normal
forest layer if enabled
```

When complete, the frontend can offer:

```text
Higher quality terrain ready
```

Or automatically swap assets if camera state can be preserved.

This avoids making users wait for ultra-quality before seeing anything.

## Caching

Cache aggressively by:

```text
hash(GPX contents + quality settings + margin + exporter version)
```

If the same GPX is uploaded again, return the existing generated package immediately.

Cache layers separately where possible:

- DEM tile cache
- topo tile cache
- generated route package cache

This is critical for speed.

## Worker Design

Use a background worker, not request-thread processing.

Recommended stack:

```text
Frontend: React/Vite
API: Node or Python web server
Worker: Python GIS pipeline
Queue: simple local queue for MVP, Redis/RQ or Celery later
Storage: local filesystem for MVP
```

The worker can reuse the current exporter logic, but it should be refactored from script-style into functions.

## Exporter Refactor

Current `export_web_example.py` should become a reusable module.

Needed changes:

- Accept GPX path, output dir, name, id, quality preset.
- Remove hardcoded `escursione-mattutina`.
- Derive route id from filename or user-provided name.
- Derive attribution from selected DEM source.
- Return structured progress events.
- Return generated manifest path.
- Support Piemonte, France, and mixed source modes.
- Fail clearly for unsupported areas.

Target shape:

```python
build_assets(
    gpx_path,
    output_dir,
    route_name,
    quality="high",
    margin_km=2.0,
    progress_callback=...
)
```

## Frontend Changes

### Entry Screen

Wire the GPX input to the backend.

Current file input is visual only. It should:

1. Accept `.gpx`
2. Upload file
3. Show progress screen
4. Receive generated `assetBase`
5. Start viewer with generated valley manifest

### App State

Add dynamic imported valley support.

Current app uses static `valleys` from `mockData.ts`.

Add:

```ts
const [dynamicValley, setDynamicValley] = useState<ValleyManifest | null>(null);
```

Then let the viewer use either:

```ts
dynamicValley ?? selectedMockValley
```

### Loading UI

Use job progress text:

- Uploading GPX
- Checking coverage
- Fetching DEM
- Sampling route elevation
- Building terrain mesh
- Generating textures
- Finalizing viewer

## Limits

To keep performance predictable:

- Max route length: e.g. `120 km`
- Max generated area: e.g. `35 km x 35 km`
- Max GPX points: e.g. `250k`, simplify if larger
- Max concurrent jobs per user/session
- Timeout per DEM request
- Clear errors for huge files or unsupported regions

## Deployment Options

### MVP Local Server

Good for development and controlled use.

```text
npm app + local backend + local worker + local generated assets
```

Pros:

- fastest to build
- can reuse current Python pipeline
- no cloud storage complexity

Cons:

- only works where server runs

### Production

Recommended later:

```text
Web frontend
API server
Worker queue
Object storage for generated assets
CDN for textures/assets
Persistent DEM/tile cache
```

## Implementation Phases

### Phase 1: Refactor Exporter

- Turn `export_web_example.py` into reusable import pipeline.
- Remove hardcoded route id/name.
- Add quality presets.
- Add region detection.
- Keep writing the same asset contract.

### Phase 2: Backend Job API

- Add upload endpoint.
- Add job status endpoint.
- Add generated asset serving.
- Add cache by GPX hash.
- Add clear errors.

### Phase 3: Frontend Import Flow

- Wire GPX input.
- Add progress UI.
- Load generated `assetBase`.
- Preserve current viewer behavior.

### Phase 4: Speed + Quality Polish

- Add preview-first generation.
- Add background upgrade.
- Add cancellation.
- Add better progress reporting.
- Add cache cleanup policy.

### Phase 5: Production Hardening

- Add queue worker.
- Add storage abstraction.
- Add rate limits.
- Add telemetry for generation time and failures.
- Add source attribution display per generated route.

## Acceptance Criteria

A user can:

- Upload a GPX in Piemonte.
- Upload a GPX in France.
- See a loading screen.
- Get a generated 3D terrain viewer without running Python.
- Replay the route with the airplane camera.
- Export a view.
- Re-upload the same GPX and get a cached result quickly.

The app should reject unsupported GPX files with a clear message.
