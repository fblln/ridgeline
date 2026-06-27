import {
  Aperture,
  BadgeAlert,
  Camera,
  CircleDot,
  CloudOff,
  Copy,
  Download,
  Eye,
  EyeOff,
  Film,
  Focus,
  GalleryHorizontal,
  ImageDown,
  Loader2,
  Map,
  Mountain,
  Orbit,
  Pause,
  Play,
  Plus,
  RotateCcw,
  Route,
  Share2,
  SlidersHorizontal,
  Sparkles,
  Wand2,
  X,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { initialShots, valleys } from "./mockData";
import { TerrainViewer } from "./TerrainViewer";
import type {
  AppStatus,
  CameraMode,
  CameraSnapshot,
  Quality,
  RouteAsset,
  SavedShot,
  TextureMode,
  ViewerState,
} from "./types";

const cameraLabels: Record<CameraMode, string> = {
  orbit: "Orbit",
  "free-camera": "Free camera",
  "route-follow": "Route follow",
};

const textureLabels: Record<TextureMode, string> = {
  topographic: "Reference topo",
  "raw-topo": "Raw topo",
  "lidar-shade": "LiDAR shade",
  "multi-shade": "Multi shade",
  slope: "Slope angle",
  hypsometric: "Hypsometric",
  surface: "Surface",
};

const statusCopy: Record<AppStatus, { title: string; body: string }> = {
  ready: {
    title: "",
    body: "",
  },
  loading: {
    title: "Preparing valley assets",
    body: "Terrain tiles, route overlays, and saved camera views will stream into this viewport.",
  },
  empty: {
    title: "No valley selected",
    body: "Choose a valley and route to begin framing the trek.",
  },
  error: {
    title: "Valley assets unavailable",
    body: "The viewer shell is ready, but this mock state represents a failed asset load.",
  },
  unsupported: {
    title: "3D rendering unavailable",
    body: "This fallback state will appear when browser graphics support is not sufficient.",
  },
};

function formatVector(value: [number, number, number]) {
  return value.map((part) => Math.round(part)).join(", ");
}

export function App() {
  const [currentCamera, setCurrentCamera] = useState<CameraSnapshot>({
    position: [3293, -3364, 3828],
    target: [3114, 2499, 2150],
    fov: 42,
    altitudeM: 3828,
    distanceToRouteM: 0,
    headingDeg: 0,
  });
  const [viewerState, setViewerState] = useState<ViewerState>({
    valleyId: valleys[0].id,
    routeId: valleys[0].routes[0].id,
    cameraMode: "orbit",
    quality: "high",
    textureMode: "topographic",
    verticalExaggeration: 2.5,
    showRoute: true,
    selectedShotId: initialShots[0].id,
  });
  const [shots, setShots] = useState<SavedShot[]>(initialShots);
  const [status, setStatus] = useState<AppStatus>("ready");
  const [replayPosition, setReplayPosition] = useState(18);
  const [isReplayPreviewing, setIsReplayPreviewing] = useState(false);
  const [loadedRoute, setLoadedRoute] = useState<RouteAsset | null>(null);
  const [exportImageUrl, setExportImageUrl] = useState<string | null>(null);
  const [commands, setCommands] = useState({
    frameRoute: 0,
    reset: 0,
    exportImage: 0,
  });

  const activeValley = useMemo(
    () => valleys.find((valley) => valley.id === viewerState.valleyId) ?? null,
    [viewerState.valleyId],
  );

  const activeRoute = useMemo(
    () =>
      activeValley?.routes.find((route) => route.id === viewerState.routeId) ??
      null,
    [activeValley, viewerState.routeId],
  );

  const selectedShot = useMemo(
    () => shots.find((shot) => shot.id === viewerState.selectedShotId) ?? null,
    [shots, viewerState.selectedShotId],
  );

  const setMode = (cameraMode: CameraMode) => {
    setViewerState((state) => ({ ...state, cameraMode }));
  };

  const addShot = () => {
    const nextShot: SavedShot = {
      id: `shot-${Date.now()}`,
      name: `View ${shots.length + 1}`,
      cameraPosition: currentCamera.position,
      target: currentCamera.target,
      fov: Math.round(currentCamera.fov),
      verticalExaggeration: viewerState.verticalExaggeration,
      textureMode: viewerState.textureMode,
      showRoute: viewerState.showRoute,
    };
    setShots((current) => [nextShot, ...current]);
    setViewerState((state) => ({ ...state, selectedShotId: nextShot.id }));
  };

  const activeRouteStats = loadedRoute ?? activeRoute;

  useEffect(() => {
    if (!isReplayPreviewing) return;
    setViewerState((state) => ({ ...state, cameraMode: "route-follow" }));
    const id = window.setInterval(() => {
      setReplayPosition((value) => (value >= 100 ? 0 : Math.min(100, value + 0.35)));
    }, 40);
    return () => window.clearInterval(id);
  }, [isReplayPreviewing]);

  useEffect(() => {
    const onExportReady = (event: Event) => {
      const customEvent = event as CustomEvent<{ dataUrl?: string }>;
      if (customEvent.detail?.dataUrl) {
        setExportImageUrl(customEvent.detail.dataUrl);
      }
    };
    window.addEventListener("trek-export-ready", onExportReady);
    return () => window.removeEventListener("trek-export-ready", onExportReady);
  }, []);

  const copyShareLink = async () => {
    const url = new URL(window.location.href);
    url.searchParams.set("valley", viewerState.valleyId ?? "");
    url.searchParams.set("route", viewerState.routeId ?? "");
    url.searchParams.set("mode", viewerState.cameraMode);
    url.searchParams.set("shot", viewerState.selectedShotId ?? "");
    await navigator.clipboard?.writeText(url.toString());
  };

  const requestImageExport = () => {
    window.dispatchEvent(new Event("trek-export-image"));
  };

  return (
    <main className="app-shell">
      <TerrainViewer
        status={status}
        valley={activeValley}
        routeId={viewerState.routeId}
        state={viewerState}
        selectedShot={selectedShot}
        replayPosition={replayPosition}
        commands={commands}
        onCameraChange={setCurrentCamera}
        onAssetsLoaded={setLoadedRoute}
      />

      <TopBar
        status={status}
        state={viewerState}
        onStatusChange={setStatus}
        onStateChange={setViewerState}
        onShare={copyShareLink}
        onExport={requestImageExport}
      />

      <CameraToolbar
        activeMode={viewerState.cameraMode}
        onModeChange={setMode}
        onFrameRoute={() => {
          setMode("orbit");
          setCommands((current) => ({ ...current, frameRoute: current.frameRoute + 1 }));
        }}
        onReset={() =>
          {
            setViewerState((state) => ({
              ...state,
              cameraMode: "orbit",
              selectedShotId: initialShots[0].id,
            }));
            setCommands((current) => ({ ...current, reset: current.reset + 1 }));
          }
        }
      />

      <Hud
        state={viewerState}
        routeName={activeRouteStats?.name ?? "No route"}
        routeDistanceKm={activeRouteStats?.distanceKm ?? 0}
        elevationGainM={activeRouteStats?.elevationGainM ?? 0}
        camera={currentCamera}
        terrainLabel={
          activeValley?.terrain
            ? activeValley.terrain.demSource === "mixed"
              ? `5 m + ${activeValley.terrain.ignFillResolutionM ?? "?"} m fill / ${activeValley.terrain.gridSize}`
              : `${activeValley.terrain.sourceResolutionM ?? "?"} m / ${activeValley.terrain.gridSize}`
            : "-"
        }
      />

      <ShotPanel
        shots={shots}
        selectedShotId={viewerState.selectedShotId}
        onSelect={(selectedShotId) =>
          setViewerState((state) => ({ ...state, selectedShotId }))
        }
        onAdd={addShot}
        onToggleRoute={() =>
          setViewerState((state) => ({ ...state, showRoute: !state.showRoute }))
        }
        onExport={requestImageExport}
        showRoute={viewerState.showRoute}
      />

      <ControlPanel
        state={viewerState}
        onStateChange={setViewerState}
        selectedShot={selectedShot}
      />

      <ReplayTimeline
        value={replayPosition}
        isPreviewing={isReplayPreviewing}
        onChange={setReplayPosition}
        onTogglePreview={() => setIsReplayPreviewing((value) => !value)}
      />

      {exportImageUrl ? (
        <ExportPreview imageUrl={exportImageUrl} onClose={() => setExportImageUrl(null)} />
      ) : null}
    </main>
  );
}

type TopBarProps = {
  status: AppStatus;
  state: ViewerState;
  onStatusChange: (status: AppStatus) => void;
  onStateChange: React.Dispatch<React.SetStateAction<ViewerState>>;
  onShare: () => void;
  onExport: () => void;
};

function TopBar({ status, state, onStatusChange, onStateChange, onShare, onExport }: TopBarProps) {
  const activeValley = valleys.find((valley) => valley.id === state.valleyId);

  return (
    <header className="top-bar glass-panel">
      <div className="brand-lockup">
        <div className="brand-mark">
          <Mountain size={18} />
        </div>
        <div>
          <p className="eyebrow">LiDAR trek camera</p>
          <h1>Valley viewer</h1>
        </div>
      </div>

      <div className="select-row">
        <label>
          <span>Valley</span>
          <select
            value={state.valleyId ?? ""}
            onChange={(event) => {
              const valley = valleys.find((item) => item.id === event.target.value);
              onStateChange((current) => ({
                ...current,
                valleyId: valley?.id ?? null,
                routeId: valley?.routes[0]?.id ?? null,
              }));
            }}
          >
            {valleys.map((valley) => (
              <option key={valley.id} value={valley.id}>
                {valley.name}
              </option>
            ))}
          </select>
        </label>

        <label>
          <span>Route</span>
          <select
            value={state.routeId ?? ""}
            onChange={(event) =>
              onStateChange((current) => ({
                ...current,
                routeId: event.target.value,
              }))
            }
          >
            {(activeValley?.routes ?? []).map((route) => (
              <option key={route.id} value={route.id}>
                {route.name}
              </option>
            ))}
          </select>
        </label>

        <label>
          <span>Quality</span>
          <select
            value={state.quality}
            onChange={(event) =>
              onStateChange((current) => ({
                ...current,
                quality: event.target.value as Quality,
              }))
            }
          >
            <option value="low">Low</option>
            <option value="balanced">Balanced</option>
            <option value="high">High</option>
          </select>
        </label>
      </div>

      <div className="top-actions">
        <button type="button" className="icon-button" title="Copy share link" onClick={onShare}>
          <Share2 size={17} />
        </button>
        <button type="button" className="icon-button" title="Export current view" onClick={onExport}>
          <ImageDown size={17} />
        </button>
        <label className="status-switch">
          <span>State</span>
          <select
            value={status}
            onChange={(event) => onStatusChange(event.target.value as AppStatus)}
          >
            <option value="ready">Ready</option>
            <option value="loading">Loading</option>
            <option value="empty">Empty</option>
            <option value="error">Error</option>
            <option value="unsupported">Unsupported</option>
          </select>
        </label>
      </div>
    </header>
  );
}

type CameraToolbarProps = {
  activeMode: CameraMode;
  onModeChange: (mode: CameraMode) => void;
  onFrameRoute: () => void;
  onReset: () => void;
};

function CameraToolbar({
  activeMode,
  onModeChange,
  onFrameRoute,
  onReset,
}: CameraToolbarProps) {
  return (
    <nav className="camera-toolbar glass-panel" aria-label="Camera controls">
      <SegmentedButton
        isActive={activeMode === "orbit"}
        label="Orbit"
        title="Orbit around the trek"
        icon={<Orbit size={18} />}
        onClick={() => onModeChange("orbit")}
      />
      <SegmentedButton
        isActive={activeMode === "free-camera"}
        label="Free camera"
        title="Move the camera freely"
        icon={<Camera size={18} />}
        onClick={() => onModeChange("free-camera")}
      />
      <SegmentedButton
        isActive={activeMode === "route-follow"}
        label="Route follow"
        title="Preview the route-follow camera"
        icon={<Route size={18} />}
        onClick={() => onModeChange("route-follow")}
      />
      <div className="toolbar-separator" />
      <button type="button" className="text-button" onClick={onFrameRoute}>
        <Wand2 size={17} />
        Frame route
      </button>
      <button type="button" className="icon-button" title="Reset camera" onClick={onReset}>
        <RotateCcw size={17} />
      </button>
    </nav>
  );
}

function SegmentedButton({
  isActive,
  label,
  icon,
  title,
  onClick,
}: {
  isActive: boolean;
  label: string;
  title: string;
  icon: React.ReactNode;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      className={isActive ? "segmented active" : "segmented"}
      title={title}
      aria-pressed={isActive}
      onClick={onClick}
    >
      {icon}
      <span>{label}</span>
    </button>
  );
}

function Hud({
  state,
  routeName,
  routeDistanceKm,
  elevationGainM,
  camera,
  terrainLabel,
}: {
  state: ViewerState;
  routeName: string;
  routeDistanceKm: number;
  elevationGainM: number;
  camera: CameraSnapshot;
  terrainLabel: string;
}) {
  return (
    <aside className="hud glass-panel" aria-label="Camera readouts">
      <Metric label="Altitude" value={`${Math.round(camera.altitudeM).toLocaleString()} m`} />
      <Metric label="Distance to route" value={`${Math.round(camera.distanceToRouteM).toLocaleString()} m`} />
      <Metric label="Mode" value={cameraLabels[state.cameraMode]} />
      <Metric label="FOV" value={`${Math.round(camera.fov)} deg`} />
      <Metric label="Quality" value={state.quality} />
      <Metric label="Heading" value={`${Math.round(camera.headingDeg)} deg`} />
      <Metric label="LiDAR / mesh" value={terrainLabel} />
      <div className="hud-route">
        <Route size={16} />
        <span>{routeName}</span>
        <strong>{routeDistanceKm.toFixed(1)} km · +{Math.round(elevationGainM)} m</strong>
      </div>
    </aside>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className="metric">
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function ShotPanel({
  shots,
  selectedShotId,
  showRoute,
  onSelect,
  onAdd,
  onToggleRoute,
  onExport,
}: {
  shots: SavedShot[];
  selectedShotId: string | null;
  showRoute: boolean;
  onSelect: (id: string) => void;
  onAdd: () => void;
  onToggleRoute: () => void;
  onExport: () => void;
}) {
  return (
    <aside className="shot-panel glass-panel">
      <div className="panel-header">
        <div>
          <p className="eyebrow">Saved views</p>
          <h2>Shot list</h2>
        </div>
        <button type="button" className="icon-button" title="Save current view" onClick={onAdd}>
          <Plus size={17} />
        </button>
      </div>

      <div className="shot-list">
        {shots.map((shot) => (
          <button
            type="button"
            key={shot.id}
            className={shot.id === selectedShotId ? "shot-card active" : "shot-card"}
            onClick={() => onSelect(shot.id)}
          >
            <div className="shot-thumb">
              <Aperture size={18} />
            </div>
            <div>
              <strong>{shot.name}</strong>
              <span>FOV {shot.fov} deg · {textureLabels[shot.textureMode]}</span>
            </div>
          </button>
        ))}
      </div>

      <div className="panel-actions">
        <button type="button" className="text-button wide" onClick={onToggleRoute}>
          {showRoute ? <Eye size={17} /> : <EyeOff size={17} />}
          {showRoute ? "Route visible" : "Route hidden"}
        </button>
        <button type="button" className="text-button wide" onClick={onExport}>
          <Download size={17} />
          Export image
        </button>
      </div>
    </aside>
  );
}

function ControlPanel({
  state,
  selectedShot,
  onStateChange,
}: {
  state: ViewerState;
  selectedShot: SavedShot | null;
  onStateChange: React.Dispatch<React.SetStateAction<ViewerState>>;
}) {
  return (
    <aside className="control-panel glass-panel">
      <div className="panel-header compact">
        <div>
          <p className="eyebrow">Camera setup</p>
          <h2>View controls</h2>
        </div>
        <SlidersHorizontal size={18} />
      </div>

      <label className="toggle-row">
        <span>
          <GalleryHorizontal size={16} />
          Texture
        </span>
        <select
          value={state.textureMode}
          onChange={(event) =>
            onStateChange((current) => ({
              ...current,
              textureMode: event.target.value as TextureMode,
            }))
          }
        >
          <option value="topographic">Reference topo</option>
          <option value="raw-topo">Raw topo</option>
          <option value="lidar-shade">LiDAR shade</option>
          <option value="multi-shade">Multi shade</option>
          <option value="slope">Slope angle</option>
          <option value="hypsometric">Hypsometric</option>
          <option value="surface">Surface</option>
        </select>
      </label>

      <label className="slider-row">
        <span>Vertical exaggeration</span>
        <strong>{state.verticalExaggeration.toFixed(1)}x</strong>
        <input
          type="range"
          min="1"
          max="3.5"
          step="0.1"
          value={state.verticalExaggeration}
          onChange={(event) =>
            onStateChange((current) => ({
              ...current,
              verticalExaggeration: Number(event.target.value),
            }))
          }
        />
      </label>

      <div className="shot-detail">
        <div className="detail-title">
          <CircleDot size={15} />
          <span>{selectedShot?.name ?? "No saved view selected"}</span>
        </div>
        <dl>
          <div>
            <dt>Camera</dt>
            <dd>{selectedShot ? formatVector(selectedShot.cameraPosition) : "-"}</dd>
          </div>
          <div>
            <dt>Target</dt>
            <dd>{selectedShot ? formatVector(selectedShot.target) : "-"}</dd>
          </div>
          <div>
            <dt>Surface</dt>
            <dd>{textureLabels[state.textureMode]}</dd>
          </div>
        </dl>
      </div>
    </aside>
  );
}

function ReplayTimeline({
  value,
  isPreviewing,
  onChange,
  onTogglePreview,
}: {
  value: number;
  isPreviewing: boolean;
  onChange: (value: number) => void;
  onTogglePreview: () => void;
}) {
  return (
    <footer className="timeline glass-panel">
      <button
        type="button"
        className="icon-button"
        title={isPreviewing ? "Pause replay preview" : "Preview route replay"}
        onClick={onTogglePreview}
      >
        {isPreviewing ? <Pause size={17} /> : <Play size={17} />}
      </button>
      <div className="timeline-main">
        <div className="timeline-copy">
          <Film size={16} />
          <span>Route replay preview</span>
          <strong>{Math.round(value)}%</strong>
        </div>
        <input
          type="range"
          min="0"
          max="100"
          value={value}
          onChange={(event) => onChange(Number(event.target.value))}
          aria-label="Replay progress"
        />
      </div>
      <button type="button" className="icon-button" title="Copy camera state">
        <Copy size={17} />
      </button>
      <button type="button" className="icon-button" title="Future cinematic render">
        <Sparkles size={17} />
      </button>
    </footer>
  );
}

function ExportPreview({
  imageUrl,
  onClose,
}: {
  imageUrl: string;
  onClose: () => void;
}) {
  return (
    <aside className="export-preview glass-panel" aria-label="Captured image preview">
      <div className="panel-header compact">
        <div>
          <p className="eyebrow">Captured view</p>
          <h2>Camera image ready</h2>
        </div>
        <button type="button" className="icon-button" title="Close captured image" onClick={onClose}>
          <X size={17} />
        </button>
      </div>
      <img src={imageUrl} alt="Captured terrain camera view" />
      <a className="text-button wide export-link" href={imageUrl} download="escursione-mattutina-camera.png">
        <Download size={17} />
        Download PNG
      </a>
    </aside>
  );
}
