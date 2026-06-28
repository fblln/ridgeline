/**
 * Internal viewer contracts shared by the React orchestration layer and the
 * Three.js helper modules. These types describe runtime scene state, not the
 * generated asset JSON schema.
 */
import type * as THREE from "three";
import type { EffectComposer } from "three/examples/jsm/postprocessing/EffectComposer.js";
import type { FXAAPass } from "three/examples/jsm/postprocessing/FXAAPass.js";
import type { SSAOPass } from "three/examples/jsm/postprocessing/SSAOPass.js";
import type {
  AppStatus,
  BorderAsset,
  CameraSnapshot,
  RouteAsset,
  SavedShot,
  TerrainAsset,
  ValleyManifest,
  ViewerState,
} from "../types";

export type ViewerCommand = {
  frameRoute: number;
  reset: number;
  exportImage: number;
};

export type TerrainViewerProps = {
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

export type LoadedAssets = {
  manifest: ValleyManifest;
  terrain: TerrainAsset;
  route: RouteAsset;
  border: BorderAsset | null;
  textureUrls: Partial<Record<ViewerState["textureMode"], string>>;
};

export type RenderPipeline = {
  composer: EffectComposer | null;
  fxaaPass: FXAAPass | null;
  ssaoPass: SSAOPass | null;
};

export type RouteSampler = {
  points: THREE.Vector3[];
  distances: number[];
  totalDistanceM: number;
};

export type RouteFollowState = {
  distanceM: number;
  heading: THREE.Vector3;
  position: THREE.Vector3;
  target: THREE.Vector3;
  sideOffsetM: number;
  settled: boolean;
};

export type CameraRig = {
  target: THREE.Vector3;
  radius: number;
  theta: number;
  phi: number;
};

export type TerrainLightingPreset = {
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

export type TerrainLightingRig = {
  renderer: THREE.WebGLRenderer;
  ambient: THREE.AmbientLight;
  hemi: THREE.HemisphereLight;
  sun: THREE.DirectionalLight;
  headlight: THREE.PointLight;
  terrainMaterial?: THREE.MeshPhongMaterial | null;
};
