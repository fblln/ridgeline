/**
 * Three.js geometry builders for generated terrain, GPX routes, and overlays.
 * The returned objects own GPU resources and must be disposed by the caller.
 */
import * as THREE from "three";
import type { BorderAsset, RouteAsset, TerrainAsset, ViewerState } from "../types";
import { buildRouteSampler } from "./routeFollow";

export function createPointerTexture() {
  const canvas = document.createElement("canvas");
  canvas.width = 256;
  canvas.height = 256;
  const ctx = canvas.getContext("2d");
  if (!ctx) return new THREE.CanvasTexture(canvas);

  ctx.clearRect(0, 0, canvas.width, canvas.height);

  const blaze = "#d8542b";
  const paper = "#fcf9f1";

  ctx.lineWidth = 10;
  ctx.strokeStyle = "rgba(216, 84, 43, 0.34)";
  ctx.beginPath();
  ctx.arc(128, 128, 58, 0, Math.PI * 2);
  ctx.stroke();

  ctx.lineWidth = 7;
  ctx.strokeStyle = blaze;
  ctx.beginPath();
  ctx.arc(128, 128, 36, 0, Math.PI * 2);
  ctx.stroke();

  ctx.beginPath();
  ctx.arc(128, 128, 27, 0, Math.PI * 2);
  ctx.fillStyle = paper;
  ctx.fill();

  ctx.beginPath();
  ctx.arc(128, 128, 16, 0, Math.PI * 2);
  ctx.fillStyle = blaze;
  ctx.fill();

  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.minFilter = THREE.LinearFilter;
  texture.magFilter = THREE.LinearFilter;
  texture.generateMipmaps = false;
  return texture;
}

// 3x3 unsharp mask keeps LiDAR ridges legible after grid downsampling.
const SHARPEN = 0.5;
export function sharpenHeights(terrain: TerrainAsset, rows: number, cols: number, skip: number, n: number) {
  const grid = new Float32Array(rows * cols);
  for (let r = 0; r < rows; r += 1) {
    const sourceR = Math.min(n - 1, r * skip);
    for (let c = 0; c < cols; c += 1) {
      grid[r * cols + c] = terrain.heights[sourceR * n + Math.min(n - 1, c * skip)];
    }
  }
  if (SHARPEN <= 0) return grid;
  const out = new Float32Array(rows * cols);
  for (let r = 0; r < rows; r += 1) {
    for (let c = 0; c < cols; c += 1) {
      let sum = 0;
      let count = 0;
      for (let dr = -1; dr <= 1; dr += 1) {
        for (let dc = -1; dc <= 1; dc += 1) {
          const rr = r + dr;
          const cc = c + dc;
          if (rr < 0 || rr >= rows || cc < 0 || cc >= cols) continue;
          sum += grid[rr * cols + cc];
          count += 1;
        }
      }
      const h = grid[r * cols + c];
      out[r * cols + c] = h + SHARPEN * (h - sum / count);
    }
  }
  return out;
}

export function buildTerrainGeometry(
  terrain: TerrainAsset,
  verticalExaggeration: number,
  quality: ViewerState["quality"],
) {
  const skip = quality === "low" ? 4 : quality === "balanced" ? 2 : 1;
  const n = terrain.gridSize;
  const cols = Math.floor((n - 1) / skip) + 1;
  const rows = cols;
  const vertexCount = rows * cols;
  const quadCount = (rows - 1) * (cols - 1);
  const positions = new Float32Array(vertexCount * 3);
  const colors = new Float32Array(vertexCount * 3);
  const uvs = new Float32Array(vertexCount * 2);
  const indices = new Uint32Array(quadCount * 6);
  const color = new THREE.Color();
  let vertexOffset = 0;
  let uvOffset = 0;

  // Unsharp-mask the LiDAR heights so ridges/valleys read crisp instead of blobby.
  const grid = sharpenHeights(terrain, rows, cols, skip, n);

  for (let r = 0; r < rows; r += 1) {
    const sourceR = Math.min(n - 1, r * skip);
    const z = terrain.depthM / 2 - (sourceR / (n - 1)) * terrain.depthM;
    for (let c = 0; c < cols; c += 1) {
      const sourceC = Math.min(n - 1, c * skip);
      const x = (sourceC / (n - 1)) * terrain.widthM - terrain.widthM / 2;
      const h = grid[r * cols + c];
      const t = (h - terrain.minHeightM) / (terrain.maxHeightM - terrain.minHeightM);
      positions[vertexOffset] = x;
      positions[vertexOffset + 1] = (h - terrain.minHeightM) * verticalExaggeration;
      positions[vertexOffset + 2] = z;
      color.setHSL(0.27 - t * 0.12, 0.22 + t * 0.14, 0.25 + t * 0.28);
      colors[vertexOffset] = color.r;
      colors[vertexOffset + 1] = color.g;
      colors[vertexOffset + 2] = color.b;
      uvs[uvOffset] = sourceC / (n - 1);
      uvs[uvOffset + 1] = 1 - sourceR / (n - 1);
      vertexOffset += 3;
      uvOffset += 2;
    }
  }

  let indexOffset = 0;
  for (let r = 0; r < rows - 1; r += 1) {
    for (let c = 0; c < cols - 1; c += 1) {
      const a = r * cols + c;
      const b = a + 1;
      const d = (r + 1) * cols + c;
      const e = d + 1;
      indices[indexOffset] = a;
      indices[indexOffset + 1] = b;
      indices[indexOffset + 2] = d;
      indices[indexOffset + 3] = b;
      indices[indexOffset + 4] = e;
      indices[indexOffset + 5] = d;
      indexOffset += 6;
    }
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute("color", new THREE.BufferAttribute(colors, 3));
  geometry.setAttribute("uv", new THREE.BufferAttribute(uvs, 2));
  geometry.setIndex(new THREE.BufferAttribute(indices, 1));
  geometry.computeVertexNormals();
  return geometry;
}

export function buildRouteObject(route: RouteAsset, terrain: TerrainAsset, verticalExaggeration: number) {
  const points = route.points.map(
    (point) =>
      new THREE.Vector3(
        point.x - terrain.widthM / 2,
        (point.z - terrain.minHeightM) * verticalExaggeration + 14,
        terrain.depthM / 2 - point.y,
      ),
  );
  const curve = new THREE.CatmullRomCurve3(points, false, "centripetal", 0.3);
  const geometry = new THREE.TubeGeometry(curve, Math.min(1600, points.length * 2), 11, 10, false);
  const material = new THREE.MeshBasicMaterial({ color: 0xd33b22 });
  return {
    mesh: new THREE.Mesh(geometry, material),
    points,
    sampler: buildRouteSampler(route, points),
  };
}

export function buildBorderGroup(border: BorderAsset | null, terrain: TerrainAsset, verticalExaggeration: number) {
  const group = new THREE.Group();
  if (!border) return group;
  const material = new THREE.MeshBasicMaterial({ color: border.color || 0x2f6fb0 });
  for (const line of border.lines) {
    if (line.length < 2) continue;
    const points = line.map(
      (point) =>
        new THREE.Vector3(
          point.x - terrain.widthM / 2,
          (point.z - terrain.minHeightM) * verticalExaggeration + 34,
          terrain.depthM / 2 - point.y,
        ),
    );
    const curve = new THREE.CatmullRomCurve3(points, false, "centripetal", 0.2);
    group.add(new THREE.Mesh(new THREE.TubeGeometry(curve, Math.min(1200, points.length * 4), 14, 8, false), material));
  }
  return group;
}
