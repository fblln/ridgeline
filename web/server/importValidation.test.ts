import { describe, expect, it } from "vitest";
import { boundsInside, parseBounds, validateSupportedRegion } from "./importValidation";

const piemonte = '<gpx><trkpt lat="45.07" lon="7.68"></trkpt><trkpt lat="45.10" lon="7.70"></trkpt></gpx>';

describe("parseBounds", () => {
  it("derives a bounding box and point count", () => {
    const b = parseBounds(piemonte);
    expect(b).toMatchObject({ west: 7.68, south: 45.07, east: 7.7, north: 45.1, pointCount: 2 });
  });

  it("rejects fewer than two track points", () => {
    expect(() => parseBounds('<gpx><trkpt lat="45" lon="7"></trkpt></gpx>')).toThrow(/two track points/);
  });

  it("rejects non-numeric coordinates", () => {
    const bad = '<gpx><trkpt lat="x" lon="7"></trkpt><trkpt lat="45" lon="7"></trkpt></gpx>';
    expect(() => parseBounds(bad)).toThrow(/invalid coordinates/);
  });
});

describe("boundsInside", () => {
  const region = { west: 0, south: 0, east: 10, north: 10 };
  it("accepts a contained box", () => {
    expect(boundsInside({ west: 1, south: 1, east: 9, north: 9 }, region)).toBe(true);
  });
  it("rejects a box poking outside", () => {
    expect(boundsInside({ west: 1, south: 1, east: 11, north: 9 }, region)).toBe(false);
  });
});

describe("validateSupportedRegion", () => {
  it("accepts a Piemonte route", () => {
    expect(validateSupportedRegion(piemonte).pointCount).toBe(2);
  });

  it("rejects a route outside the supported area", () => {
    const off = '<gpx><trkpt lat="0.0" lon="0.0"></trkpt><trkpt lat="0.1" lon="0.1"></trkpt></gpx>';
    expect(() => validateSupportedRegion(off)).toThrow(/supported/);
  });
});
