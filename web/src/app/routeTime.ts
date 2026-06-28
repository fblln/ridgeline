/**
 * Route timing utilities for replay readouts. These stay separate from UI so
 * future GPX timestamp support can be tested without rendering React.
 */
import type { RoutePoint } from "../types";

// Naismith-ish moving-time estimate per point: 4.5 km/h on the flat + 600 m/h of climb.
// Generated route assets do not carry timestamps yet, so replay time uses a deterministic hiking estimate.
export function cumulativeMinutes(points: RoutePoint[]): number[] {
  const out = [0];
  for (let i = 1; i < points.length; i++) {
    const flat = Math.max(0, points[i].d - points[i - 1].d) / 75; // 75 m/min ≈ 4.5 km/h
    const climb = Math.max(0, points[i].z - points[i - 1].z) / 10; // 10 m/min ≈ 600 m/h
    out.push(out[i - 1] + flat + climb);
  }
  return out;
}

export function formatMinutes(min: number) {
  const h = Math.floor(min / 60);
  const m = Math.round(min % 60);
  return h > 0 ? `${h}h ${m.toString().padStart(2, "0")}` : `${m} min`;
}

