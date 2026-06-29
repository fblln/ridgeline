import { Loader2, Map as MapIcon, Mountain } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import * as THREE from "three";
import { EffectComposer } from "three/examples/jsm/postprocessing/EffectComposer.js";
import { FXAAPass } from "three/examples/jsm/postprocessing/FXAAPass.js";
import { RenderPass } from "three/examples/jsm/postprocessing/RenderPass.js";
import { SSAOPass } from "three/examples/jsm/postprocessing/SSAOPass.js";
import type { BorderAsset, RouteAsset, TerrainAsset, ValleyManifest } from "./types";
import {
  markerOverlayLayer,
  maxDisplayPixelRatio,
  routeFollowConfig,
  terrainLightingPresets,
  toRad,
} from "./viewer/constants";
import {
  applyRig,
  clamp,
  classForStatus,
  computeRigFromCamera,
  dampingAlpha,
  distance2d,
  localToScene,
  sceneToLocal,
} from "./viewer/coordinates";
import { buildBorderGroup, buildRouteObject, buildTerrainGeometry, createPointerTexture } from "./viewer/geometry";
import {
  applyPostProcessingForTextureMode,
  applyTerrainLightingPreset,
  applyTerrainReliefPreset,
  configureColorTexture,
  configureReliefTexture,
  getTerrainLightingPreset,
  installTerrainReliefShader,
} from "./viewer/materials";
import { exportRendererImage, renderSceneWithMarkerOverlay } from "./viewer/rendering";
import {
  clampFollowCameraPosition,
  routeHeadingAtDistance,
  sampleRouteDistance,
  sideOffsetForSightline,
} from "./viewer/routeFollow";
import type {
  CameraRig,
  LoadedAssets,
  RenderPipeline,
  RouteFollowState,
  RouteSampler,
  TerrainLightingRig,
  TerrainViewerProps,
} from "./viewer/types";

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

  const _assetBase = valley?.assetBase ?? "";

  const selectedShotKey = useMemo(
    () =>
      `${selectedShot?.id ?? "none"}:${selectedShot?.cameraPosition.join(",") ?? ""}:${selectedShot?.target.join(",") ?? ""}`,
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
          if (manifest.terrain.rawTexture)
            textureUrls["raw-topo"] = `${valley.assetBase}${manifest.terrain.rawTexture}`;
          if (manifest.terrain.hillshadeTexture)
            textureUrls["lidar-shade"] = `${valley.assetBase}${manifest.terrain.hillshadeTexture}`;
          if (manifest.terrain.multiHillshadeTexture)
            textureUrls["multi-shade"] = `${valley.assetBase}${manifest.terrain.multiHillshadeTexture}`;
          if (manifest.terrain.slopeTexture) textureUrls.slope = `${valley.assetBase}${manifest.terrain.slopeTexture}`;
          if (manifest.terrain.hypsoTexture)
            textureUrls.hypsometric = `${valley.assetBase}${manifest.terrain.hypsoTexture}`;
          if (manifest.terrain.forestTexture)
            textureUrls.forest = `${valley.assetBase}${manifest.terrain.forestTexture}`;
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
    // border (France/Italy line) intentionally not rendered — pass null.
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
          // 2D map = top-down camera preset; reuses the 3D renderer. Rotate+zoom only, no pan.
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
            followState.distanceM +=
              (desiredDistance - followState.distanceM) * dampingAlpha(routeFollowConfig.distanceDamping, dt);
            const heading = routeHeadingAtDistance(sampler, followState.distanceM);
            followState.heading.lerp(heading, dampingAlpha(routeFollowConfig.headingDamping, dt)).normalize();
            const subject = sampleRouteDistance(sampler, followState.distanceM);
            const desiredTarget = sampleRouteDistance(
              sampler,
              followState.distanceM + routeFollowConfig.targetLookAheadM,
            );
            desiredTarget.y += routeFollowConfig.targetAltitudeM;
            const right = new THREE.Vector3(followState.heading.z, 0, -followState.heading.x).normalize();
            const basePosition = subject
              .clone()
              .add(followState.heading.clone().multiplyScalar(-routeFollowConfig.trailBackM));
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
            followState.position.lerp(
              desiredPosition,
              dampingAlpha(routeFollowConfig.positionDamping * settleBoost, dt),
            );
            followState.target.lerp(desiredTarget, dampingAlpha(routeFollowConfig.targetDamping * settleBoost, dt));
            if (!followState.settled && followState.position.distanceTo(desiredPosition) < 90)
              followState.settled = true;
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
            ? (routeFollowStateRef.current?.distanceM ?? desiredMarkerDistance)
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
  }, [
    assets,
    reportCamera,
    selectedShotKey,
    state.quality,
    state.showRoute,
    state.verticalExaggeration,
    state.viewMode,
  ]);

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
      applyTerrainReliefPreset(
        state.textureMode,
        material,
        terrainReliefTextureRef.current,
        terrainForestTextureRef.current,
      );
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
      applyTerrainReliefPreset(
        state.textureMode,
        material,
        terrainReliefTextureRef.current,
        terrainForestTextureRef.current,
      );
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
    (routeMesh.material as THREE.MeshBasicMaterial).color.set(state.textureMode === "slope" ? 0x2f9bff : 0xd33b22);
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
      const center = routePoints
        .reduce((acc, point) => acc.add(point), new THREE.Vector3())
        .multiplyScalar(1 / Math.max(routePoints.length, 1));
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
      if (scene && camera)
        exportRendererImage(rendererRef.current, scene, camera, pipelineRef.current, markerRef.current);
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
        rig.theta -= dx * 0.006; // 2D locks tilt, drag only rotates heading
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
          {loadError ? (
            <MapIcon size={28} />
          ) : status === "loading" || !assets ? (
            <Loader2 className="spin" size={28} />
          ) : (
            <Mountain size={28} />
          )}
          <h2>
            {loadError ? "Terrain assets unavailable" : status === "ready" ? "Loading Escursione assets" : status}
          </h2>
          <p>{loadError ?? "The web viewer is loading the exported LiDAR heightfield and GPX route."}</p>
        </div>
      ) : null}
    </section>
  );
}
