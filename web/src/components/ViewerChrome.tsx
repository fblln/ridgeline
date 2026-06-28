/**
 * Presentational controls for the terrain viewer shell. Components in this file
 * receive all state via props and intentionally avoid owning app workflow state.
 */
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
import type React from "react";
import { useEffect, useState } from "react";
import { formatMinutes } from "../app/routeTime";
import { cameraLabels, layerShort, mapLayers } from "../app/viewerLabels";
import type { CameraMode, CameraSnapshot, SavedShot, TextureMode, ViewerState, ViewMode } from "../types";

export function LoadingOverlay() {
  // Asset fetches do not expose byte-level progress, so this keeps loading visibly active.
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

export type TopBarProps = {
  state: ViewerState;
  routeName: string;
  routeDistanceKm: number;
  elevationGainM: number;
  onViewModeChange: (mode: ViewMode) => void;
  onShare: () => void;
  onExport: () => void;
  onReset: () => void;
};

export function TopBar({
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

export function CoordReadout({ coords, altitudeM }: { coords: string; altitudeM: number }) {
  return (
    <div className="coord-badge">
      <div className="coord-main">{coords}</div>
      <div className="coord-sub">{Math.round(altitudeM).toLocaleString()} m · WGS84</div>
    </div>
  );
}

export function Hud({ state, camera }: { state: ViewerState; camera: CameraSnapshot }) {
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

export function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className="metric">
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

export type CameraToolbarProps = {
  activeMode: CameraMode;
  onModeChange: (mode: CameraMode) => void;
  onFrameRoute: () => void;
};

export function CameraToolbar({ activeMode, onModeChange, onFrameRoute }: CameraToolbarProps) {
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

export function SegmentedButton({
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

export function ControlPanel({
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

export function ShotPanel({
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
              <span>
                FOV {shot.fov}° · {layerShort(shot.textureMode)}
              </span>
            </div>
          </button>
        ))}
      </div>
    </aside>
  );
}

export type MoveHint = { keys: string[]; label: string };

// Control legend per camera mode — 2D map locks tilt, free-camera adds fly keys,
// route-follow rides the timeline.
export function moveHints(state: ViewerState): MoveHint[] {
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

export function MovePanel({ state }: { state: ViewerState }) {
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

export function ReplayTimeline({
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

export function ExportPreview({ imageUrl, onClose }: { imageUrl: string; onClose: () => void }) {
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div className="export-scrim">
      <aside className="export-preview glass-panel" role="dialog" aria-modal="true" aria-label="Captured image preview">
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
