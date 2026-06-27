import { Focus, Loader2, Map, Mountain } from "lucide-react";
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

type CameraRig = {
  target: THREE.Vector3;
  radius: number;
  theta: number;
  phi: number;
};

const toRad = Math.PI / 180;
const maxDisplayPixelRatio = 3;
const exportWidth = 7200;
const exportHeight = 5400;

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

  for (let r = 0; r < rows; r += 1) {
    const sourceR = Math.min(n - 1, r * skip);
    const z = terrain.depthM / 2 - (sourceR / (n - 1)) * terrain.depthM;
    for (let c = 0; c < cols; c += 1) {
      const sourceC = Math.min(n - 1, c * skip);
      const x = (sourceC / (n - 1)) * terrain.widthM - terrain.widthM / 2;
      const h = terrain.heights[sourceR * n + sourceC];
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
        (point.z - terrain.minHeightM) * verticalExaggeration + 28,
        terrain.depthM / 2 - point.y,
      ),
  );
  const curve = new THREE.CatmullRomCurve3(points, false, "centripetal", 0.3);
  const geometry = new THREE.TubeGeometry(curve, Math.min(1600, points.length * 2), 18, 10, false);
  const material = new THREE.MeshBasicMaterial({ color: 0xff4d3d });
  return {
    mesh: new THREE.Mesh(geometry, material),
    points,
  };
}

function buildBorderGroup(border: BorderAsset | null, terrain: TerrainAsset, verticalExaggeration: number) {
  const group = new THREE.Group();
  if (!border) return group;
  const material = new THREE.MeshBasicMaterial({ color: border.color || 0x1f6bff });
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

function isAnalysisTexture(textureMode: ViewerState["textureMode"]) {
  return textureMode === "slope" || textureMode === "hypsometric" || textureMode === "lidar-shade" || textureMode === "multi-shade";
}

function exportRendererImage(
  renderer: THREE.WebGLRenderer,
  scene: THREE.Scene,
  camera: THREE.PerspectiveCamera,
  pipeline: RenderPipeline | null,
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
  if (pipeline?.composer) pipeline.composer.render();
  else renderer.render(scene, camera);
  const dataUrl = renderer.domElement.toDataURL("image/png");
  renderer.setPixelRatio(previousPixelRatio);
  renderer.setSize(previousSize.x, previousSize.y, false);
  pipeline?.composer?.setSize(previousSize.x, previousSize.y);
  pipeline?.fxaaPass?.setSize(previousSize.x, previousSize.y);
  pipeline?.ssaoPass?.setSize(previousSize.x, previousSize.y);
  camera.aspect = previousSize.x / previousSize.y;
  camera.updateProjectionMatrix();
  if (pipeline?.composer) pipeline.composer.render();
  else renderer.render(scene, camera);
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
  const terrainMeshRef = useRef<THREE.Mesh | null>(null);
  const terrainMaterialRef = useRef<THREE.MeshLambertMaterial | null>(null);
  const terrainTextureRef = useRef<THREE.Texture | null>(null);
  const routeMeshRef = useRef<THREE.Mesh | null>(null);
  const routePointsRef = useRef<THREE.Vector3[]>([]);
  const rigRef = useRef<CameraRig | null>(null);
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
    scene.background = new THREE.Color(0x8eb1d8);
    scene.fog = new THREE.Fog(0x8eb1d8, 6800, 14500);
    const camera = new THREE.PerspectiveCamera(42, mount.clientWidth / mount.clientHeight, 1, 18000);
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
    renderer.toneMappingExposure = 1.0;
    mount.appendChild(renderer.domElement);

    const ambient = new THREE.AmbientLight(0xffffff, 0.36);
    scene.add(ambient);
    const hemi = new THREE.HemisphereLight(0xffffff, 0x91a0a8, 0.58);
    scene.add(hemi);
    const span = Math.max(assets.terrain.widthM, assets.terrain.depthM);
    const sun = new THREE.DirectionalLight(0xffffff, 0.82);
    sun.position.set(
      -assets.terrain.widthM / 2 - span,
      (assets.terrain.maxHeightM - assets.terrain.minHeightM) * state.verticalExaggeration * 3,
      -assets.terrain.depthM / 2 - span,
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
    const headlight = new THREE.PointLight(0xffffff, 0.2, 0, 0);
    camera.add(headlight);
    scene.add(camera);

    const terrainGeometry = buildTerrainGeometry(assets.terrain, state.verticalExaggeration, state.quality);
    const selectedTextureUrl = assets.textureUrls[state.textureMode] ?? null;
    const texture = selectedTextureUrl ? new THREE.TextureLoader().load(selectedTextureUrl) : null;
    if (texture) {
      texture.colorSpace = THREE.SRGBColorSpace;
      texture.flipY = false;
      texture.anisotropy = renderer.capabilities.getMaxAnisotropy();
      texture.minFilter = THREE.LinearMipmapLinearFilter;
      texture.magFilter = THREE.LinearFilter;
      texture.wrapS = THREE.ClampToEdgeWrapping;
      texture.wrapT = THREE.ClampToEdgeWrapping;
    }
    const terrainMaterial = new THREE.MeshLambertMaterial({
      map: texture ?? null,
      vertexColors: !texture,
      emissive: texture ? 0xffffff : 0x181818,
      emissiveIntensity: texture ? (isAnalysisTexture(state.textureMode) ? 0.62 : 0.22) : 0.03,
      emissiveMap: texture ?? null,
    });
    const terrainMesh = new THREE.Mesh(terrainGeometry, terrainMaterial);
    terrainMesh.receiveShadow = false;
    terrainMesh.castShadow = false;
    scene.add(terrainMesh);
    terrainMaterialRef.current = terrainMaterial;
    terrainTextureRef.current = texture;

    const routeObject = buildRouteObject(assets.route, assets.terrain, state.verticalExaggeration);
    routeObject.mesh.visible = state.showRoute;
    scene.add(routeObject.mesh);
    const borderGroup = buildBorderGroup(assets.border, assets.terrain, state.verticalExaggeration);
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

    sceneRef.current = scene;
    cameraRef.current = camera;
    rendererRef.current = renderer;
    pipelineRef.current = { composer, fxaaPass, ssaoPass };
    terrainMeshRef.current = terrainMesh;
    routeMeshRef.current = routeObject.mesh;
    routePointsRef.current = routeObject.points;

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
    const exportImage = () => exportRendererImage(renderer, scene, camera, pipelineRef.current);
    window.addEventListener("trek-export-image", exportImage);

    let frame = 0;
    let last = performance.now();
    const animate = (now: number) => {
      frame = requestAnimationFrame(animate);
      const dt = Math.min(0.05, (now - last) / 1000);
      last = now;
      const rig = rigRef.current;
      if (rig) {
        if (state.cameraMode === "free-camera") {
          const forward = new THREE.Vector3();
          camera.getWorldDirection(forward);
          forward.y = 0;
          forward.normalize();
          const right = new THREE.Vector3(-forward.z, 0, forward.x);
          const speed = 520 * dt;
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
        } else if (state.cameraMode === "route-follow" && routePointsRef.current.length > 2) {
          const routePoints = routePointsRef.current;
          const i = Math.floor(clamp(replayPosition / 100, 0, 1) * (routePoints.length - 2));
          const current = routePoints[i];
          const next = routePoints[Math.min(routePoints.length - 1, i + 8)];
          const back = current.clone().sub(next).normalize();
          const routeTarget = next.clone();
          const routeCamera = current.clone().add(back.multiplyScalar(520));
          routeCamera.y += 420;
          camera.position.lerp(routeCamera, 0.08);
          rig.target.lerp(routeTarget, 0.08);
          camera.lookAt(rig.target);
          rigRef.current = computeRigFromCamera(camera, rig.target);
        } else {
          applyRig(camera, rig);
        }
      }
      if (composer) composer.render();
      else renderer.render(scene, camera);
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
      borderGroup.traverse((object) => {
        if (object instanceof THREE.Mesh) {
          object.geometry.dispose();
          (object.material as THREE.Material).dispose();
        }
      });
      terrainTextureRef.current?.dispose();
      composer?.dispose();
      ssaoPass?.dispose();
      renderer.dispose();
      sceneRef.current = null;
      cameraRef.current = null;
      rendererRef.current = null;
      pipelineRef.current = null;
      terrainMeshRef.current = null;
      terrainMaterialRef.current = null;
      terrainTextureRef.current = null;
      routeMeshRef.current = null;
      routePointsRef.current = [];
      rigRef.current = null;
    };
  }, [assets, reportCamera, selectedShotKey, state.cameraMode, state.quality, state.showRoute, state.verticalExaggeration]);

  useEffect(() => {
    if (!assets || !terrainMaterialRef.current) return;
    const material = terrainMaterialRef.current;
    const selectedTextureUrl = assets.textureUrls[state.textureMode] ?? null;
    const previousTexture = terrainTextureRef.current;
    if (!selectedTextureUrl) {
      material.map = null;
      material.emissiveMap = null;
      material.emissive.set(0x181818);
      material.emissiveIntensity = 0.03;
      material.vertexColors = true;
      material.needsUpdate = true;
      previousTexture?.dispose();
      terrainTextureRef.current = null;
      return;
    }
    const nextTexture = new THREE.TextureLoader().load(selectedTextureUrl, () => {
      material.needsUpdate = true;
    });
    nextTexture.colorSpace = THREE.SRGBColorSpace;
    nextTexture.flipY = false;
    nextTexture.anisotropy = rendererRef.current?.capabilities.getMaxAnisotropy() ?? 1;
    nextTexture.minFilter = THREE.LinearMipmapLinearFilter;
    nextTexture.magFilter = THREE.LinearFilter;
    nextTexture.wrapS = THREE.ClampToEdgeWrapping;
    nextTexture.wrapT = THREE.ClampToEdgeWrapping;
    material.map = nextTexture;
    material.emissiveMap = nextTexture;
    material.emissive.set(0xffffff);
    material.emissiveIntensity = isAnalysisTexture(state.textureMode) ? 0.62 : 0.22;
    material.vertexColors = false;
    material.needsUpdate = true;
    terrainTextureRef.current = nextTexture;
    previousTexture?.dispose();
  }, [assets, state.textureMode]);

  useEffect(() => {
    const routeMesh = routeMeshRef.current;
    if (routeMesh) routeMesh.visible = state.showRoute;
  }, [state.showRoute]);

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
      if (scene && camera) exportRendererImage(rendererRef.current, scene, camera, pipelineRef.current);
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
      if (state.cameraMode === "free-camera") {
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
  }, [reportCamera, state.cameraMode]);

  const referencePreview = assets?.manifest.reference?.preview
    ? `${assetBase}${assets.manifest.reference.preview}`
    : null;
  const hasOverlay = status !== "ready" || !assets || loadError;

  return (
    <section className={classForStatus(status)} aria-label="Interactive LiDAR terrain viewer">
      <div ref={mountRef} className="three-mount" />
      {state.textureMode === "topographic" && referencePreview ? (
        <div className="reference-strip glass-panel">
          <img src={referencePreview} alt="Generated reference render" />
          <div>
            <span>Reference render</span>
            <strong>Escursione_mattutina-final.png</strong>
          </div>
        </div>
      ) : null}
      <div className="camera-reticle">
        <Focus size={28} />
        <span>{state.cameraMode === "free-camera" ? "Drag to look · WASD/QE to move" : "Drag to orbit · wheel to zoom"}</span>
      </div>
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
