/**
 * Deterministic import validation and preset policy. The middleware tests these
 * without starting the Python baker or touching generated asset directories.
 */
import { createHash } from "node:crypto";
import path from "node:path";
import type { ImportQuality } from "./types";

const franceBounds = { west: -5.3, south: 41.2, east: 9.75, north: 51.3 };
const piemonteBounds = { west: 6.55, south: 44.0, east: 9.25, north: 46.55 };
const fetchWorkers = process.env.WEB_FETCH_WORKERS ?? "16";

export function lastErrorLine(lines: string[]) {
  const exception = [...lines].reverse().find((line) => /^\w[\w.]*(Error|Exception|Warning):/.test(line.trim()));
  return (exception ?? [...lines].reverse().find((line) => line.trim()) ?? "").trim().slice(0, 300);
}

export function parseQuality(url: URL): ImportQuality {
  const quality = url.searchParams.get("quality") ?? "high";
  return quality === "fast" || quality === "ultra" ? quality : "high";
}

export function importJobId(gpxText: string, quality: ImportQuality) {
  return createHash("sha256").update(gpxText).update(quality).update("ridgeline-import-v1").digest("hex").slice(0, 16);
}

export function slugify(value: string) {
  const slug = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "");
  return slug || "imported-route";
}

export function titleFromFilename(filename: string) {
  return path.basename(filename, path.extname(filename)).replace(/[_-]+/g, " ").trim() || "Imported route";
}

export function parseBounds(gpxText: string) {
  const matches = [...gpxText.matchAll(/<trkpt[^>]*lat="([^"]+)"[^>]*lon="([^"]+)"/g)];
  if (matches.length < 2) throw new Error("GPX must contain at least two track points.");
  const lat = matches.map((match) => Number(match[1]));
  const lon = matches.map((match) => Number(match[2]));
  if (lat.some(Number.isNaN) || lon.some(Number.isNaN)) throw new Error("GPX contains invalid coordinates.");
  return {
    west: Math.min(...lon),
    south: Math.min(...lat),
    east: Math.max(...lon),
    north: Math.max(...lat),
    pointCount: matches.length,
  };
}

export function boundsInside(
  bounds: { west: number; south: number; east: number; north: number },
  region: { west: number; south: number; east: number; north: number },
) {
  return (
    bounds.west >= region.west &&
    bounds.east <= region.east &&
    bounds.south >= region.south &&
    bounds.north <= region.north
  );
}

export function validateSupportedRegion(gpxText: string) {
  const bounds = parseBounds(gpxText);
  if (bounds.pointCount > 250_000) throw new Error("GPX has too many points. Simplify it below 250k points first.");
  const supported = boundsInside(bounds, franceBounds) || boundsInside(bounds, piemonteBounds);
  if (!supported) throw new Error("This GPX is outside the supported Piemonte/France area.");
  return bounds;
}

// Presets target a ground resolution (m/cell) rather than a fixed grid, so a
// 5 km hike and a 30 km traverse get the same detail density up to WEB_GRID_MAX.
export function qualityEnv(quality: ImportQuality) {
  if (quality === "fast") {
    return {
      WEB_TARGET_RES_M: "8",
      WEB_GRID_MAX: "1200",
      WEB_TEXTURE_MAX: "4096",
      WEB_TILEZOOM: "15",
      WEB_DEM_RES_M: "5",
      WEB_ROUTE_STEP_M: "6",
      WEB_FOREST_PX: "1024",
      WEB_FETCH_WORKERS: fetchWorkers,
    };
  }
  if (quality === "ultra") {
    return {
      WEB_TARGET_RES_M: "3",
      WEB_GRID_MAX: "3200",
      WEB_TEXTURE_MAX: "8192",
      WEB_TILEZOOM: "17",
      WEB_DEM_RES_M: "1",
      WEB_ROUTE_STEP_M: "2",
      WEB_FOREST_PX: "2048",
      WEB_FETCH_WORKERS: fetchWorkers,
    };
  }
  return {
    WEB_TARGET_RES_M: "5",
    WEB_GRID_MAX: "2200",
    WEB_TEXTURE_MAX: "8192",
    WEB_TILEZOOM: "16",
    WEB_DEM_RES_M: "2",
    WEB_ROUTE_STEP_M: "3",
    WEB_FOREST_PX: "1536",
    WEB_FETCH_WORKERS: fetchWorkers,
  };
}
