---
type: Component
title: App shell & UI panels
description: App.tsx — the single state owner, plus the HUD, toolbar, shot/control panels, and export preview.
resource: src/App.tsx
tags: [react, ui, state]
timestamp: 2026-06-27T00:00:00Z
---

# App shell

`App` (`src/App.tsx:87`) holds every piece of UI state with `useState`:
- `viewerState: ViewerState` — valley/route ids, camera mode, quality, texture mode, vertical exaggeration, route visibility, selected shot.
- `shots: SavedShot[]` — saved camera views, seeded from `initialShots`.
- `currentCamera: CameraSnapshot` — live readout pushed up from the viewer via `onCameraChange`.
- `status`, `replayPosition`, `isReplayPreviewing`, `loadedRoute`, `exportImageUrl`, `commands`.

Derived values (`activeValley`, `activeRoute`, `selectedShot`) are `useMemo`'d off that state. See [data model](/data-model.md) for the shapes.

# Schema

Sub-components (all in this file):
- `TopBar` (`:289`) — valley / route / quality selects, share + export buttons, a status switch for previewing mock states.
- `CameraToolbar` (`:395`) — segmented orbit / free-camera / route-follow, plus Frame route and Reset.
- `Hud` (`:463`) — altitude, distance-to-route, mode, FOV, quality, heading, terrain label, route summary.
- `ShotPanel` (`:505`) — saved-view list, add current view, toggle route, export.
- `ControlPanel` (`:567`) — texture mode select, vertical-exaggeration slider, selected-shot detail.
- `ReplayTimeline` (`:652`) — play/pause route-follow preview and scrub.
- `ExportPreview` (`:698`) — modal showing the captured PNG with a download link.

# Examples

- **Save a shot** — `addShot` (`:139`) snapshots `currentCamera` + current `viewerState` into a new `SavedShot` (id `shot-${Date.now()}`) and selects it.
- **Share link** — `copyShareLink` (`:176`) writes valley/route/mode/shot as query params to the clipboard. ponytail-grade: no router, just `URLSearchParams`.
- **Replay loop** — an interval advances `replayPosition` while previewing and forces `cameraMode: "route-follow"` (`:156`).
- **Export round-trip** — `requestImageExport` dispatches `trek-export-image`; a listener catches `trek-export-ready` and stores the `dataUrl` (`:165`). Handled in [terrain viewer](/terrain-viewer.md).
