export type CameraMode = "orbit" | "free-camera" | "route-follow";

export type Quality = "low" | "balanced" | "high";

export type TextureMode =
  | "topographic"
  | "raw-topo"
  | "lidar-shade"
  | "multi-shade"
  | "slope"
  | "hypsometric"
  | "surface";

export type AppStatus = "ready" | "loading" | "empty" | "error" | "unsupported";

export type RouteSummary = {
  id: string;
  name: string;
  distanceKm: number;
  elevationGainM: number;
  pointCount?: number;
  path?: string;
};

export type ValleyManifest = {
  id: string;
  name: string;
  bounds: [number, number, number, number];
  assetBase?: string;
  reference?: {
    render: string;
    preview: string;
    angles?: string | null;
  };
  terrain?: {
    data: string;
    heightmap: string;
    texture?: string;
    rawTexture?: string;
    textureZoom?: number;
    hillshadeTexture?: string;
    multiHillshadeTexture?: string;
    slopeTexture?: string;
    hypsoTexture?: string;
    normalTexture?: string;
    demSource?: string;
    demSourceLabel?: string;
    piemonteSampleOrder?: number;
    sourceResolutionM?: number;
    ignFillResolutionM?: number;
    meshSmoothingSigma?: number;
    reliefSmoothingSigma?: number;
    slopeSmoothingSigma?: number;
    routeSampleStepM?: number;
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
  routes: RouteSummary[];
  qualityPresets: Quality[];
  attribution?: string[];
  overlays?: {
    border?: string | null;
  };
};

export type SavedShot = {
  id: string;
  name: string;
  cameraPosition: [number, number, number];
  target: [number, number, number];
  fov: number;
  verticalExaggeration: number;
  textureMode: TextureMode;
  showRoute: boolean;
};

export type ViewerState = {
  valleyId: string | null;
  routeId: string | null;
  cameraMode: CameraMode;
  quality: Quality;
  textureMode: TextureMode;
  verticalExaggeration: number;
  showRoute: boolean;
  selectedShotId: string | null;
};

export type RoutePoint = {
  x: number;
  y: number;
  z: number;
  d: number;
  lat: number;
  lon: number;
};

export type RouteAsset = {
  id: string;
  name: string;
  source: string;
  pointCount: number;
  displayPointCount: number;
  distanceKm: number;
  elevationGainM: number;
  minElevationM: number;
  maxElevationM: number;
  points: RoutePoint[];
};

export type TerrainAsset = {
  gridSize: number;
  widthM: number;
  depthM: number;
  minHeightM: number;
  maxHeightM: number;
  heights: number[];
};

export type BorderAsset = {
  id: string;
  name: string;
  color: string;
  lines: Array<Array<{ x: number; y: number; z: number }>>;
};

export type CameraSnapshot = {
  position: [number, number, number];
  target: [number, number, number];
  fov: number;
  altitudeM: number;
  distanceToRouteM: number;
  headingDeg: number;
};
