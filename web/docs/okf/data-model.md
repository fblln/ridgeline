---
type: Data Model
title: Shared TypeScript types
description: types.ts — the manifest, asset, viewer-state, and camera shapes shared across App and TerrainViewer.
resource: src/types.ts
tags: [types, schema]
timestamp: 2026-06-27T00:00:00Z
---

# Data model

All shared shapes live in `src/types.ts`. Used by both [`App.tsx`](/app-shell.md) and [`TerrainViewer.tsx`](/terrain-viewer.md).

# Schema

**Enums (string unions):**
- `CameraMode` — `orbit | free-camera | route-follow`
- `Quality` — `low | balanced | high` (drives mesh decimation + post-processing)
- `TextureMode` — `topographic | raw-topo | lidar-shade | multi-shade | slope | hypsometric | surface`
- `AppStatus` — `ready | loading | empty | error | unsupported`

**Manifest / config:**
- `ValleyManifest` (`:25`) — id, geographic `bounds`, `assetBase`, optional `reference` images, a large `terrain` block (DEM source, resolutions, smoothing sigmas, `gridSize`, extent in metres, min/max height), `defaultCamera`, `routes`, `qualityPresets`, `attribution`, `overlays`.
- `RouteSummary` (`:16`) — lightweight route entry inside a manifest.
- `SavedShot` (`:74`) — a persisted camera view (position, target, fov, exaggeration, texture, route visibility).
- `ViewerState` (`:85`) — the live UI state object owned by `App`.

**Runtime assets (fetched JSON):**
- `RouteAsset` / `RoutePoint` (`:105`, `:96`) — full route geometry with scene `x/y/z`, distance `d`, and `lat/lon`.
- `TerrainAsset` (`:118`) — the heightfield: `gridSize`, extent, min/max height, flat `heights[]`.
- `BorderAsset` (`:127`) — colored polylines for overlays.
- `CameraSnapshot` (`:134`) — derived readout pushed to the [HUD](/app-shell.md): position, target, fov, altitude, distance-to-route, heading.
