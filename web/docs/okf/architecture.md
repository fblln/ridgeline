---
type: Architecture
title: Architecture & data flow
description: How the App shell, three.js viewer, types, and streamed assets connect.
tags: [architecture, dataflow]
timestamp: 2026-06-27T00:00:00Z
---

# Architecture

Two-component app. [`App.tsx`](/app-shell.md) owns all UI state and renders the surrounding panels; [`TerrainViewer.tsx`](/terrain-viewer.md) owns the three.js scene and renders into a mounted `<div>`. Shared shapes live in [`types.ts`](/data-model.md). Initial valleys/shots come from [`mockData.ts`](/mock-data.md); heavy terrain/route assets are fetched at runtime from a per-valley `manifest.json`.

# Schema

```
main.tsx → <App/>
  App (ViewerState, shots, status, currentCamera)
   ├─ <TerrainViewer/>  ← props: valley, state, selectedShot, replayPosition, commands
   │     fetch manifest.json → terrain.json, route.json, border.json
   │     three.js scene (terrain mesh + route tube + border)
   │     onCameraChange(snapshot) ─┐
   │     onAssetsLoaded(route) ────┤
   ├─ <TopBar/>  valley/route/quality selects, share, export, status
   ├─ <CameraToolbar/>  orbit / free / route-follow, frame, reset
   ├─ <Hud/>  ◀──────────────────┘ camera readouts
   ├─ <ShotPanel/>  saved views, add, toggle route, export
   ├─ <ControlPanel/>  texture mode, vertical exaggeration
   ├─ <ReplayTimeline/>  route-follow scrub
   └─ <ExportPreview/>  captured PNG
```

# Examples

Cross-component coordination uses three channels:
- **Props down** — `App` passes `ViewerState` and a `commands` counter object to the viewer.
- **Callbacks up** — `onCameraChange` / `onAssetsLoaded` push viewer-derived data back to `App`.
- **Window CustomEvents** — image export is decoupled via `trek-export-image` (request) and `trek-export-ready` (result with `dataUrl`). See `App.tsx:166` and `TerrainViewer.tsx:246`.

Commands (`frameRoute`, `reset`, `exportImage`) are fired by incrementing integer counters so the viewer's effect detects a change without a direct method call (`TerrainViewer.tsx:646`).
