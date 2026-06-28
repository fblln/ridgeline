import { describe, expect, it } from "vitest";
import { cumulativeMinutes, formatMinutes } from "./routeTime";

describe("route time estimates", () => {
  it("combines flat travel and ascent into cumulative minutes", () => {
    const points = [
      { x: 0, y: 0, z: 100, d: 0, lat: 45, lon: 7 },
      { x: 0, y: 0, z: 130, d: 750, lat: 45, lon: 7 },
      { x: 0, y: 0, z: 120, d: 1500, lat: 45, lon: 7 },
    ];

    expect(cumulativeMinutes(points)).toEqual([0, 13, 23]);
  });

  it("formats short and hour-long durations", () => {
    expect(formatMinutes(42.2)).toBe("42 min");
    expect(formatMinutes(73.4)).toBe("1h 13");
  });
});
