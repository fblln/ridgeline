# Ridgeline

Ridgeline turns GPX routes into shareable 2D and 3D LiDAR terrain. The repo is
organized as a small monorepo: a React + Three.js viewer, a Python asset baker,
and one sample GPX route for reproducing the terrain pipeline locally.

The committed README media shows a generated sample, but runtime terrain assets
are intentionally not checked into Git. Generate them locally before opening the
sample viewer.

## Layout

| Path | Purpose |
|---|---|
| `web/` | Vite + React + Three.js terrain viewer, local GPX import API, and showcase README. |
| `tools/asset-baker/` | Python terrain/texture/route asset generator. |
| `examples/gpx/` | Sample GPX input used to regenerate the bundled showcase route locally. |

## Run The Web App

```bash
cd web
npm install
npm run dev
```

Open <http://localhost:5173/>.

On a clean clone, the sample terrain will be unavailable until assets are
generated.

## Generate Sample Terrain Assets

Create a Python environment and install the baker dependencies:

```bash
python -m venv .venv
source .venv/bin/activate
pip install -r tools/asset-baker/requirements.txt
```

Generate the sample asset package:

```bash
python tools/asset-baker/export_web_example.py examples/gpx/Escursione_mattutina.gpx
```

This writes ignored runtime assets under:

```text
web/public/assets/escursione-mattutina/
```

Then run the web app and load the sample area.

## More Detail

The full product walkthrough, screenshots, tracing view, and architecture notes
live in [web/README.md](web/README.md).
