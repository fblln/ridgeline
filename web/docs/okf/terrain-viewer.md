---
type: Component
title: Terrain viewer (three.js engine)
description: TerrainViewer.tsx — asset loading, mesh/route/border construction, camera rig, render pipeline, and high-res export.
resource: src/TerrainViewer.tsx
tags: [threejs, rendering, camera]
timestamp: 2026-06-27T00:00:00Z
---

# Terrain viewer

`TerrainViewer` (`src/TerrainViewer.tsx:253`) is the imperative three.js layer. It keeps all GL objects in refs (renderer, composer, camera, scene, meshes, camera rig) and drives them from React effects keyed on `state`.

# Schema

**Asset loading** (`:289`) — fetches `${assetBase}manifest.json`, then in parallel `terrain.data` (heightfield JSON) and the matching route JSON, plus an optional border overlay. Resolves texture URLs per [`TextureMode`](/data-model.md) into `textureUrls`. Reports the loaded route up via `onAssetsLoaded`.

**Geometry builders** (pure functions, top of file):
- `buildTerrainGeometry` (`:113`) — decimates the `gridSize × gridSize` heightfield by a `skip` factor (low=4, balanced=2, high=1), builds positions/colors/uvs/indices, computes normals. Color is an HSL ramp by normalized height.
- `buildRouteObject` (`:176`) — a centripetal Catmull-Rom `TubeGeometry`, raised 28 m, red.
- `buildBorderGroup` (`:194`) — same treatment for optional border polylines.

**Coordinate mapping** — `localToScene` / `sceneToLocal` (`:76`, `:84`) convert between asset-space `[x, y, z(elev)]` and three.js scene space, applying `verticalExaggeration`. Note the y/z swap and the `depthM/2 - y` flip.

**Camera rig** — a spherical `CameraRig` (`target, radius, theta, phi`). `computeRigFromCamera` (`:92`) derives it from a position+target; `applyRig` (`:103`) writes the camera position back. Pointer drag edits theta/phi, wheel edits radius (`:679`).

**Render pipeline** (`:450`) — `EffectComposer` with `RenderPass`, optional `SSAOPass` (high only), `FXAAPass`. Quality `low` skips post-processing entirely.

# Examples

- **Camera modes** in the rAF loop (`:509`): `free-camera` does WASD/QE fly with forward/right vectors; `route-follow` lerps the camera along `routePoints` by `replayPosition`; default `orbit` just re-applies the rig.
- **Live readout** — `reportCamera` (`:347`) throttled to ~220 ms, computes altitude, nearest route distance, and heading, then calls `onCameraChange` → [HUD](/app-shell.md).
- **High-res export** — `exportRendererImage` (`:218`) temporarily resizes the renderer to 7200×5400 at pixel ratio 1, renders, reads `toDataURL("image/png")`, restores size, and dispatches `trek-export-ready`. Requires `preserveDrawingBuffer: true` on the renderer (`:381`).
- **Texture hot-swap** — changing `textureMode` swaps `material.map`/`emissiveMap` without rebuilding the scene (`:593`); analysis textures (slope/hypso/shades) get higher emissive intensity.

# Citations

Imports three.js postprocessing from `three/examples/jsm/postprocessing/*`. Pixel ratio capped at 3 for display (`:60`), export constants at `:61`.
