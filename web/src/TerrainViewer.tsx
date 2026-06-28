import { Loader2, Map, Mountain } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import * as THREE from "three";
import { EffectComposer } from "three/examples/jsm/postprocessing/EffectComposer.js";
import { FXAAPass } from "three/examples/jsm/postprocessing/FXAAPass.js";
import { RenderPass } from "three/examples/jsm/postprocessing/RenderPass.js";
import { SSAOPass } from "three/examples/jsm/postprocessing/SSAOPass.js";
import type {
  AppStatus,
  BorderAsset,
  CameraMode,
  CameraSnapshot,
  RouteAsset,
  SavedShot,
  TerrainAsset,
  ValleyManifest,
  ViewerState,
} from "./types";

type ViewerCommand = {
  frameRoute: number;
  reset: number;
  exportImage: number;
};

type TerrainViewerProps = {
  status: AppStatus;
  valley: ValleyManifest | null;
  routeId: string | null;
  state: ViewerState;
  selectedShot: SavedShot | null;
  replayPosition: number;
  commands: ViewerCommand;
  onCameraChange: (snapshot: CameraSnapshot) => void;
  onAssetsLoaded: (route: RouteAsset | null) => void;
};

type LoadedAssets = {
  manifest: ValleyManifest;
  terrain: TerrainAsset;
  route: RouteAsset;
  border: BorderAsset | null;
  textureUrls: Partial<Record<ViewerState["textureMode"], string>>;
};

type RenderPipeline = {
  composer: EffectComposer | null;
  fxaaPass: FXAAPass | null;
  ssaoPass: SSAOPass | null;
};

type RouteSampler = {
  points: THREE.Vector3[];
  distances: number[];
  totalDistanceM: number;
};

type RouteFollowState = {
  distanceM: number;
  heading: THREE.Vector3;
  position: THREE.Vector3;
  target: THREE.Vector3;
  sideOffsetM: number;
  settled: boolean;
};

type CameraRig = {
  target: THREE.Vector3;
  radius: number;
  theta: number;
  phi: number;
};

type TerrainLightingPreset = {
  exposure: number;
  ambient: {
    color: number;
    intensity: number;
  };
  hemisphere: {
    skyColor: number;
    groundColor: number;
    intensity: number;
  };
  sun: {
    color: number;
    intensity: number;
    position: [number, number, number];
  };
  headlight: {
    color: number;
    intensity: number;
  };
  material: {
    emissive: number;
    emissiveIntensity: number;
  };
  relief?: {
    intensity: number;
    contrast: number;
    forest?: number;
  };
};

type TerrainLightingRig = {
  renderer: THREE.WebGLRenderer;
  ambient: THREE.AmbientLight;
  hemi: THREE.HemisphereLight;
  sun: THREE.DirectionalLight;
  headlight: THREE.PointLight;
  terrainMaterial?: THREE.MeshPhongMaterial | null;
};

const toRad = Math.PI / 180;
const maxDisplayPixelRatio = 3;
const exportWidth = 7200;
const exportHeight = 5400;
const sceneLayer = 0;
const markerOverlayLayer = 1;
const neutralReliefTexture = new THREE.DataTexture(new Uint8Array([255, 255, 255, 255]), 1, 1);
neutralReliefTexture.needsUpdate = true;
const routeFollowConfig = {
  trailBackM: 1650,
  cameraAltitudeM: 930,
  minCameraDistanceM: 1450,
  maxCameraDistanceM: 2050,
  targetLookAheadM: 320,
  targetAltitudeM: 95,
  headingBackM: 500,
  headingForwardM: 740,
  occlusionClearanceM: 140,
  sideStepM: 680,
  targetSideRatio: 0.2,
  sideDamping: 0.68,
  scrubResetM: 1100,
  distanceDamping: 1.85,
  headingDamping: 0.88,
  positionDamping: 1.0,
  targetDamping: 1.12,
  fov: 47,
  fovDamping: 0.9,
};

const terrainLightingPresets: Record<ViewerState["textureMode"], TerrainLightingPreset> = {
  topographic: {
    exposure: 1.2,
    ambient: { color: 0xffffff, intensity: 1.5 },
    hemisphere: { skyColor: 0xffffff, groundColor: 0xe2dac6, intensity: 1.1 },
    sun: { color: 0xfff2dc, intensity: 0.5, position: [-1.15, 2.4, -0.95] },
    headlight: { color: 0xffffff, intensity: 0.08 },
    material: { emissive: 0xffffff, emissiveIntensity: 0.18 },
    relief: { intensity: 0.72, contrast: 1.7, forest: 0.3 },
  },
  "raw-topo": {
    exposure: 1.02,
    ambient: { color: 0xffffff, intensity: 0.58 },
    hemisphere: { skyColor: 0xffffff, groundColor: 0x9a8963, intensity: 0.62 },
    sun: { color: 0xffffff, intensity: 0.58, position: [-1.0, 2.55, -0.86] },
    headlight: { color: 0xffffff, intensity: 0.16 },
    material: { emissive: 0xffffff, emissiveIntensity: 0.28 },
    relief: { intensity: 0.6, contrast: 1.5 },
  },
  "lidar-shade": {
    exposure: 1.0,
    ambient: { color: 0xdfe5eb, intensity: 0.62 },
    hemisphere: { skyColor: 0xf3f7fb, groundColor: 0x8a806d, intensity: 0.74 },
    sun: { color: 0xfff7e8, intensity: 0.28, position: [-0.95, 2.4, -0.75] },
    headlight: { color: 0xffffff, intensity: 0.1 },
    material: { emissive: 0xffffff, emissiveIntensity: 0.7 },
  },
  "multi-shade": {
    exposure: 1.0,
    ambient: { color: 0xe2e7ec, intensity: 0.64 },
    hemisphere: { skyColor: 0xf4f8fb, groundColor: 0x807765, intensity: 0.76 },
    sun: { color: 0xfff6e6, intensity: 0.22, position: [-0.9, 2.35, -0.8] },
    headlight: { color: 0xffffff, intensity: 0.08 },
    material: { emissive: 0xffffff, emissiveIntensity: 0.74 },
  },
  slope: {
    exposure: 0.98,
    ambient: { color: 0xffffff, intensity: 0.74 },
    hemisphere: { skyColor: 0xffffff, groundColor: 0x8a8a7a, intensity: 0.58 },
    sun: { color: 0xffffff, intensity: 0.12, position: [-0.8, 2.4, -0.75] },
    headlight: { color: 0xffffff, intensity: 0.04 },
    material: { emissive: 0xffffff, emissiveIntensity: 0.86 },
  },
  hypsometric: {
    exposure: 1.0,
    ambient: { color: 0xffffff, intensity: 0.7 },
    hemisphere: { skyColor: 0xf9fbff, groundColor: 0x8a8068, intensity: 0.6 },
    sun: { color: 0xffffff, intensity: 0.16, position: [-0.85, 2.3, -0.8] },
    headlight: { color: 0xffffff, intensity: 0.05 },
    material: { emissive: 0xffffff, emissiveIntensity: 0.82 },
  },
  forest: {
    exposure: 1.0,
    ambient: { color: 0xffffff, intensity: 0.72 },
    hemisphere: { skyColor: 0xf9fbff, groundColor: 0x8a8068, intensity: 0.6 },
    sun: { color: 0xffffff, intensity: 0.16, position: [-0.85, 2.3, -0.8] },
    headlight: { color: 0xffffff, intensity: 0.05 },
    material: { emissive: 0xffffff, emissiveIntensity: 0.82 },
  },
  surface: {
    exposure: 1.14,
    ambient: { color: 0xe5eff7, intensity: 0.64 },
    hemisphere: { skyColor: 0xffffff, groundColor: 0x8c7b54, intensity: 0.94 },
    sun: { color: 0xfff3d2, intensity: 0.82, position: [-1.08, 2.35, -0.82] },
    headlight: { color: 0xfff7e6, intensity: 0.12 },
    material: { emissive: 0x181818, emissiveIntensity: 0.03 },
  },
};

function classForStatus(status: AppStatus) {
  return status === "ready" ? "viewport ready" : "viewport dimmed";
}

function distance2d(a: THREE.Vector3, b: THREE.Vector3) {
  return Math.hypot(a.x - b.x, a.z - b.z);
}

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

function localToScene(point: [number, number, number], terrain: TerrainAsset, verticalExaggeration: number) {
  return new THREE.Vector3(
    point[0] - terrain.widthM / 2,
    (point[2] - terrain.minHeightM) * verticalExaggeration,
    terrain.depthM / 2 - point[1],
  );
}

function sceneToLocal(point: THREE.Vector3, terrain: TerrainAsset, verticalExaggeration: number): [number, number, number] {
  return [
    point.x + terrain.widthM / 2,
    terrain.depthM / 2 - point.z,
    point.y / verticalExaggeration + terrain.minHeightM,
  ];
}

function computeRigFromCamera(camera: THREE.PerspectiveCamera, target: THREE.Vector3): CameraRig {
  const offset = camera.position.clone().sub(target);
  const radius = Math.max(10, offset.length());
  return {
    target: target.clone(),
    radius,
    theta: Math.atan2(offset.x, offset.z),
    phi: Math.acos(clamp(offset.y / radius, 0.08, 0.98)),
  };
}

function applyRig(camera: THREE.PerspectiveCamera, rig: CameraRig) {
  const sinPhi = Math.sin(rig.phi);
  camera.position.set(
    rig.target.x + rig.radius * sinPhi * Math.sin(rig.theta),
    rig.target.y + rig.radius * Math.cos(rig.phi),
    rig.target.z + rig.radius * sinPhi * Math.cos(rig.theta),
  );
  camera.lookAt(rig.target);
}

function dampingAlpha(damping: number, dt: number) {
  return 1 - Math.exp(-damping * dt);
}

function buildRouteSampler(route: RouteAsset, points: THREE.Vector3[]): RouteSampler {
  const distances = new Array<number>(points.length).fill(0);
  const firstRouteDistance = route.points[0]?.d ?? 0;
  for (let i = 1; i < points.length; i += 1) {
    const routeDistance = route.points[i]?.d;
    const fromRoute = typeof routeDistance === "number" ? routeDistance - firstRouteDistance : NaN;
    distances[i] = Number.isFinite(fromRoute) && fromRoute > distances[i - 1]
      ? fromRoute
      : distances[i - 1] + points[i].distanceTo(points[i - 1]);
  }
  return {
    points,
    distances,
    totalDistanceM: Math.max(distances[distances.length - 1] ?? 0, route.distanceKm * 1000),
  };
}

function sampleRouteDistance(sampler: RouteSampler, distanceM: number, target = new THREE.Vector3()) {
  const { points, distances } = sampler;
  if (points.length === 0) return target.set(0, 0, 0);
  if (points.length === 1) return target.copy(points[0]);
  const distance = clamp(distanceM, 0, sampler.totalDistanceM);
  if (distance <= distances[0]) return target.copy(points[0]);
  const last = points.length - 1;
  if (distance >= distances[last]) return target.copy(points[last]);

  let low = 0;
  let high = last;
  while (low + 1 < high) {
    const mid = Math.floor((low + high) / 2);
    if (distances[mid] <= distance) low = mid;
    else high = mid;
  }

  const span = Math.max(0.001, distances[high] - distances[low]);
  return target.lerpVectors(points[low], points[high], (distance - distances[low]) / span);
}

function routeHeadingAtDistance(sampler: RouteSampler, distanceM: number, target = new THREE.Vector3()) {
  const behind = sampleRouteDistance(sampler, distanceM - routeFollowConfig.headingBackM);
  const ahead = sampleRouteDistance(sampler, distanceM + routeFollowConfig.headingForwardM);
  target.copy(ahead).sub(behind);
  target.y = 0;
  if (target.lengthSq() < 1) target.set(0, 0, -1);
  return target.normalize();
}

function clampFollowCameraPosition(subject: THREE.Vector3, position: THREE.Vector3) {
  const offset = position.clone().sub(subject);
  const distance = offset.length();
  if (distance < 1) return position;
  const clampedDistance = clamp(
    distance,
    routeFollowConfig.minCameraDistanceM,
    routeFollowConfig.maxCameraDistanceM,
  );
  if (Math.abs(clampedDistance - distance) < 0.01) return position;
  return subject.clone().add(offset.multiplyScalar(clampedDistance / distance));
}

function terrainHeightAtScene(
  terrain: TerrainAsset,
  sceneX: number,
  sceneZ: number,
  verticalExaggeration: number,
) {
  const n = terrain.gridSize;
  if (n < 2) return 0;
  const u = clamp((sceneX + terrain.widthM / 2) / terrain.widthM, 0, 1) * (n - 1);
  const v = clamp((terrain.depthM / 2 - sceneZ) / terrain.depthM, 0, 1) * (n - 1);
  const c0 = Math.floor(u);
  const r0 = Math.floor(v);
  const c1 = Math.min(n - 1, c0 + 1);
  const r1 = Math.min(n - 1, r0 + 1);
  const tx = u - c0;
  const tz = v - r0;
  const h00 = terrain.heights[r0 * n + c0] ?? terrain.minHeightM;
  const h10 = terrain.heights[r0 * n + c1] ?? h00;
  const h01 = terrain.heights[r1 * n + c0] ?? h00;
  const h11 = terrain.heights[r1 * n + c1] ?? h10;
  const h0 = h00 + (h10 - h00) * tx;
  const h1 = h01 + (h11 - h01) * tx;
  return (h0 + (h1 - h0) * tz - terrain.minHeightM) * verticalExaggeration;
}

function sightlineOcclusionScore(
  terrain: TerrainAsset,
  verticalExaggeration: number,
  eye: THREE.Vector3,
  target: THREE.Vector3,
) {
  let score = 0;
  const sample = new THREE.Vector3();
  for (let i = 1; i <= 14; i += 1) {
    const t = i / 16;
    sample.lerpVectors(eye, target, t);
    const terrainY = terrainHeightAtScene(terrain, sample.x, sample.z, verticalExaggeration);
    score = Math.max(score, terrainY + routeFollowConfig.occlusionClearanceM - sample.y);
  }
  return Math.max(0, score);
}

function sideOffsetForSightline(
  terrain: TerrainAsset,
  verticalExaggeration: number,
  heading: THREE.Vector3,
  basePosition: THREE.Vector3,
  baseTarget: THREE.Vector3,
) {
  const right = new THREE.Vector3(heading.z, 0, -heading.x);
  if (right.lengthSq() < 0.001) return 0;
  right.normalize();
  const centerScore = sightlineOcclusionScore(terrain, verticalExaggeration, basePosition, baseTarget);
  if (centerScore <= 0) return 0;

  let bestOffset = 0;
  let bestScore = centerScore;
  for (const direction of [-1, 1]) {
    const offset = direction * routeFollowConfig.sideStepM;
    const position = basePosition.clone().add(right.clone().multiplyScalar(offset));
    const target = baseTarget.clone().add(right.clone().multiplyScalar(offset * routeFollowConfig.targetSideRatio));
    const score = sightlineOcclusionScore(terrain, verticalExaggeration, position, target);
    if (score < bestScore) {
      bestScore = score;
      bestOffset = offset;
    }
  }

  const strength = clamp(centerScore / 260, 0.25, 1);
  return bestOffset * strength;
}

function createPointerTexture() {
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

// ponytail: 3x3 unsharp mask. Crisps geometry; raise SHARPEN for sharper, 0 disables.
const SHARPEN = 0.5;
function sharpenHeights(terrain: TerrainAsset, rows: number, cols: number, skip: number, n: number) {
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

function buildTerrainGeometry(terrain: TerrainAsset, verticalExaggeration: number, quality: ViewerState["quality"]) {
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

function buildRouteObject(route: RouteAsset, terrain: TerrainAsset, verticalExaggeration: number) {
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

function buildBorderGroup(border: BorderAsset | null, terrain: TerrainAsset, verticalExaggeration: number) {
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

function isPaperTextureMode(textureMode: ViewerState["textureMode"]) {
  return textureMode === "topographic" || textureMode === "raw-topo";
}

function configureColorTexture(
  texture: THREE.Texture,
  renderer: THREE.WebGLRenderer | null,
  textureMode: ViewerState["textureMode"],
) {
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.flipY = false;
  texture.anisotropy = renderer?.capabilities.getMaxAnisotropy() ?? 1;
  texture.magFilter = THREE.LinearFilter;
  texture.wrapS = THREE.ClampToEdgeWrapping;
  texture.wrapT = THREE.ClampToEdgeWrapping;
  texture.generateMipmaps = !isPaperTextureMode(textureMode);
  texture.minFilter = isPaperTextureMode(textureMode) ? THREE.LinearFilter : THREE.LinearMipmapLinearFilter;
}

function configureReliefTexture(texture: THREE.Texture, renderer: THREE.WebGLRenderer | null) {
  texture.flipY = false;
  texture.colorSpace = THREE.NoColorSpace;
  texture.anisotropy = renderer?.capabilities.getMaxAnisotropy() ?? 1;
  texture.magFilter = THREE.LinearFilter;
  texture.minFilter = THREE.LinearMipmapLinearFilter;
  texture.wrapS = THREE.ClampToEdgeWrapping;
  texture.wrapT = THREE.ClampToEdgeWrapping;
}

function installTerrainReliefShader(material: THREE.MeshPhongMaterial) {
  material.onBeforeCompile = (shader) => {
    const userData = material.userData as {
      terrainReliefTexture?: THREE.Texture | null;
      terrainReliefIntensity?: number;
      terrainReliefContrast?: number;
      terrainForestTexture?: THREE.Texture | null;
      terrainForestIntensity?: number;
      terrainReliefUniforms?: Record<string, { value: unknown }>;
    };
    shader.uniforms.terrainReliefMap = {
      value: userData.terrainReliefTexture ?? neutralReliefTexture,
    };
    shader.uniforms.terrainReliefIntensity = {
      value: userData.terrainReliefIntensity ?? 0,
    };
    shader.uniforms.terrainReliefContrast = {
      value: userData.terrainReliefContrast ?? 1,
    };
    shader.uniforms.terrainForestMap = {
      value: userData.terrainForestTexture ?? neutralReliefTexture,
    };
    shader.uniforms.terrainForestIntensity = {
      value: userData.terrainForestIntensity ?? 0,
    };
    userData.terrainReliefUniforms = shader.uniforms;
    shader.fragmentShader = shader.fragmentShader.replace(
      "#include <map_pars_fragment>",
      `#include <map_pars_fragment>
uniform sampler2D terrainReliefMap;
uniform float terrainReliefIntensity;
uniform float terrainReliefContrast;
uniform sampler2D terrainForestMap;
uniform float terrainForestIntensity;`,
    );
    shader.fragmentShader = shader.fragmentShader.replace(
      "#include <map_fragment>",
      `#include <map_fragment>
#ifdef USE_MAP
  // Papery look on map layers: desaturate the vivid OSM colours and warm them toward cream.
  if ( terrainReliefIntensity > 0.0 ) {
    float paperLum = dot( diffuseColor.rgb, vec3( 0.299, 0.587, 0.114 ) );
    vec3 paper = mix( diffuseColor.rgb, vec3( paperLum ), 0.55 );
    paper *= vec3( 1.05, 1.0, 0.88 );
    diffuseColor.rgb = mix( diffuseColor.rgb, paper, 0.65 );
  }
  float terrainRelief = texture2D( terrainReliefMap, vMapUv ).r;
  terrainRelief = clamp( ( terrainRelief - 0.5 ) * terrainReliefContrast + 0.5, 0.0, 1.0 );
  // Centred on 1.0 so relief lightens highlights and darkens shadows equally (no net darkening).
  float terrainReliefFactor = mix( 1.0, 0.72 + 0.56 * terrainRelief, terrainReliefIntensity );
  diffuseColor.rgb *= terrainReliefFactor;
  // Hint canopy from the forest layer: multiplicative green tint keeps the relief detail underneath.
  if ( terrainForestIntensity > 0.0 ) {
    vec3 terrainForestTexel = texture2D( terrainForestMap, vMapUv ).rgb;
    float terrainForestMask = clamp( ( terrainForestTexel.g - max( terrainForestTexel.r, terrainForestTexel.b ) ) * 6.0, 0.0, 1.0 );
    vec3 terrainForested = diffuseColor.rgb * vec3( 0.66, 0.92, 0.58 );
    diffuseColor.rgb = mix( diffuseColor.rgb, terrainForested, terrainForestMask * terrainForestIntensity );
  }
#endif`,
    );
  };
  material.customProgramCacheKey = () => "terrain-relief-v4";
}

function applyTerrainReliefPreset(
  textureMode: ViewerState["textureMode"],
  material: THREE.MeshPhongMaterial | null,
  reliefTexture: THREE.Texture | null,
  forestTexture: THREE.Texture | null,
) {
  if (!material) return;
  const relief = terrainLightingPresets[textureMode].relief;
  const userData = material.userData as {
    terrainReliefTexture?: THREE.Texture | null;
    terrainReliefIntensity?: number;
    terrainReliefContrast?: number;
    terrainForestTexture?: THREE.Texture | null;
    terrainForestIntensity?: number;
    terrainReliefUniforms?: Record<string, { value: unknown }>;
  };
  userData.terrainReliefTexture = reliefTexture ?? neutralReliefTexture;
  userData.terrainReliefIntensity = relief?.intensity ?? 0;
  userData.terrainReliefContrast = relief?.contrast ?? 1;
  userData.terrainForestTexture = forestTexture ?? neutralReliefTexture;
  userData.terrainForestIntensity = forestTexture ? relief?.forest ?? 0 : 0;
  const uniforms = userData.terrainReliefUniforms;
  if (uniforms) {
    uniforms.terrainReliefMap.value = userData.terrainReliefTexture;
    uniforms.terrainReliefIntensity.value = userData.terrainReliefIntensity;
    uniforms.terrainReliefContrast.value = userData.terrainReliefContrast;
    uniforms.terrainForestMap.value = userData.terrainForestTexture;
    uniforms.terrainForestIntensity.value = userData.terrainForestIntensity;
  }
  material.needsUpdate = true;
}

function applyPostProcessingForTextureMode(textureMode: ViewerState["textureMode"], pipeline: RenderPipeline | null) {
  if (!pipeline) return;
  if (pipeline.fxaaPass) pipeline.fxaaPass.enabled = true;
  if (pipeline.ssaoPass) {
    pipeline.ssaoPass.enabled = true;
    pipeline.ssaoPass.kernelRadius = isPaperTextureMode(textureMode) ? 14 : 12;
    pipeline.ssaoPass.minDistance = isPaperTextureMode(textureMode) ? 0.001 : 0.0015;
    pipeline.ssaoPass.maxDistance = isPaperTextureMode(textureMode) ? 0.045 : 0.04;
  }
}

function getTerrainLightingPreset(textureMode: ViewerState["textureMode"], hasTexture: boolean) {
  return hasTexture ? terrainLightingPresets[textureMode] : terrainLightingPresets.surface;
}

function applyTerrainLightingPreset(
  textureMode: ViewerState["textureMode"],
  hasTexture: boolean,
  span: number,
  rig: TerrainLightingRig | null,
) {
  if (!rig) return;
  const preset = getTerrainLightingPreset(textureMode, hasTexture);
  rig.renderer.toneMappingExposure = preset.exposure;
  rig.ambient.color.setHex(preset.ambient.color);
  rig.ambient.intensity = preset.ambient.intensity;
  rig.hemi.color.setHex(preset.hemisphere.skyColor);
  rig.hemi.groundColor.setHex(preset.hemisphere.groundColor);
  rig.hemi.intensity = preset.hemisphere.intensity;
  rig.sun.color.setHex(preset.sun.color);
  rig.sun.intensity = preset.sun.intensity;
  rig.sun.position.set(
    span * preset.sun.position[0],
    span * preset.sun.position[1],
    span * preset.sun.position[2],
  );
  rig.headlight.color.setHex(preset.headlight.color);
  rig.headlight.intensity = preset.headlight.intensity;
  if (rig.terrainMaterial) {
    rig.terrainMaterial.emissive.setHex(preset.material.emissive);
    rig.terrainMaterial.emissiveIntensity = preset.material.emissiveIntensity;
    rig.terrainMaterial.needsUpdate = true;
  }
}

function renderSceneWithMarkerOverlay(
  renderer: THREE.WebGLRenderer,
  scene: THREE.Scene,
  camera: THREE.PerspectiveCamera,
  pipeline: RenderPipeline | null,
  marker: THREE.Sprite | null,
) {
  const previousLayerMask = camera.layers.mask;
  const previousAutoClear = renderer.autoClear;
  const previousBackground = scene.background;
  camera.layers.set(sceneLayer);
  if (pipeline?.composer) pipeline.composer.render();
  else renderer.render(scene, camera);

  if (marker?.visible) {
    renderer.autoClear = false;
    renderer.clearDepth();
    scene.background = null;
    camera.layers.set(markerOverlayLayer);
    renderer.render(scene, camera);
  }

  scene.background = previousBackground;
  renderer.autoClear = previousAutoClear;
  camera.layers.mask = previousLayerMask;
}

function exportRendererImage(
  renderer: THREE.WebGLRenderer,
  scene: THREE.Scene,
  camera: THREE.PerspectiveCamera,
  pipeline: RenderPipeline | null,
  marker: THREE.Sprite | null = null,
) {
  const previousSize = new THREE.Vector2();
  renderer.getSize(previousSize);
  const previousPixelRatio = renderer.getPixelRatio();
  renderer.setPixelRatio(1);
  renderer.setSize(exportWidth, exportHeight, false);
  pipeline?.composer?.setSize(exportWidth, exportHeight);
  pipeline?.fxaaPass?.setSize(exportWidth, exportHeight);
  pipeline?.ssaoPass?.setSize(exportWidth, exportHeight);
  camera.aspect = exportWidth / exportHeight;
  camera.updateProjectionMatrix();
  renderSceneWithMarkerOverlay(renderer, scene, camera, pipeline, marker);
  const dataUrl = renderer.domElement.toDataURL("image/png");
  renderer.setPixelRatio(previousPixelRatio);
  renderer.setSize(previousSize.x, previousSize.y, false);
  pipeline?.composer?.setSize(previousSize.x, previousSize.y);
  pipeline?.fxaaPass?.setSize(previousSize.x, previousSize.y);
  pipeline?.ssaoPass?.setSize(previousSize.x, previousSize.y);
  camera.aspect = previousSize.x / previousSize.y;
  camera.updateProjectionMatrix();
  renderSceneWithMarkerOverlay(renderer, scene, camera, pipeline, marker);
  window.dispatchEvent(
    new CustomEvent("trek-export-ready", {
      detail: { dataUrl },
    }),
  );
}

export function TerrainViewer({
  status,
  valley,
  routeId,
  state,
  selectedShot,
  replayPosition,
  commands,
  onCameraChange,
  onAssetsLoaded,
}: TerrainViewerProps) {
  const mountRef = useRef<HTMLDivElement | null>(null);
  const rendererRef = useRef<THREE.WebGLRenderer | null>(null);
  const pipelineRef = useRef<RenderPipeline | null>(null);
  const cameraRef = useRef<THREE.PerspectiveCamera | null>(null);
  const sceneRef = useRef<THREE.Scene | null>(null);
  const lightingRigRef = useRef<TerrainLightingRig | null>(null);
  const terrainSpanRef = useRef(1);
  const terrainMeshRef = useRef<THREE.Mesh | null>(null);
  const terrainMaterialRef = useRef<THREE.MeshPhongMaterial | null>(null);
  const terrainTextureRef = useRef<THREE.Texture | null>(null);
  const terrainReliefTextureRef = useRef<THREE.Texture | null>(null);
  const terrainForestTextureRef = useRef<THREE.Texture | null>(null);
  const routeMeshRef = useRef<THREE.Mesh | null>(null);
  const routePointsRef = useRef<THREE.Vector3[]>([]);
  const routeSamplerRef = useRef<RouteSampler | null>(null);
  const markerRef = useRef<THREE.Sprite | null>(null);
  const markerTextureRef = useRef<THREE.Texture | null>(null);
  const rigRef = useRef<CameraRig | null>(null);
  const routeFollowStateRef = useRef<RouteFollowState | null>(null);
  const previousCameraModeRef = useRef(state.cameraMode);
  // Read in the animate loop via refs so changing them doesn't rebuild the scene (which snaps the camera).
  const cameraModeRef = useRef(state.cameraMode);
  const replayPositionRef = useRef(replayPosition);
  cameraModeRef.current = state.cameraMode;
  replayPositionRef.current = replayPosition;
  const draggingRef = useRef<{ x: number; y: number } | null>(null);
  const keysRef = useRef(new Set<string>());
  const lastCameraReportRef = useRef(0);
  const commandRef = useRef(commands);
  const [assets, setAssets] = useState<LoadedAssets | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  const assetBase = valley?.assetBase ?? "";

  const selectedShotKey = useMemo(
    () => `${selectedShot?.id ?? "none"}:${selectedShot?.cameraPosition.join(",") ?? ""}:${selectedShot?.target.join(",") ?? ""}`,
    [selectedShot],
  );

  useEffect(() => {
    let cancelled = false;
    async function loadAssets() {
      if (!valley?.assetBase) {
        setAssets(null);
        onAssetsLoaded(null);
        return;
      }
      setLoadError(null);
      try {
        const manifestResponse = await fetch(`${valley.assetBase}manifest.json`);
        const manifest = (await manifestResponse.json()) as ValleyManifest;
        const routeSummary = manifest.routes.find((route) => route.id === routeId) ?? manifest.routes[0];
        if (!manifest.terrain?.data || !routeSummary?.path) {
          throw new Error("Manifest is missing terrain or route asset paths.");
        }
        const [terrainResponse, routeResponse] = await Promise.all([
          fetch(`${valley.assetBase}${manifest.terrain.data}`),
          fetch(`${valley.assetBase}${routeSummary.path}`),
        ]);
        const terrain = (await terrainResponse.json()) as TerrainAsset;
        const route = (await routeResponse.json()) as RouteAsset;
        let border: BorderAsset | null = null;
        if (manifest.overlays?.border) {
          const borderResponse = await fetch(`${valley.assetBase}${manifest.overlays.border}`);
          border = (await borderResponse.json()) as BorderAsset;
        }
        if (!cancelled) {
          const textureUrls: LoadedAssets["textureUrls"] = {};
          if (manifest.terrain.texture) textureUrls.topographic = `${valley.assetBase}${manifest.terrain.texture}`;
          if (manifest.terrain.rawTexture) textureUrls["raw-topo"] = `${valley.assetBase}${manifest.terrain.rawTexture}`;
          if (manifest.terrain.hillshadeTexture) textureUrls["lidar-shade"] = `${valley.assetBase}${manifest.terrain.hillshadeTexture}`;
          if (manifest.terrain.multiHillshadeTexture) textureUrls["multi-shade"] = `${valley.assetBase}${manifest.terrain.multiHillshadeTexture}`;
          if (manifest.terrain.slopeTexture) textureUrls.slope = `${valley.assetBase}${manifest.terrain.slopeTexture}`;
          if (manifest.terrain.hypsoTexture) textureUrls.hypsometric = `${valley.assetBase}${manifest.terrain.hypsoTexture}`;
          if (manifest.terrain.forestTexture) textureUrls.forest = `${valley.assetBase}${manifest.terrain.forestTexture}`;
          setAssets({
            manifest: { ...valley, ...manifest, assetBase: valley.assetBase },
            terrain,
            route,
            border,
            textureUrls,
          });
          onAssetsLoaded(route);
        }
      } catch (error) {
        if (!cancelled) {
          setLoadError(error instanceof Error ? error.message : "Could not load terrain assets.");
          setAssets(null);
          onAssetsLoaded(null);
        }
      }
    }
    loadAssets();
    return () => {
      cancelled = true;
    };
  }, [onAssetsLoaded, routeId, valley]);

  const reportCamera = useCallback(() => {
    const camera = cameraRef.current;
    const terrain = assets?.terrain;
    const rig = rigRef.current;
    if (!camera || !terrain || !rig) return;

    const localPosition = sceneToLocal(camera.position, terrain, state.verticalExaggeration);
    const localTarget = sceneToLocal(rig.target, terrain, state.verticalExaggeration);
    let nearest = Infinity;
    for (const point of routePointsRef.current) {
      nearest = Math.min(nearest, distance2d(camera.position, point));
    }
    const direction = rig.target.clone().sub(camera.position);
    const heading = (Math.atan2(direction.x, -direction.z) / toRad + 360) % 360;
    onCameraChange({
      position: localPosition,
      target: localTarget,
      fov: camera.fov,
      altitudeM: localPosition[2],
      distanceToRouteM: nearest,
      headingDeg: heading,
    });
  }, [assets?.terrain, onCameraChange, state.verticalExaggeration]);

  useEffect(() => {
    const mount = mountRef.current;
    if (!mount || !assets) return;

    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0xb8d5f0);
    scene.fog = new THREE.Fog(0xb8d5f0, 11000, 28000);
    const camera = new THREE.PerspectiveCamera(42, mount.clientWidth / mount.clientHeight, 1, 32000);
    const renderer = new THREE.WebGLRenderer({
      antialias: true,
      preserveDrawingBuffer: true,
      powerPreference: "high-performance",
    });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, maxDisplayPixelRatio));
    renderer.setSize(mount.clientWidth, mount.clientHeight);
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.shadowMap.enabled = false;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    renderer.toneMapping = THREE.NoToneMapping;
    renderer.toneMappingExposure = terrainLightingPresets.surface.exposure;
    mount.appendChild(renderer.domElement);

    const surfacePreset = terrainLightingPresets.surface;
    const ambient = new THREE.AmbientLight(surfacePreset.ambient.color, surfacePreset.ambient.intensity);
    scene.add(ambient);
    const hemi = new THREE.HemisphereLight(
      surfacePreset.hemisphere.skyColor,
      surfacePreset.hemisphere.groundColor,
      surfacePreset.hemisphere.intensity,
    );
    scene.add(hemi);
    const span = Math.max(assets.terrain.widthM, assets.terrain.depthM);
    terrainSpanRef.current = span;
    const sun = new THREE.DirectionalLight(surfacePreset.sun.color, surfacePreset.sun.intensity);
    sun.position.set(
      span * surfacePreset.sun.position[0],
      span * surfacePreset.sun.position[1],
      span * surfacePreset.sun.position[2],
    );
    sun.castShadow = state.quality === "high";
    sun.shadow.mapSize.set(2048, 2048);
    sun.shadow.camera.near = 1;
    sun.shadow.camera.far = 14000;
    sun.shadow.camera.left = -5000;
    sun.shadow.camera.right = 5000;
    sun.shadow.camera.top = 5000;
    sun.shadow.camera.bottom = -5000;
    scene.add(sun);
    const headlight = new THREE.PointLight(surfacePreset.headlight.color, surfacePreset.headlight.intensity, 0, 0);
    camera.add(headlight);
    scene.add(camera);

    const terrainGeometry = buildTerrainGeometry(assets.terrain, state.verticalExaggeration, state.quality);
    const selectedTextureUrl = assets.textureUrls[state.textureMode] ?? null;
    const texture = selectedTextureUrl ? new THREE.TextureLoader().load(selectedTextureUrl) : null;
    if (texture) configureColorTexture(texture, renderer, state.textureMode);
    const initialLightingPreset = getTerrainLightingPreset(state.textureMode, Boolean(texture));
    const terrainMaterial = new THREE.MeshPhongMaterial({
      map: texture ?? null,
      vertexColors: !texture,
      emissive: initialLightingPreset.material.emissive,
      emissiveIntensity: initialLightingPreset.material.emissiveIntensity,
      emissiveMap: texture ?? null,
      shininess: 0,
      specular: 0x000000,
    });
    const terrainMesh = new THREE.Mesh(terrainGeometry, terrainMaterial);
    terrainMesh.receiveShadow = false;
    terrainMesh.castShadow = false;
    scene.add(terrainMesh);
    terrainMaterialRef.current = terrainMaterial;
    terrainTextureRef.current = texture;
    lightingRigRef.current = { renderer, ambient, hemi, sun, headlight, terrainMaterial };
    applyTerrainLightingPreset(state.textureMode, Boolean(texture), span, lightingRigRef.current);

    // Drape the LiDAR hillshade over paper map layers as relief shading (lines stay from OSM).
    installTerrainReliefShader(terrainMaterial);
    const reliefUrl = assets.textureUrls["lidar-shade"] ?? null;
    const reliefTexture = reliefUrl
      ? new THREE.TextureLoader().load(reliefUrl, () => {
          terrainMaterial.needsUpdate = true;
        })
      : null;
    if (reliefTexture) configureReliefTexture(reliefTexture, renderer);
    terrainReliefTextureRef.current = reliefTexture;
    // Also drape the Copernicus forest layer, used as a subtle green canopy hint on paper layers.
    const forestUrl = assets.textureUrls.forest ?? null;
    const forestTexture = forestUrl
      ? new THREE.TextureLoader().load(forestUrl, () => {
          terrainMaterial.needsUpdate = true;
        })
      : null;
    if (forestTexture) configureColorTexture(forestTexture, renderer, state.textureMode);
    terrainForestTextureRef.current = forestTexture;
    applyTerrainReliefPreset(state.textureMode, terrainMaterial, reliefTexture, forestTexture);

    const routeObject = buildRouteObject(assets.route, assets.terrain, state.verticalExaggeration);
    routeObject.mesh.visible = state.showRoute;
    scene.add(routeObject.mesh);
    const markerTexture = createPointerTexture();
    markerTextureRef.current = markerTexture;
    const marker = new THREE.Sprite(
      new THREE.SpriteMaterial({
        map: markerTexture,
        transparent: true,
        alphaTest: 0.03,
        depthTest: false,
        depthWrite: false,
      }),
    );
    marker.scale.set(132, 132, 1);
    marker.layers.set(markerOverlayLayer);
    marker.renderOrder = 40;
    marker.visible = state.showRoute;
    scene.add(marker);
    markerRef.current = marker;
    // ponytail: border (France/Italy line) intentionally not rendered — pass null.
    const borderGroup = buildBorderGroup(null, assets.terrain, state.verticalExaggeration);
    borderGroup.visible = state.showRoute;
    scene.add(borderGroup);

    const usePostProcessing = state.quality !== "low";
    const composer = usePostProcessing ? new EffectComposer(renderer) : null;
    const fxaaPass = usePostProcessing ? new FXAAPass() : null;
    const ssaoPass =
      usePostProcessing && state.quality === "high"
        ? new SSAOPass(scene, camera, mount.clientWidth, mount.clientHeight, 32)
        : null;
    if (composer) {
      composer.addPass(new RenderPass(scene, camera));
      if (ssaoPass) {
        ssaoPass.kernelRadius = 12;
        ssaoPass.minDistance = 0.0015;
        ssaoPass.maxDistance = 0.04;
        composer.addPass(ssaoPass);
      }
      if (fxaaPass) {
        fxaaPass.setSize(mount.clientWidth, mount.clientHeight);
        composer.addPass(fxaaPass);
      }
      composer.setSize(mount.clientWidth, mount.clientHeight);
    }
    applyPostProcessingForTextureMode(state.textureMode, { composer, fxaaPass, ssaoPass });

    sceneRef.current = scene;
    cameraRef.current = camera;
    rendererRef.current = renderer;
    pipelineRef.current = { composer, fxaaPass, ssaoPass };
    terrainMeshRef.current = terrainMesh;
    routeMeshRef.current = routeObject.mesh;
    routePointsRef.current = routeObject.points;
    routeSamplerRef.current = routeObject.sampler;
    routeFollowStateRef.current = null;
    previousCameraModeRef.current = state.cameraMode;

    const initialShot = selectedShot ?? {
      cameraPosition: assets.manifest.defaultCamera.position,
      target: assets.manifest.defaultCamera.target,
      fov: assets.manifest.defaultCamera.fov ?? 42,
    };
    camera.fov = initialShot.fov ?? 42;
    camera.updateProjectionMatrix();
    const target = localToScene(initialShot.target, assets.terrain, state.verticalExaggeration);
    camera.position.copy(localToScene(initialShot.cameraPosition, assets.terrain, state.verticalExaggeration));
    camera.lookAt(target);
    rigRef.current = computeRigFromCamera(camera, target);
    applyRig(camera, rigRef.current);

    const resize = () => {
      if (!mount.clientWidth || !mount.clientHeight) return;
      camera.aspect = mount.clientWidth / mount.clientHeight;
      camera.updateProjectionMatrix();
      renderer.setSize(mount.clientWidth, mount.clientHeight);
      composer?.setSize(mount.clientWidth, mount.clientHeight);
      fxaaPass?.setSize(mount.clientWidth, mount.clientHeight);
      ssaoPass?.setSize(mount.clientWidth, mount.clientHeight);
    };
    const resizeObserver = new ResizeObserver(resize);
    resizeObserver.observe(mount);
    const exportImage = () => exportRendererImage(renderer, scene, camera, pipelineRef.current, markerRef.current);
    window.addEventListener("trek-export-image", exportImage);

    let frame = 0;
    let last = performance.now();
    const animate = (now: number) => {
      frame = requestAnimationFrame(animate);
      const dt = Math.min(0.05, (now - last) / 1000);
      last = now;
      const rig = rigRef.current;
      if (rig) {
        if (state.viewMode === "2d") {
          // ponytail: 2D map = top-down camera preset; reuses the 3D renderer. Rotate+zoom only, no pan.
          rig.phi = 0.06;
          applyRig(camera, rig);
        } else if (cameraModeRef.current === "free-camera") {
          const forward = new THREE.Vector3();
          camera.getWorldDirection(forward);
          forward.y = 0;
          forward.normalize();
          const right = new THREE.Vector3(-forward.z, 0, forward.x);
          const boost = keysRef.current.has("shift") ? 3 : 1;
          const speed = 520 * boost * dt;
          const move = new THREE.Vector3();
          if (keysRef.current.has("w")) move.add(forward);
          if (keysRef.current.has("s")) move.sub(forward);
          if (keysRef.current.has("d")) move.add(right);
          if (keysRef.current.has("a")) move.sub(right);
          if (keysRef.current.has("e")) move.y += 1;
          if (keysRef.current.has("q")) move.y -= 1;
          if (move.lengthSq() > 0) {
            move.normalize().multiplyScalar(speed);
            camera.position.add(move);
            rig.target.add(move);
            camera.lookAt(rig.target);
          }
        } else if (cameraModeRef.current === "route-follow" && routeSamplerRef.current) {
          const sampler = routeSamplerRef.current;
          const desiredDistance = clamp(replayPositionRef.current / 100, 0, 1) * sampler.totalDistanceM;
          const enteringRouteFollow = previousCameraModeRef.current !== "route-follow";
          let followState = routeFollowStateRef.current;
          const shouldReset =
            !followState ||
            enteringRouteFollow ||
            Math.abs(followState.distanceM - desiredDistance) > routeFollowConfig.scrubResetM;

          if (shouldReset) {
            const heading = routeHeadingAtDistance(sampler, desiredDistance);
            const subject = sampleRouteDistance(sampler, desiredDistance);
            const target = sampleRouteDistance(sampler, desiredDistance + routeFollowConfig.targetLookAheadM);
            target.y += routeFollowConfig.targetAltitudeM;
            const right = new THREE.Vector3(heading.z, 0, -heading.x).normalize();
            const basePosition = subject.clone().add(heading.clone().multiplyScalar(-routeFollowConfig.trailBackM));
            basePosition.y += routeFollowConfig.cameraAltitudeM;
            const sideOffsetM = sideOffsetForSightline(
              assets.terrain,
              state.verticalExaggeration,
              heading,
              basePosition,
              target,
            );
            const position = clampFollowCameraPosition(
              subject,
              basePosition.add(right.clone().multiplyScalar(sideOffsetM)),
            );
            target.add(right.multiplyScalar(sideOffsetM * routeFollowConfig.targetSideRatio));
            followState = {
              distanceM: desiredDistance,
              heading,
              position,
              target,
              sideOffsetM,
              settled: false,
            };
            routeFollowStateRef.current = followState;
            camera.position.copy(followState.position);
            rig.target.copy(followState.target);
          } else if (followState) {
            followState.distanceM += (desiredDistance - followState.distanceM) * dampingAlpha(routeFollowConfig.distanceDamping, dt);
            const heading = routeHeadingAtDistance(sampler, followState.distanceM);
            followState.heading.lerp(heading, dampingAlpha(routeFollowConfig.headingDamping, dt)).normalize();
            const subject = sampleRouteDistance(sampler, followState.distanceM);
            const desiredTarget = sampleRouteDistance(sampler, followState.distanceM + routeFollowConfig.targetLookAheadM);
            desiredTarget.y += routeFollowConfig.targetAltitudeM;
            const right = new THREE.Vector3(followState.heading.z, 0, -followState.heading.x).normalize();
            const basePosition = subject.clone().add(followState.heading.clone().multiplyScalar(-routeFollowConfig.trailBackM));
            basePosition.y += routeFollowConfig.cameraAltitudeM;
            const desiredSideOffsetM = sideOffsetForSightline(
              assets.terrain,
              state.verticalExaggeration,
              followState.heading,
              basePosition,
              desiredTarget,
            );
            followState.sideOffsetM +=
              (desiredSideOffsetM - followState.sideOffsetM) * dampingAlpha(routeFollowConfig.sideDamping, dt);
            const desiredPosition = clampFollowCameraPosition(
              subject,
              basePosition.add(right.clone().multiplyScalar(followState.sideOffsetM)),
            );
            desiredTarget.add(right.multiplyScalar(followState.sideOffsetM * routeFollowConfig.targetSideRatio));
            const settleBoost = followState.settled ? 1 : 1.9;
            followState.position.lerp(desiredPosition, dampingAlpha(routeFollowConfig.positionDamping * settleBoost, dt));
            followState.target.lerp(desiredTarget, dampingAlpha(routeFollowConfig.targetDamping * settleBoost, dt));
            if (!followState.settled && followState.position.distanceTo(desiredPosition) < 90) followState.settled = true;
            camera.position.copy(followState.position);
            rig.target.copy(followState.target);
          }

          if (Math.abs(camera.fov - routeFollowConfig.fov) > 0.01) {
            camera.fov += (routeFollowConfig.fov - camera.fov) * dampingAlpha(routeFollowConfig.fovDamping, dt);
            camera.updateProjectionMatrix();
          }
          camera.lookAt(rig.target);
          rigRef.current = computeRigFromCamera(camera, rig.target);
        } else {
          applyRig(camera, rig);
        }
      }
      const marker = markerRef.current;
      const sampler = routeSamplerRef.current;
      if (marker && sampler) {
        const desiredMarkerDistance = clamp(replayPositionRef.current / 100, 0, 1) * sampler.totalDistanceM;
        const markerDistance =
          cameraModeRef.current === "route-follow"
            ? routeFollowStateRef.current?.distanceM ?? desiredMarkerDistance
            : desiredMarkerDistance;
        sampleRouteDistance(sampler, markerDistance, marker.position);
        marker.position.y += 48;
        const pulse = (Math.sin(now * 0.0042) + 1) * 0.5;
        const markerSize = 118 + pulse * 18;
        marker.scale.set(markerSize, markerSize, 1);
        (marker.material as THREE.SpriteMaterial).opacity = 0.9 + pulse * 0.1;
      }
      previousCameraModeRef.current = cameraModeRef.current;
      renderSceneWithMarkerOverlay(renderer, scene, camera, { composer, fxaaPass, ssaoPass }, markerRef.current);
      if (now - lastCameraReportRef.current > 220) {
        lastCameraReportRef.current = now;
        reportCamera();
      }
    };
    frame = requestAnimationFrame(animate);

    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener("trek-export-image", exportImage);
      resizeObserver.disconnect();
      mount.removeChild(renderer.domElement);
      terrainGeometry.dispose();
      terrainMaterial.dispose();
      routeObject.mesh.geometry.dispose();
      (routeObject.mesh.material as THREE.Material).dispose();
      (marker.material as THREE.Material).dispose();
      markerTexture.dispose();
      markerRef.current = null;
      markerTextureRef.current = null;
      borderGroup.traverse((object) => {
        if (object instanceof THREE.Mesh) {
          object.geometry.dispose();
          (object.material as THREE.Material).dispose();
        }
      });
      terrainTextureRef.current?.dispose();
      terrainReliefTextureRef.current?.dispose();
      terrainForestTextureRef.current?.dispose();
      composer?.dispose();
      ssaoPass?.dispose();
      renderer.dispose();
      sceneRef.current = null;
      cameraRef.current = null;
      rendererRef.current = null;
      pipelineRef.current = null;
      lightingRigRef.current = null;
      terrainSpanRef.current = 1;
      terrainMeshRef.current = null;
      terrainMaterialRef.current = null;
      terrainTextureRef.current = null;
      terrainReliefTextureRef.current = null;
      terrainForestTextureRef.current = null;
      routeMeshRef.current = null;
      routePointsRef.current = [];
      routeSamplerRef.current = null;
      rigRef.current = null;
      routeFollowStateRef.current = null;
    };
  }, [assets, reportCamera, selectedShotKey, state.quality, state.showRoute, state.verticalExaggeration, state.viewMode]);

  useEffect(() => {
    if (!assets || !terrainMaterialRef.current) return;
    const material = terrainMaterialRef.current;
    const selectedTextureUrl = assets.textureUrls[state.textureMode] ?? null;
    const previousTexture = terrainTextureRef.current;
    if (!selectedTextureUrl) {
      material.map = null;
      material.emissiveMap = null;
      material.vertexColors = true;
      applyTerrainLightingPreset(state.textureMode, false, terrainSpanRef.current, lightingRigRef.current);
      applyPostProcessingForTextureMode(state.textureMode, pipelineRef.current);
      applyTerrainReliefPreset(state.textureMode, material, terrainReliefTextureRef.current, terrainForestTextureRef.current);
      previousTexture?.dispose();
      terrainTextureRef.current = null;
      return;
    }
    // Swap the texture only once it has loaded — assigning an unloaded texture renders black.
    let cancelled = false;
    const nextTexture = new THREE.TextureLoader().load(selectedTextureUrl, () => {
      if (cancelled) {
        nextTexture.dispose();
        return;
      }
      configureColorTexture(nextTexture, rendererRef.current, state.textureMode);
      material.map = nextTexture;
      material.emissiveMap = nextTexture;
      material.vertexColors = false;
      applyTerrainLightingPreset(state.textureMode, true, terrainSpanRef.current, lightingRigRef.current);
      applyPostProcessingForTextureMode(state.textureMode, pipelineRef.current);
      applyTerrainReliefPreset(state.textureMode, material, terrainReliefTextureRef.current, terrainForestTextureRef.current);
      material.needsUpdate = true;
      terrainTextureRef.current = nextTexture;
      previousTexture?.dispose();
    });
    return () => {
      cancelled = true;
    };
  }, [assets, state.textureMode]);

  useEffect(() => {
    const routeMesh = routeMeshRef.current;
    if (routeMesh) routeMesh.visible = state.showRoute;
    if (markerRef.current) markerRef.current.visible = state.showRoute;
  }, [state.showRoute]);

  // Re-derive the orbit rig from the current camera when the mode changes, so switching
  // (e.g. out of free-camera) keeps the camera exactly where it is instead of snapping.
  useEffect(() => {
    const camera = cameraRef.current;
    const rig = rigRef.current;
    if (camera && rig) rigRef.current = computeRigFromCamera(camera, rig.target);
  }, [state.cameraMode]);

  // Slope layer is red/orange — switch the route to blue so it stays legible.
  useEffect(() => {
    const routeMesh = routeMeshRef.current;
    if (!routeMesh) return;
    (routeMesh.material as THREE.MeshBasicMaterial).color.set(
      state.textureMode === "slope" ? 0x2f9bff : 0xd33b22,
    );
  }, [assets, state.textureMode]);

  useEffect(() => {
    if (!assets || !selectedShot || !cameraRef.current) return;
    const camera = cameraRef.current;
    camera.fov = selectedShot.fov;
    camera.updateProjectionMatrix();
    const target = localToScene(selectedShot.target, assets.terrain, state.verticalExaggeration);
    camera.position.copy(localToScene(selectedShot.cameraPosition, assets.terrain, state.verticalExaggeration));
    camera.lookAt(target);
    rigRef.current = computeRigFromCamera(camera, target);
    reportCamera();
  }, [assets, reportCamera, selectedShot, selectedShotKey, state.verticalExaggeration]);

  useEffect(() => {
    if (!assets || !cameraRef.current) return;
    const camera = cameraRef.current;
    if (commands.frameRoute !== commandRef.current.frameRoute) {
      const routePoints = routePointsRef.current;
      const center = routePoints.reduce((acc, point) => acc.add(point), new THREE.Vector3()).multiplyScalar(1 / Math.max(routePoints.length, 1));
      const radius = Math.max(assets.terrain.widthM, assets.terrain.depthM) * 0.78;
      rigRef.current = {
        target: center,
        radius,
        theta: -0.68,
        phi: 0.9,
      };
      applyRig(camera, rigRef.current);
      reportCamera();
    }
    if (commands.reset !== commandRef.current.reset && selectedShot) {
      const target = localToScene(selectedShot.target, assets.terrain, state.verticalExaggeration);
      camera.position.copy(localToScene(selectedShot.cameraPosition, assets.terrain, state.verticalExaggeration));
      camera.fov = selectedShot.fov;
      camera.updateProjectionMatrix();
      rigRef.current = computeRigFromCamera(camera, target);
      applyRig(camera, rigRef.current);
      reportCamera();
    }
    if (commands.exportImage !== commandRef.current.exportImage && rendererRef.current) {
      const scene = sceneRef.current;
      const camera = cameraRef.current;
      if (scene && camera) exportRendererImage(rendererRef.current, scene, camera, pipelineRef.current, markerRef.current);
    }
    commandRef.current = commands;
  }, [assets, commands, reportCamera, selectedShot, state.verticalExaggeration]);

  useEffect(() => {
    const mount = mountRef.current;
    if (!mount) return;

    const onPointerDown = (event: PointerEvent) => {
      mount.setPointerCapture(event.pointerId);
      draggingRef.current = { x: event.clientX, y: event.clientY };
    };
    const onPointerMove = (event: PointerEvent) => {
      const drag = draggingRef.current;
      const rig = rigRef.current;
      const camera = cameraRef.current;
      if (!drag || !rig || !camera) return;
      const dx = event.clientX - drag.x;
      const dy = event.clientY - drag.y;
      draggingRef.current = { x: event.clientX, y: event.clientY };
      if (state.viewMode === "2d") {
        rig.theta -= dx * 0.006; // ponytail: 2D locks tilt, drag only rotates heading
      } else if (state.cameraMode === "free-camera") {
        rig.theta -= dx * 0.004;
        rig.phi = clamp(rig.phi + dy * 0.003, 0.16, 1.42);
      } else {
        rig.theta -= dx * 0.006;
        rig.phi = clamp(rig.phi + dy * 0.004, 0.22, 1.42);
      }
      applyRig(camera, rig);
      reportCamera();
    };
    const onPointerUp = (event: PointerEvent) => {
      draggingRef.current = null;
      if (mount.hasPointerCapture(event.pointerId)) mount.releasePointerCapture(event.pointerId);
    };
    const onWheel = (event: WheelEvent) => {
      const rig = rigRef.current;
      const camera = cameraRef.current;
      if (!rig || !camera) return;
      event.preventDefault();
      rig.radius = clamp(rig.radius * (1 + event.deltaY * 0.001), 260, 9000);
      applyRig(camera, rig);
      reportCamera();
    };
    const onKeyDown = (event: KeyboardEvent) => keysRef.current.add(event.key.toLowerCase());
    const onKeyUp = (event: KeyboardEvent) => keysRef.current.delete(event.key.toLowerCase());

    mount.addEventListener("pointerdown", onPointerDown);
    mount.addEventListener("pointermove", onPointerMove);
    mount.addEventListener("pointerup", onPointerUp);
    mount.addEventListener("wheel", onWheel, { passive: false });
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);
    return () => {
      mount.removeEventListener("pointerdown", onPointerDown);
      mount.removeEventListener("pointermove", onPointerMove);
      mount.removeEventListener("pointerup", onPointerUp);
      mount.removeEventListener("wheel", onWheel);
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
    };
  }, [reportCamera, state.cameraMode, state.viewMode]);

  const hasOverlay = status !== "ready" || !assets || loadError;

  return (
    <section className={classForStatus(status)} aria-label="Interactive LiDAR terrain viewer">
      <div ref={mountRef} className="three-mount" />
      {hasOverlay ? (
        <div className="status-overlay glass-panel">
          {loadError ? <Map size={28} /> : status === "loading" || !assets ? <Loader2 className="spin" size={28} /> : <Mountain size={28} />}
          <h2>{loadError ? "Terrain assets unavailable" : status === "ready" ? "Loading Escursione assets" : status}</h2>
          <p>{loadError ?? "The web viewer is loading the exported LiDAR heightfield and GPX route."}</p>
        </div>
      ) : null}
    </section>
  );
}
