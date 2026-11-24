import { MIN_HORIZONTAL_FORWARD, SECTOR_DEG, YAW_SECTORS } from './rules';
import type { KeyframeEvent } from './types';

// D-10: top-down coverage for the mini-map. yawDeg/sectorOf are identical to
// backend frameYawDeg/yawSectorCount (validate.ts), so the ring agrees with the server.

export type Pt = { x: number; y: number };
export type Heading = Pt & { dx: number; dy: number };
export type Coverage = {
  /** Camera centres, rotated so the first look direction points screen-up (metres). */
  path: Pt[];
  /** Every 5th keyframe: position + unit look direction (screen space). */
  ticks: Heading[];
  current: Heading | null;
  /** Sector k is centred k*30 deg from the first look direction (see sectorScreenDeg). */
  sectorsSeen: boolean[];
  seenCount: number;
  /** Max of the raw x and z ranges (metres). */
  rawSpanM: number;
};

const DEG = 180 / Math.PI;

/** Yaw (deg) of the camera forward (-Z column) in the world XZ plane; null when looking near vertical. */
export function yawDeg(T: number[]): number | null {
  if (Math.hypot(T[8]!, T[10]!) < MIN_HORIZONTAL_FORWARD) return null;
  return Math.atan2(-T[8]!, -T[10]!) * DEG;
}

export function sectorOf(yaw: number, yaw0: number): number {
  const d = (((yaw - yaw0 + SECTOR_DEG / 2) % 360) + 360) % 360;
  return Math.floor(d / SECTOR_DEG);
}

/** Clockwise-from-up screen angle of sector k (yaw grows counter-clockwise in this top-down view). */
export const sectorScreenDeg = (k: number) => (360 - k * SECTOR_DEG) % 360;

export function coverage(frames: KeyframeEvent[]): Coverage {
  const sectorsSeen: boolean[] = Array(YAW_SECTORS).fill(false);
  let yaw0: number | null = null;
  for (const f of frames) {
    const y = yawDeg(f.T_arkit);
    if (y === null) continue;
    yaw0 ??= y;
    sectorsSeen[sectorOf(y, yaw0)] = true;
  }

  // Top-down: world x -> screen x, world z -> screen y (ARKit -Z forward is screen-up).
  // Rotate by (c, s) so the first look direction (a, b) maps to (0, -1).
  let c = 1, s = 0;
  if (yaw0 !== null) {
    const r = yaw0 / DEG;
    const a = Math.sin(r), b = Math.cos(r); // unit (fx, fz) of the first look direction
    c = -b;
    s = -a;
  }
  const rot = (x: number, y: number): Pt => ({ x: x * c - y * s, y: x * s + y * c });

  const heading = (f: KeyframeEvent): Heading => {
    const T = f.T_arkit;
    const p = rot(T[12]!, T[14]!);
    const h = Math.hypot(T[8]!, T[10]!);
    const d = h > 1e-9 ? rot(-T[8]! / h, -T[10]! / h) : { x: 0, y: 0 };
    return { ...p, dx: d.x, dy: d.y };
  };

  const path = frames.map((f) => rot(f.T_arkit[12]!, f.T_arkit[14]!));
  const ticks = frames.filter((_, k) => (k + 1) % 5 === 0).map(heading);
  const last = frames[frames.length - 1];

  const xs = frames.map((f) => f.T_arkit[12]!), zs = frames.map((f) => f.T_arkit[14]!);
  const range = (v: number[]) => (v.length ? Math.max(...v) - Math.min(...v) : 0);

  return {
    path,
    ticks,
    current: last ? heading(last) : null,
    sectorsSeen,
    seenCount: sectorsSeen.filter(Boolean).length,
    rawSpanM: Math.max(range(xs), range(zs)),
  };
}

/** Maps metres into a box x box square: aspect kept, centred, span at least minSpanM. */
export function fitToBox(points: Pt[], box = 72, minSpanM = 1): (p: Pt) => Pt {
  const xs = points.map((p) => p.x), ys = points.map((p) => p.y);
  const minX = Math.min(...xs, Infinity), maxX = Math.max(...xs, -Infinity);
  const minY = Math.min(...ys, Infinity), maxY = Math.max(...ys, -Infinity);
  const cx = points.length ? (minX + maxX) / 2 : 0, cy = points.length ? (minY + maxY) / 2 : 0;
  const span = Math.max(points.length ? maxX - minX : 0, points.length ? maxY - minY : 0, minSpanM);
  const k = box / span;
  return (p) => ({ x: box / 2 + (p.x - cx) * k, y: box / 2 + (p.y - cy) * k });
}
