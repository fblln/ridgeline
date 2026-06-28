/**
 * Numeric tuning constants for the viewer. Camera values are measured in the
 * same local-meter coordinate system used by generated terrain assets.
 */
import * as THREE from "three";
import type { ViewerState } from "../types";
import type { TerrainLightingPreset } from "./types";

export const toRad = Math.PI / 180;
export const maxDisplayPixelRatio = 3;
export const exportWidth = 7200;
export const exportHeight = 5400;
export const sceneLayer = 0;
export const markerOverlayLayer = 1;
export const neutralReliefTexture = new THREE.DataTexture(new Uint8Array([255, 255, 255, 255]), 1, 1);
neutralReliefTexture.needsUpdate = true;
export const routeFollowConfig = {
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

export const terrainLightingPresets: Record<ViewerState["textureMode"], TerrainLightingPreset> = {
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

