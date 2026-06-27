# Ridgeline

Ridgeline is a shareable web app for exploring a trekking route over real LiDAR/DTM terrain. It is not a flight simulator. The goal is to move a cinematic camera through the valley, frame the route, save useful viewpoints, export high-resolution images, and preview a future route replay workflow.

The current app focuses on one high-quality example, `Escursione mattutina`, using static assets exported from the Python pipeline into a Vite + React + Three.js viewer.

## What The App Does

- Loads a baked LiDAR/DTM terrain package from `public/assets/escursione-mattutina/`.
- Renders the terrain as a Three.js heightfield mesh.
- Drapes a high-resolution topographic texture over the mesh.
- Shows the GPX trek as a raised red tube above the terrain.
- Shows the France/Italy border as a raised blue tube.
- Provides orbit, free camera, and route-follow camera modes.
- Preserves the camera when switching terrain textures.
- Saves mock camera viewpoints in the UI.
- Exports the current camera view as a high-resolution PNG.
- Displays the Python/PyVista reference render for visual comparison.
- Offers multiple terrain views: reference topo, raw topo, LiDAR shade, multi-shade, slope angle, hypsometric, and plain surface.

The visual target is close to the existing Python PNG renders: crisp terrain, mountain-map lighting, dense route detail, strong topographic context, and useful camera framing controls.

## Current Quality Profile

The project is currently configured for maximum local quality, not performance.

Generated asset state:

| Asset | Current value |
| --- | --- |
| Terrain grid | `3000 x 3000` |
| Terrain JSON | about `76 MB` |
| Full asset folder | about `172 MB` |
| Topographic texture | PNG, up to `8192 px` |
| Route display points | about `10,488` |
| Route display sampling | `2 m` |
| Mesh smoothing | `0` |
| Relief smoothing | `0.10` |
| Slope smoothing | `0.6` |
| Exported screenshot | `7200 x 5400` PNG |

This is intentionally heavy. It is appropriate for a powerful local machine and high-density display. For public sharing over the internet, the next step should be tiled terrain and level-of-detail, not simply making this single mesh larger.

## How It Works

There are two parts:

1. Python asset baker: `../export_web_example.py`
2. Web viewer: this `web/` app

The Python script reads the GPX route, samples the elevation sources, builds terrain textures, converts everything into a static web asset package, and writes it to:

```text
web/public/assets/escursione-mattutina/
```

The React app then fetches:

```text
manifest.json
terrain.json
route.json
border.json
terrain-texture.png
terrain-topo-raw.png
terrain-hillshade.png
terrain-multishade.png
terrain-slope.png
terrain-hypso.png
terrain-normal.png
reference-render.png
reference-preview.jpg
angle-sheet.png
```

No Python code runs in the browser. The browser only loads static files.

## Data Sources

The default elevation recipe is designed to match the Python reference renderer:

- Piemonte ICE 2009-2011 DTM at `5 m` where available.
- IGN LiDAR HD / RGE ALTI fill at `1 m` where needed, especially around cross-border gaps.

The important point: increasing the web mesh density does not create new real-world detail beyond the source DEM. A `3000 x 3000` mesh displays the sampled surface more finely, but areas backed by Piemonte data still originate from a `5 m` DTM.

## Coordinate System

The web viewer uses a right-handed Three.js scene:

| Real-world direction | Scene axis |
| --- | --- |
| East | `+x` |
| North | `-z` |
| Elevation | `+y` |

The exporter stores route and border points in local projected meters. The viewer recenters them around the terrain midpoint and applies vertical exaggeration at render time.

## Run Locally

Install dependencies:

```bash
npm install
```

Start the development server:

```bash
npm run dev
```

Open:

```text
http://localhost:5173/
```

The dev server is configured with `--host 0.0.0.0`, so it can also be opened from another device on the same network if your firewall allows it.

## Build

```bash
npm run build
```

Preview the production build:

```bash
npm run preview
```

## Regenerate The Web Assets

From the repository root:

```bash
/opt/miniconda3/bin/python export_web_example.py
```

That command uses the max-quality defaults currently encoded in the exporter.

Equivalent explicit command:

```bash
WEB_DEM_SOURCE=mixed \
WEB_DEM_RES_M=1 \
WEB_GRID=3000 \
WEB_TEXTURE_MAX=8192 \
WEB_TILEZOOM=17 \
WEB_PIEMONTE_SAMPLE_ORDER=1 \
WEB_MESH_SMOOTH=0 \
WEB_RELIEF_SMOOTH=0.10 \
WEB_SLOPE_SMOOTH=0.6 \
WEB_ROUTE_STEP_M=2 \
/opt/miniconda3/bin/python export_web_example.py
```

## Exporter Knobs

| Variable | Default | Meaning |
| --- | ---: | --- |
| `WEB_DEM_SOURCE` | `mixed` | `mixed` uses Piemonte DTM first and IGN fill second. `ign` forces IGN-only sampling for inspection. |
| `WEB_DEM_RES_M` | `1` | Requested IGN fill resolution in meters. |
| `WEB_GRID` | `3000` | Browser terrain mesh resolution. Higher means more vertices and a much larger `terrain.json`. |
| `WEB_TEXTURE_MAX` | `8192` | Maximum draped topo texture dimension. |
| `WEB_TILEZOOM` | `17` | OpenTopoMap tile zoom used for the topo mosaic. |
| `WEB_PIEMONTE_SAMPLE_ORDER` | `1` | Interpolation order for Piemonte raster sampling. `1` is linear; `0` is nearest-neighbor and can look blocky. |
| `WEB_MESH_SMOOTH` | `0` | Gaussian smoothing applied to the actual displayed mesh. Keep at `0` for sharpest terrain. |
| `WEB_RELIEF_SMOOTH` | `0.10` | Smoothing used for auxiliary hillshade-like textures. |
| `WEB_SLOPE_SMOOTH` | `0.6` | Smoothing used before slope classification. Lower values are sharper but noisier. |
| `WEB_ROUTE_STEP_M` | `2` | GPX simplification step for the displayed route. Lower means more route points. |
| `WEB_MARGIN` | `0.0025` | Bounding-box padding around the GPX route, in degrees. |
| `WEB_DEM_CONTOURS` | `0` | Enable generated DEM contour overlay on the topo texture. Usually off because the topo tiles already include contours. |
| `WEB_CONTOUR_MINOR_M` | `40` | Minor generated contour interval if `WEB_DEM_CONTOURS=1`. |
| `WEB_CONTOUR_MAJOR_M` | `200` | Major generated contour interval if `WEB_DEM_CONTOURS=1`. |
| `WEB_BAKE_RELIEF` | `0` | Bake Python-style relief into the topo texture. Usually off so the topo texture remains closer to the source map. |
| `WEB_TEXTURE_SAT` | `1.45` | Color saturation applied to the topo texture. |
| `WEB_TEXTURE_BRIGHT` | `0.82` | Brightness applied to the topo texture. |
| `WEB_TEXTURE_CONTRAST` | `1.16` | Contrast applied to the topo texture. |

## Asset Contract

The viewer starts from `manifest.json`. The important fields are:

```ts
type ValleyManifest = {
  id: string;
  name: string;
  bounds: [number, number, number, number];
  projection: {
    kind: "local-equirectangular";
    lat0: number;
    originLon: number;
    originLat: number;
  };
  terrain: {
    data: string;
    heightmap: string;
    texture?: string;
    rawTexture?: string;
    hillshadeTexture?: string;
    multiHillshadeTexture?: string;
    slopeTexture?: string;
    hypsoTexture?: string;
    normalTexture?: string;
    demSource?: string;
    demSourceLabel?: string;
    gridSize: number;
    widthM: number;
    depthM: number;
    minHeightM: number;
    maxHeightM: number;
  };
  defaultCamera: {
    position: [number, number, number];
    target: [number, number, number];
    fov?: number;
  };
  routes: Array<{
    id: string;
    name: string;
    path: string;
    distanceKm: number;
    elevationGainM: number;
    pointCount: number;
  }>;
};
```

`terrain.json` stores:

```ts
type TerrainAsset = {
  gridSize: number;
  widthM: number;
  depthM: number;
  minHeightM: number;
  maxHeightM: number;
  heights: number[];
};
```

`route.json` stores route points in local meters:

```ts
type RoutePoint = {
  x: number;
  y: number;
  z: number;
  d: number;
  lat: number;
  lon: number;
};
```

In route points, `x` is east/west local meters, `y` is north/south local meters, `z` is elevation meters, and `d` is cumulative route distance.

## Viewer Controls

### Camera Modes

| Mode | Purpose |
| --- | --- |
| Orbit | Rotate around the selected viewpoint or framed route. Best for composing still images. |
| Free camera | Move through the scene with simplified keyboard and pointer controls. Best for exploring the valley. |
| Route follow | Preview a camera moving near the trek route. This is an early replay mode, not a final cinematic renderer. |

### Texture Modes

| Mode | What it shows |
| --- | --- |
| Reference topo | Enhanced topo texture intended for normal viewing and screenshots. |
| Raw topo | Same topo mosaic before relief-specific changes. Useful for inspection. |
| LiDAR shade | Single-direction hillshade from the elevation surface. |
| Multi shade | Multi-direction shade to reveal terrain in more orientations. |
| Slope angle | Slope classes computed from `atan(sqrt((dz/dx)^2 + (dz/dy)^2))`. |
| Hypsometric | Elevation-colored shaded terrain. |
| Surface | Plain vertex-colored terrain when no texture is used. |

Changing texture mode updates the material map in place. It should not reset the camera or rebuild the terrain scene.

### Screenshot Export

The export button renders the current camera view to a `7200 x 5400` PNG and shows a download preview. This is intentionally much larger than the visible canvas so that still images look good on high-density displays.

## Rendering Pipeline

The web renderer uses:

- Three.js `BufferGeometry` terrain mesh.
- Typed arrays for positions, UVs, colors, and indices.
- `MeshLambertMaterial` with high-resolution texture maps.
- Linear mipmapped texture filtering.
- Maximum available anisotropy.
- Right-handed terrain orientation.
- Northwest mountain-map style directional light.
- Ambient and hemisphere fill.
- Weak camera headlight.
- SSAO in high quality.
- FXAA post-processing.
- Supersampled PNG export.

This is inspired by the Python/PyVista output, but it is not the same renderer. PyVista/VTK and browser WebGL have different shading, antialiasing, and geometry pipelines.

## Why The Web Image Can Still Differ From Python

The largest differences usually come from:

- Elevation source coverage: Piemonte 5 m data vs IGN 1 m fill.
- Mesh architecture: one browser mesh vs PyVista's offline rendering path.
- Texture source: OpenTopoMap tile mosaic vs whatever cartographic layer the Python render used.
- Lighting model: browser Lambert + SSAO vs VTK/PyVista shading and SSAA.
- Screen-space effects: browser post-processing depends on viewport and GPU.
- Texture compression/history: the current max-quality bake uses PNG, but older generated JPEGs may still exist in the asset folder.

The current setup minimizes avoidable losses in the browser, but the true next fidelity jump is tiled terrain with LOD and source-native raster tiles.

## Known Limits

- The app currently loads one monolithic terrain JSON.
- `3000 x 3000` is near the practical ceiling for this architecture.
- Initial load can be slow because the terrain payload is large.
- Public sharing will be bandwidth-heavy unless assets are tiled/compressed differently.
- The replay mode is a preview, not a final authored cinematic timeline.
- Saved shots are currently in app state/mock data, not persisted to a backend.
- The Python offline baker remains the source of truth for terrain data preparation.

## Recommended Next Architecture

For even higher quality without making the app fragile, move from a single mesh to tiled terrain:

1. Split the DEM into terrain tiles.
2. Store each tile as a binary height tile, not one giant JSON file.
3. Generate multiple LOD levels per tile.
4. Load high-resolution tiles only near the camera.
5. Keep lower-resolution tiles in the distance.
6. Use matching tiled topo/relief textures.
7. Stream route segments and overlays by visible tile.

This would allow the same source data to look sharper close to the camera while keeping far terrain manageable.

## Troubleshooting

### The viewer is blank

Check the browser console first. Common causes:

- `manifest.json` was not generated.
- `terrain.json` is missing or partially written.
- Vite is serving an old asset folder.
- The browser ran out of memory while parsing the monolithic terrain JSON.

### The terrain looks mirrored

Verify the scene mapping:

- East must be `+x`.
- North must be `-z`.
- Elevation must be `+y`.

The current viewer already uses this orientation.

### Texture switching resets the camera

That should not happen. Texture changes are handled separately from scene creation. If this regresses, check the dependency list of the main scene-building `useEffect` in `src/TerrainViewer.tsx`; `state.textureMode` should not force scene teardown.

### The terrain looks too smooth

Regenerate with:

```bash
WEB_MESH_SMOOTH=0 WEB_RELIEF_SMOOTH=0.05 WEB_SLOPE_SMOOTH=0.4 /opt/miniconda3/bin/python export_web_example.py
```

The terrain cannot become sharper than the source DEM. For Piemonte-backed cells, the underlying source is still 5 m.

### The slope view looks noisy

Increase slope smoothing:

```bash
WEB_SLOPE_SMOOTH=1.2 /opt/miniconda3/bin/python export_web_example.py
```

### The app is too slow

Use a smaller grid:

```bash
WEB_GRID=2000 WEB_TEXTURE_MAX=4096 /opt/miniconda3/bin/python export_web_example.py
```

This lowers fidelity, but it is still a strong interactive preview.

## Important Files

| File | Purpose |
| --- | --- |
| `../export_web_example.py` | Python asset exporter. |
| `src/App.tsx` | Main UI shell, panels, HUD, timeline, export preview. |
| `src/TerrainViewer.tsx` | Three.js scene, terrain mesh, route/border geometry, camera controls, screenshot export. |
| `src/mockData.ts` | Local valley metadata and initial saved shots. |
| `src/types.ts` | Shared TypeScript data contracts. |
| `src/styles.css` | Visual design system and layout. |
| `public/assets/escursione-mattutina/manifest.json` | Entry point for generated assets. |
| `public/assets/escursione-mattutina/terrain.json` | Monolithic terrain heightfield. |
| `public/assets/escursione-mattutina/route.json` | Display route points. |

## Development Notes

- Keep the web app static-file friendly. The asset baker can be complex; the viewer should remain easy to host.
- Keep camera controls focused on photography and replay, not aircraft simulation.
- Avoid flight-simulator terminology in the UI.
- Prefer preserving camera state across visual changes.
- Treat the Python reference PNG as the visual benchmark.
- If quality needs to increase again, invest in tiled terrain + LOD rather than pushing the monolithic mesh much further.
