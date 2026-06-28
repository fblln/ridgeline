/**
 * Route replay math. This module keeps the cinematic follow camera deterministic
 * and testable outside the React animation loop.
 */
import * as THREE from "three";
import type { RouteAsset, TerrainAsset } from "../types";
import { routeFollowConfig } from "./constants";
import { clamp } from "./coordinates";
import type { RouteSampler } from "./types";

export function buildRouteSampler(route: RouteAsset, points: THREE.Vector3[]): RouteSampler {
  const distances = new Array<number>(points.length).fill(0);
  const firstRouteDistance = route.points[0]?.d ?? 0;
  for (let i = 1; i < points.length; i += 1) {
    const routeDistance = route.points[i]?.d;
    const fromRoute = typeof routeDistance === "number" ? routeDistance - firstRouteDistance : NaN;
    distances[i] =
      Number.isFinite(fromRoute) && fromRoute > distances[i - 1]
        ? fromRoute
        : distances[i - 1] + points[i].distanceTo(points[i - 1]);
  }
  return {
    points,
    distances,
    totalDistanceM: Math.max(distances[distances.length - 1] ?? 0, route.distanceKm * 1000),
  };
}

export function sampleRouteDistance(sampler: RouteSampler, distanceM: number, target = new THREE.Vector3()) {
  const { points, distances } = sampler;
  if (points.length === 0) return target.set(0, 0, 0);
  if (points.length === 1) return target.copy(points[0]);
  const distance = clamp(distanceM, 0, sampler.totalDistanceM);
  if (distance <= distances[0]) return target.copy(points[0]);
  const last = points.length - 1;
  if (distance >= distances[last]) return target.copy(points[last]);

  let low = 0;
  let high = last;
  while (low + 1 < high) {
    const mid = Math.floor((low + high) / 2);
    if (distances[mid] <= distance) low = mid;
    else high = mid;
  }

  const span = Math.max(0.001, distances[high] - distances[low]);
  return target.lerpVectors(points[low], points[high], (distance - distances[low]) / span);
}

export function routeHeadingAtDistance(sampler: RouteSampler, distanceM: number, target = new THREE.Vector3()) {
  const behind = sampleRouteDistance(sampler, distanceM - routeFollowConfig.headingBackM);
  const ahead = sampleRouteDistance(sampler, distanceM + routeFollowConfig.headingForwardM);
  target.copy(ahead).sub(behind);
  target.y = 0;
  if (target.lengthSq() < 1) target.set(0, 0, -1);
  return target.normalize();
}

export function clampFollowCameraPosition(subject: THREE.Vector3, position: THREE.Vector3) {
  const offset = position.clone().sub(subject);
  const distance = offset.length();
  if (distance < 1) return position;
  const clampedDistance = clamp(distance, routeFollowConfig.minCameraDistanceM, routeFollowConfig.maxCameraDistanceM);
  if (Math.abs(clampedDistance - distance) < 0.01) return position;
  return subject.clone().add(offset.multiplyScalar(clampedDistance / distance));
}

export function terrainHeightAtScene(
  terrain: TerrainAsset,
  sceneX: number,
  sceneZ: number,
  verticalExaggeration: number,
) {
  const n = terrain.gridSize;
  if (n < 2) return 0;
  const u = clamp((sceneX + terrain.widthM / 2) / terrain.widthM, 0, 1) * (n - 1);
  const v = clamp((terrain.depthM / 2 - sceneZ) / terrain.depthM, 0, 1) * (n - 1);
  const c0 = Math.floor(u);
  const r0 = Math.floor(v);
  const c1 = Math.min(n - 1, c0 + 1);
  const r1 = Math.min(n - 1, r0 + 1);
  const tx = u - c0;
  const tz = v - r0;
  const h00 = terrain.heights[r0 * n + c0] ?? terrain.minHeightM;
  const h10 = terrain.heights[r0 * n + c1] ?? h00;
  const h01 = terrain.heights[r1 * n + c0] ?? h00;
  const h11 = terrain.heights[r1 * n + c1] ?? h10;
  const h0 = h00 + (h10 - h00) * tx;
  const h1 = h01 + (h11 - h01) * tx;
  return (h0 + (h1 - h0) * tz - terrain.minHeightM) * verticalExaggeration;
}

export function sightlineOcclusionScore(
  terrain: TerrainAsset,
  verticalExaggeration: number,
  eye: THREE.Vector3,
  target: THREE.Vector3,
) {
  let score = 0;
  const sample = new THREE.Vector3();
  for (let i = 1; i <= 14; i += 1) {
    const t = i / 16;
    sample.lerpVectors(eye, target, t);
    const terrainY = terrainHeightAtScene(terrain, sample.x, sample.z, verticalExaggeration);
    score = Math.max(score, terrainY + routeFollowConfig.occlusionClearanceM - sample.y);
  }
  return Math.max(0, score);
}

export function sideOffsetForSightline(
  terrain: TerrainAsset,
  verticalExaggeration: number,
  heading: THREE.Vector3,
  basePosition: THREE.Vector3,
  baseTarget: THREE.Vector3,
) {
  const right = new THREE.Vector3(heading.z, 0, -heading.x);
  if (right.lengthSq() < 0.001) return 0;
  right.normalize();
  const centerScore = sightlineOcclusionScore(terrain, verticalExaggeration, basePosition, baseTarget);
  if (centerScore <= 0) return 0;

  let bestOffset = 0;
  let bestScore = centerScore;
  for (const direction of [-1, 1]) {
    const offset = direction * routeFollowConfig.sideStepM;
    const position = basePosition.clone().add(right.clone().multiplyScalar(offset));
    const target = baseTarget.clone().add(right.clone().multiplyScalar(offset * routeFollowConfig.targetSideRatio));
    const score = sightlineOcclusionScore(terrain, verticalExaggeration, position, target);
    if (score < bestScore) {
      bestScore = score;
      bestOffset = offset;
    }
  }

  const strength = clamp(centerScore / 260, 0.25, 1);
  return bestOffset * strength;
}
