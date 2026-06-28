/**
 * Shared display metadata for viewer controls. Keeping labels here prevents the
 * app state container and presentational components from drifting apart.
 */
import type { CameraMode, TextureMode } from "../types";

export const cameraLabels: Record<CameraMode, string> = {
  orbit: "Orbit",
  "free-camera": "Free camera",
  "route-follow": "Route follow",
};

export const textureLabels: Record<TextureMode, string> = {
  topographic: "Reference topo",
  "raw-topo": "Raw topo",
  "lidar-shade": "LiDAR shade",
  "multi-shade": "Multi shade",
  slope: "Slope angle",
  hypsometric: "Hypsometric",
  forest: "Forest",
  surface: "Surface",
};

// Four primary map layers exposed in the compact layer switcher and keyboard shortcuts.
export const mapLayers: Array<{ mode: TextureMode; label: string; key: string; swatch: string }> = [
  { mode: "topographic", label: "Topo", key: "1", swatch: "linear-gradient(135deg,#cdddea,#9ab089)" },
  { mode: "lidar-shade", label: "LiDAR shade", key: "2", swatch: "linear-gradient(135deg,#e7e2d6,#6f6857)" },
  { mode: "slope", label: "Slope", key: "3", swatch: "linear-gradient(135deg,#3f6b4f,#d8542b)" },
  { mode: "forest", label: "Forest", key: "4", swatch: "linear-gradient(135deg,#f3efe2,#2e5c2f)" },
];

export function layerShort(mode: TextureMode) {
  return mapLayers.find((layer) => layer.mode === mode)?.label ?? textureLabels[mode];
}

export function formatVector(value: [number, number, number]) {
  return value.map((part) => Math.round(part)).join(", ");
}
