/**
 * Coordinate and camera-rig utilities. Generated assets use local x/y/z values
 * in meters; Three.js uses x/y/z with terrain depth mapped onto scene z.
 */
import * as THREE from "three";
import type { AppStatus, TerrainAsset } from "../types";
import type { CameraRig } from "./types";

export function classForStatus(status: AppStatus) {
  return status === "ready" ? "viewport ready" : "viewport dimmed";
}

export function distance2d(a: THREE.Vector3, b: THREE.Vector3) {
  return Math.hypot(a.x - b.x, a.z - b.z);
}

export function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

export function localToScene(point: [number, number, number], terrain: TerrainAsset, verticalExaggeration: number) {
  return new THREE.Vector3(
    point[0] - terrain.widthM / 2,
    (point[2] - terrain.minHeightM) * verticalExaggeration,
    terrain.depthM / 2 - point[1],
  );
}

export function sceneToLocal(point: THREE.Vector3, terrain: TerrainAsset, verticalExaggeration: number): [number, number, number] {
  return [
    point.x + terrain.widthM / 2,
    terrain.depthM / 2 - point.z,
    point.y / verticalExaggeration + terrain.minHeightM,
  ];
}

export function computeRigFromCamera(camera: THREE.PerspectiveCamera, target: THREE.Vector3): CameraRig {
  const offset = camera.position.clone().sub(target);
  const radius = Math.max(10, offset.length());
  return {
    target: target.clone(),
    radius,
    theta: Math.atan2(offset.x, offset.z),
    phi: Math.acos(clamp(offset.y / radius, 0.08, 0.98)),
  };
}

export function applyRig(camera: THREE.PerspectiveCamera, rig: CameraRig) {
  const sinPhi = Math.sin(rig.phi);
  camera.position.set(
    rig.target.x + rig.radius * sinPhi * Math.sin(rig.theta),
    rig.target.y + rig.radius * Math.cos(rig.phi),
    rig.target.z + rig.radius * sinPhi * Math.cos(rig.theta),
  );
  camera.lookAt(rig.target);
}

export function dampingAlpha(damping: number, dt: number) {
  return 1 - Math.exp(-damping * dt);
}

