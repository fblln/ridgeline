import { describe, expect, it } from "vitest";
import * as THREE from "three";
import type { TerrainAsset } from "../types";
import { clamp, localToScene, sceneToLocal } from "./coordinates";

const terrain: TerrainAsset = {
  gridSize: 2,
  widthM: 1000,
  depthM: 800,
  minHeightM: 100,
  maxHeightM: 300,
  heights: [100, 150, 250, 300],
};

describe("viewer coordinates", () => {
  it("clamps values into bounds", () => {
    expect(clamp(-5, 0, 10)).toBe(0);
    expect(clamp(20, 0, 10)).toBe(10);
    expect(clamp(7, 0, 10)).toBe(7);
  });

  it("round-trips local asset coordinates through scene coordinates", () => {
    const local: [number, number, number] = [625, 250, 180];
    const scene = localToScene(local, terrain, 1.5);

    expect(scene).toEqual(new THREE.Vector3(125, 120, 150));
    expect(sceneToLocal(scene, terrain, 1.5)).toEqual(local);
  });
});
