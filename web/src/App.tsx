import {
  Aperture,
  Box,
  Camera,
  Download,
  Eye,
  EyeOff,
  Film,
  Loader2,
  Map as MapIcon,
  Mountain,
  Orbit,
  Pause,
  Play,
  Plus,
  Route,
  Share2,
  Wand2,
  X,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { EntryScreen } from "./EntryScreen";
import { initialShots, valleys } from "./mockData";
import { TerrainViewer } from "./TerrainViewer";
import type {
  AppStatus,
  CameraMode,
  CameraSnapshot,
  RouteAsset,
  RoutePoint,
  SavedShot,
  TextureMode,
  ViewerState,
  ViewMode,
} from "./types";

type Screen = "entry" | "loading" | "viewer";

const cameraLabels: Record<CameraMode, string> = {
  orbit: "Orbit",
  "free-camera": "Free camera",
  "route-follow": "Route follow",
};

const replayDurationMs = 68000;

const textureLabels: Record<TextureMode, string> = {
  topographic: "Reference topo",
  "raw-topo": "Raw topo",
  "lidar-shade": "LiDAR shade",
  "multi-shade": "Multi shade",
  slope: "Slope angle",
  hypsometric: "Hypsometric",
  forest: "Forest",
  surface: "Surface",
};

// Wireframe Screen 2F — the four map layers (key, swatch) mapped to existing texture modes.
const mapLayers: Array<{ mode: TextureMode; label: string; key: string; swatch: string }> = [
  { mode: "topographic", label: "Topo", key: "1", swatch: "linear-gradient(135deg,#cdddea,#9ab089)" },
  { mode: "lidar-shade", label: "LiDAR shade", key: "2", swatch: "linear-gradient(135deg,#e7e2d6,#6f6857)" },
  { mode: "slope", label: "Slope", key: "3", swatch: "linear-gradient(135deg,#3f6b4f,#d8542b)" },
  { mode: "forest", label: "Forest", key: "4", swatch: "linear-gradient(135deg,#f3efe2,#2e5c2f)" },
];

function layerShort(mode: TextureMode) {
  return mapLayers.find((layer) => layer.mode === mode)?.label ?? textureLabels[mode];
}

function formatVector(value: [number, number, number]) {
  return value.map((part) => Math.round(part)).join(", ");
}

// Naismith-ish moving-time estimate per point: 4.5 km/h on the flat + 600 m/h of climb.
// ponytail: no real GPX timestamps in the data, so estimate; swap in track times if they land.
function cumulativeMinutes(points: RoutePoint[]): number[] {
  const out = [0];
  for (let i = 1; i < points.length; i++) {
    const flat = Math.max(0, points[i].d - points[i - 1].d) / 75; // 75 m/min ≈ 4.5 km/h
    const climb = Math.max(0, points[i].z - points[i - 1].z) / 10; // 10 m/min ≈ 600 m/h
    out.push(out[i - 1] + flat + climb);
  }
  return out;
}

function formatMinutes(min: number) {
  const h = Math.floor(min / 60);
  const m = Math.round(min % 60);
  return h > 0 ? `${h}h ${m.toString().padStart(2, "0")}` : `${m} min`;
}

export function App() {
  const [screen, setScreen] = useState<Screen>("entry");
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
    viewMode: "3d",
    cameraMode: "orbit",
    quality: "high",
    textureMode: "topographic",
    verticalExaggeration: 1.5,
    showRoute: true,
    selectedShotId: initialShots[0].id,
  });
  const [shots, setShots] = useState<SavedShot[]>(initialShots);
  const [replayPosition, setReplayPosition] = useState(0);
  const [isReplayPreviewing, setIsReplayPreviewing] = useState(false);
  const [loadedRoute, setLoadedRoute] = useState<RouteAsset | null>(null);
  const [exportImageUrl, setExportImageUrl] = useState<string | null>(null);
  const [commands, setCommands] = useState({
    frameRoute: 0,
    reset: 0,
    exportImage: 0,
  });

  const status: AppStatus = screen === "loading" ? "loading" : "ready";

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

  const centerCoords = useMemo(() => {
    const b = activeValley?.bounds;
    if (!b) return "—";
    return `${((b[1] + b[3]) / 2).toFixed(4)}, ${((b[0] + b[2]) / 2).toFixed(4)}`;
  }, [activeValley]);

  const replayCumMin = useMemo(
    () => (loadedRoute ? cumulativeMinutes(loadedRoute.points) : null),
    [loadedRoute],
  );

  const replayInfo = useMemo(() => {
    const points = loadedRoute?.points;
    if (!points || points.length < 2) return { km: 0, minutes: 0 };
    const idx = Math.round((replayPosition / 100) * (points.length - 1));
    return { km: points[idx].d / 1000, minutes: replayCumMin?.[idx] ?? 0 };
  }, [loadedRoute, replayCumMin, replayPosition]);

  const setMode = useCallback((cameraMode: CameraMode) => {
    setViewerState((state) => ({
      ...state,
      cameraMode,
      viewMode: cameraMode === "orbit" ? state.viewMode : "3d",
    }));
  }, []);

  const setViewMode = (viewMode: ViewMode) => {
    setViewerState((state) => ({ ...state, viewMode }));
  };

  const setTextureMode = (textureMode: TextureMode) => {
    setViewerState((state) => ({ ...state, textureMode }));
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

  // Stable so the viewer's asset-loading effect doesn't refetch+rebuild every render.
  const handleAssetsLoaded = useCallback((route: RouteAsset | null) => {
    setLoadedRoute(route);
    setScreen((current) => (current === "loading" ? "viewer" : current));
  }, []);

  useEffect(() => {
    if (!isReplayPreviewing) return;
    setMode("route-follow");
    let frame = 0;
    let previous = performance.now();
    const tick = (now: number) => {
      const dt = Math.min(120, now - previous);
      previous = now;
      setReplayPosition((value) => Math.min(100, value + (dt / replayDurationMs) * 100));
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [isReplayPreviewing, setMode]);

  // Stop at the end instead of looping back to the start.
  useEffect(() => {
    if (isReplayPreviewing && replayPosition >= 100) setIsReplayPreviewing(false);
  }, [isReplayPreviewing, replayPosition]);

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

  // Map-layer keyboard shortcuts (T/L/S/H), only in the viewer and not while typing.
  useEffect(() => {
    if (screen !== "viewer") return;
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (target && /^(INPUT|SELECT|TEXTAREA)$/.test(target.tagName)) return;
      const layer = mapLayers.find((item) => item.key.toLowerCase() === event.key.toLowerCase());
      if (layer) setTextureMode(layer.mode);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [screen]);

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

  if (screen === "entry") {
    return <EntryScreen onLoad={() => setScreen("loading")} />;
  }

  const routeName = activeRouteStats?.name ?? "No route";

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
        onAssetsLoaded={handleAssetsLoaded}
      />

      {screen === "loading" ? (
        <LoadingOverlay />
      ) : (
        <>
          <TopBar
            state={viewerState}
            routeName={routeName}
            routeDistanceKm={activeRouteStats?.distanceKm ?? 0}
            elevationGainM={activeRouteStats?.elevationGainM ?? 0}
            onViewModeChange={setViewMode}
            onShare={copyShareLink}
            onExport={requestImageExport}
            onReset={() => {
              setViewerState((state) => ({
                ...state,
                cameraMode: "orbit",
                selectedShotId: initialShots[0].id,
              }));
              setCommands((current) => ({ ...current, reset: current.reset + 1 }));
            }}
          />

          <CoordReadout coords={centerCoords} altitudeM={currentCamera.altitudeM} />

          <Hud state={viewerState} camera={currentCamera} />

          <div className="right-rail">
            <ControlPanel
              state={viewerState}
              onStateChange={setViewerState}
              onTextureChange={setTextureMode}
              onToggleRoute={() =>
                setViewerState((state) => ({ ...state, showRoute: !state.showRoute }))
              }
            />
            <ShotPanel
              shots={shots}
              selectedShotId={viewerState.selectedShotId}
              onSelect={(selectedShotId) =>
                setViewerState((state) => ({ ...state, selectedShotId }))
              }
              onAdd={addShot}
            />
          </div>

          <CameraToolbar
            activeMode={viewerState.cameraMode}
            onModeChange={setMode}
            onFrameRoute={() => {
              setMode("orbit");
              setCommands((current) => ({ ...current, frameRoute: current.frameRoute + 1 }));
            }}
          />

          <MovePanel state={viewerState} />

          <ReplayTimeline
            value={replayPosition}
            distanceKm={replayInfo.km}
            minutes={replayInfo.minutes}
            isPreviewing={isReplayPreviewing}
            onChange={(value) => {
              setReplayPosition(value);
              setMode("route-follow");
            }}
            onTogglePreview={() => {
              setReplayPosition((pos) => (pos >= 100 ? 0 : pos));
              setIsReplayPreviewing((value) => !value);
            }}
          />

          {exportImageUrl ? (
            <ExportPreview imageUrl={exportImageUrl} onClose={() => setExportImageUrl(null)} />
          ) : null}
        </>
      )}
    </main>
  );
}

function LoadingOverlay() {
  // ponytail: indeterminate-ish bar; real progress would need per-asset fetch hooks.
  const [progress, setProgress] = useState(8);
  useEffect(() => {
    const id = window.setInterval(() => {
      setProgress((value) => Math.min(95, value + Math.max(1, (95 - value) * 0.08)));
    }, 200);
    return () => window.clearInterval(id);
  }, []);

  return (
    <div className="status-overlay glass-panel" style={{ zIndex: 13 }}>
      <Loader2 className="spin" size={28} />
      <h2>Reading the file</h2>
      <p>Sampling terrain + route…</p>
      <div className="progress-track">
        <div className="progress-fill" style={{ width: `${progress}%` }} />
      </div>
      <div className="pill-row">
        <span className="pill done">GPX ✓</span>
        <span className="pill">LiDAR mesh</span>
        <span className="pill pending">textures</span>
      </div>
    </div>
  );
}

type TopBarProps = {
  state: ViewerState;
  routeName: string;
  routeDistanceKm: number;
  elevationGainM: number;
  onViewModeChange: (mode: ViewMode) => void;
  onShare: () => void;
  onExport: () => void;
  onReset: () => void;
};

function TopBar({
  state,
  routeName,
  routeDistanceKm,
  elevationGainM,
  onViewModeChange,
  onShare,
  onExport,
  onReset,
}: TopBarProps) {
  return (
    <header className="top-bar glass-panel">
      <button type="button" className="brand-mark" title="Back to start" onClick={onReset}>
        <Mountain size={18} />
      </button>
      <span className="brand-word">Ridgeline</span>
      <span className="route-chip">
        <Route size={14} />
        {routeName} · {routeDistanceKm.toFixed(1)} km · +{Math.round(elevationGainM)} m
      </span>

      <span className="top-spacer" />

      <div className="seg-group">
        <button
          type="button"
          className={state.viewMode === "2d" ? "segmented active" : "segmented"}
          aria-pressed={state.viewMode === "2d"}
          onClick={() => onViewModeChange("2d")}
        >
          <MapIcon size={15} />
          <span>2D</span>
        </button>
        <button
          type="button"
          className={state.viewMode === "3d" ? "segmented active" : "segmented"}
          aria-pressed={state.viewMode === "3d"}
          onClick={() => onViewModeChange("3d")}
        >
          <Box size={15} />
          <span>3D</span>
        </button>
      </div>

      <button type="button" className="icon-button" title="Copy share link" onClick={onShare}>
        <Share2 size={17} />
      </button>
      <button type="button" className="text-button primary" onClick={onExport}>
        <Download size={16} />
        Export
      </button>
    </header>
  );
}

function CoordReadout({ coords, altitudeM }: { coords: string; altitudeM: number }) {
  return (
    <div className="coord-badge">
      <div className="coord-main">{coords}</div>
      <div className="coord-sub">{Math.round(altitudeM).toLocaleString()} m · WGS84</div>
    </div>
  );
}

function Hud({ state, camera }: { state: ViewerState; camera: CameraSnapshot }) {
  return (
    <aside className="hud glass-panel" aria-label="Camera readouts">
      <p className="eyebrow">Camera readout</p>
      <div className="hud-grid">
        <Metric label="Altitude" value={`${Math.round(camera.altitudeM).toLocaleString()} m`} />
        <Metric label="To route" value={`${Math.round(camera.distanceToRouteM).toLocaleString()} m`} />
        <Metric label="Mode" value={cameraLabels[state.cameraMode]} />
        <Metric label="Surface" value={layerShort(state.textureMode)} />
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

type CameraToolbarProps = {
  activeMode: CameraMode;
  onModeChange: (mode: CameraMode) => void;
  onFrameRoute: () => void;
};

function CameraToolbar({ activeMode, onModeChange, onFrameRoute }: CameraToolbarProps) {
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

function ControlPanel({
  state,
  onStateChange,
  onTextureChange,
  onToggleRoute,
}: {
  state: ViewerState;
  onStateChange: React.Dispatch<React.SetStateAction<ViewerState>>;
  onTextureChange: (mode: TextureMode) => void;
  onToggleRoute: () => void;
}) {
  return (
    <aside className="control-panel glass-panel">
      <p className="eyebrow">Map layer</p>
      <div className="layer-grid">
        {mapLayers.map((layer) => (
          <button
            type="button"
            key={layer.mode}
            className={state.textureMode === layer.mode ? "layer-tile active" : "layer-tile"}
            onClick={() => onTextureChange(layer.mode)}
            title={`${layer.label} (${layer.key})`}
          >
            <div className="layer-swatch" style={{ background: layer.swatch }} />
            <div className="layer-foot">
              <strong>{layer.label}</strong>
              <span className="kc">{layer.key}</span>
            </div>
          </button>
        ))}
      </div>

      <div className="rail-divider" />

      <label className="slider-row">
        <span>Vertical exaggeration</span>
        <strong>{state.verticalExaggeration.toFixed(1)}x</strong>
        <input
          type="range"
          min="1"
          max="3"
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

      <button type="button" className="text-button wide" onClick={onToggleRoute}>
        {state.showRoute ? <Eye size={16} /> : <EyeOff size={16} />}
        {state.showRoute ? "Route visible" : "Route hidden"}
      </button>
    </aside>
  );
}

function ShotPanel({
  shots,
  selectedShotId,
  onSelect,
  onAdd,
}: {
  shots: SavedShot[];
  selectedShotId: string | null;
  onSelect: (id: string) => void;
  onAdd: () => void;
}) {
  return (
    <aside className="shot-panel glass-panel">
      <div className="panel-header compact">
        <p className="eyebrow">Saved views</p>
        <button type="button" className="icon-button small" title="Save current view" onClick={onAdd}>
          <Plus size={16} />
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
              <span>FOV {shot.fov}° · {layerShort(shot.textureMode)}</span>
            </div>
          </button>
        ))}
      </div>
    </aside>
  );
}

type MoveHint = { keys: string[]; label: string };

// Control legend per camera mode — 2D map locks tilt, free-camera adds fly keys,
// route-follow rides the timeline.
function moveHints(state: ViewerState): MoveHint[] {
  if (state.viewMode === "2d") {
    return [
      { keys: ["Drag"], label: "Pan" },
      { keys: ["Scroll"], label: "Zoom" },
    ];
  }
  if (state.cameraMode === "free-camera") {
    return [
      { keys: ["Drag"], label: "Look" },
      { keys: ["Scroll"], label: "Zoom" },
      { keys: ["W", "A", "S", "D"], label: "Fly" },
      { keys: ["Q", "E"], label: "Down / up" },
      { keys: ["Shift"], label: "Faster" },
    ];
  }
  if (state.cameraMode === "route-follow") {
    return [{ keys: ["Timeline"], label: "Scrub the route" }];
  }
  return [
    { keys: ["Drag"], label: "Orbit" },
    { keys: ["Scroll"], label: "Zoom" },
  ];
}

function MovePanel({ state }: { state: ViewerState }) {
  return (
    <aside className="move-panel glass-panel" aria-label="Navigation help">
      {moveHints(state).map((hint) => (
        <div className="move-row" key={hint.label}>
          <div className="move-row-keys">
            {hint.keys.map((key) => (
              <span className="kc" key={key}>
                {key}
              </span>
            ))}
          </div>
          <span className="move-row-label">{hint.label}</span>
        </div>
      ))}
    </aside>
  );
}

function ReplayTimeline({
  value,
  distanceKm,
  minutes,
  isPreviewing,
  onChange,
  onTogglePreview,
}: {
  value: number;
  distanceKm: number;
  minutes: number;
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
      <div className="timeline-copy">
        <Film size={16} />
        <span>Route replay</span>
      </div>
      <input
        type="range"
        min="0"
        max="100"
        step="0.01"
        value={value}
        onChange={(event) => onChange(Number(event.target.value))}
        aria-label="Replay progress"
      />
      <div className="timeline-readout">
        <strong>{distanceKm.toFixed(1)} km</strong>
        <span>{formatMinutes(minutes)}</span>
      </div>
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
    <div className="export-scrim" onClick={onClose}>
      <aside
        className="export-preview glass-panel"
        aria-label="Captured image preview"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="panel-header compact">
          <div>
            <p className="eyebrow">Captured view · 7200×5400</p>
            <h2>Camera image ready</h2>
          </div>
          <button type="button" className="icon-button" title="Close captured image" onClick={onClose}>
            <X size={17} />
          </button>
        </div>
        <img src={imageUrl} alt="Captured terrain camera view" />
        <a className="text-button wide primary" href={imageUrl} download="ridgeline-camera.png">
          <Download size={17} />
          Download PNG
        </a>
      </aside>
    </div>
  );
}
