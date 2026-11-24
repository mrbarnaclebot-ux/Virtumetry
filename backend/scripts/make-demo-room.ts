// Deterministic demo-room fixture builder (D-01..D-03). Writes a synthetic,
// license-free 4 x 5 m room in Echo-3 output conventions to
// test/fixtures/demo-room/ so the mock provider can serve something worth viewing.
//
//   npm run demo-room            (from backend/; needs ffmpeg on PATH for the PNG/JPEG)
//
// All geometry is spaitial-world-v1: metres, +Y up, floor = XZ plane.
// Room x in [-2, 2], z in [-2.5, 2.5], walls to y = 2.5, a 0.9 x 2.1 m doorway
// centred in the z = +2.5 wall, a table and a cabinet.

import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

type M4 = number[][];
type V3 = [number, number, number];

const mul = (A: M4, B: M4): M4 => A.map((row) => B[0]!.map((_, c) => row.reduce((s, v, k) => s + v * B[k]![c]!, 0)));
const F: M4 = [[1, 0, 0, 0], [0, -1, 0, 0], [0, 0, -1, 0], [0, 0, 0, 1]];

function rigidInv(M: M4): M4 {
  const out: M4 = [];
  for (let r = 0; r < 3; r++) {
    const row = [M[0]![r]!, M[1]![r]!, M[2]![r]!];
    out.push([...row, -(row[0]! * M[0]![3]! + row[1]! * M[1]![3]! + row[2]! * M[2]![3]!)]);
  }
  out.push([0, 0, 0, 1]);
  return out;
}

const ffmpeg = (args: string[], input?: Buffer) =>
  execFileSync('ffmpeg', ['-loglevel', 'error', '-y', ...args], input ? { input } : {});

// --- room definition -------------------------------------------------------

export const ROOM = { min: [-2, 0, -2.5] as V3, max: [2, 2.5, 2.5] as V3 };
export const DOOR = { halfWidth: 0.45, height: 2.1 }; // in the z = +2.5 wall
export const TABLE = { min: [0.4, 0, -1.5] as V3, max: [1.4, 0.75, -0.7] as V3 };
export const CABINET = { min: [-1.9, 0, 0.5] as V3, max: [-1.4, 1.8, 1.5] as V3 };
export const CAMERA_LOOP = { radius: 0.7, y: 1.5, frames: 24 };

const WALL_RGB = {
  zMin: [0.78, 0.33, 0.29], // far wall: brick red
  zMax: [0.29, 0.45, 0.78], // door wall: blue
  xMin: [0.36, 0.66, 0.4], // left wall: green
  xMax: [0.88, 0.77, 0.32], // right wall: mustard
} as const;
const TABLE_RGB = [0.55, 0.36, 0.2] as const;
const CABINET_RGB = [0.85, 0.85, 0.82] as const;
const floorRgb = (x: number, z: number): V3 =>
  (Math.floor((x - ROOM.min[0]) / 0.5) + Math.floor((z - ROOM.min[2]) / 0.5)) % 2 ? [0.42, 0.33, 0.25] : [0.82, 0.74, 0.62];

/** mulberry32: tiny seeded PRNG, deterministic across runs and platforms. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// --- splat -------------------------------------------------------------------

type Rect = { o: V3; e1: V3; e2: V3; n: V3; rgb: (p: V3) => readonly number[] };
const rect = (o: V3, e1: V3, e2: V3, n: V3, rgb: Rect['rgb']): Rect => ({ o, e1, e2, n, rgb });
const solid = (c: readonly number[]) => () => c;

/** Visible faces of an axis-aligned box standing on the floor (no bottom). */
function boxFaces(min: V3, max: V3, rgb: readonly number[]): Rect[] {
  const [x0, y0, z0] = min, [x1, y1, z1] = max;
  const dx = x1 - x0, dy = y1 - y0, dz = z1 - z0, c = solid(rgb);
  return [
    rect([x0, y1, z0], [dx, 0, 0], [0, 0, dz], [0, 1, 0], c),
    rect([x0, y0, z0], [0, 0, dz], [0, dy, 0], [-1, 0, 0], c),
    rect([x1, y0, z0], [0, 0, dz], [0, dy, 0], [1, 0, 0], c),
    rect([x0, y0, z0], [dx, 0, 0], [0, dy, 0], [0, 0, -1], c),
    rect([x0, y0, z1], [dx, 0, 0], [0, dy, 0], [0, 0, 1], c),
  ];
}

export function surfaces(): Rect[] {
  const [x0, , z0] = ROOM.min, [x1, h, z1] = ROOM.max;
  const W = x1 - x0, D = z1 - z0, { halfWidth: hw, height: dh } = DOOR;
  return [
    rect([x0, 0, z0], [W, 0, 0], [0, 0, D], [0, 1, 0], (p) => floorRgb(p[0], p[2])),
    rect([x0, 0, z0], [W, 0, 0], [0, h, 0], [0, 0, 1], solid(WALL_RGB.zMin)),
    rect([x0, 0, z1], [-hw - x0, 0, 0], [0, h, 0], [0, 0, -1], solid(WALL_RGB.zMax)),
    rect([hw, 0, z1], [x1 - hw, 0, 0], [0, h, 0], [0, 0, -1], solid(WALL_RGB.zMax)),
    rect([-hw, dh, z1], [2 * hw, 0, 0], [0, h - dh, 0], [0, 0, -1], solid(WALL_RGB.zMax)),
    rect([x0, 0, z0], [0, 0, D], [0, h, 0], [1, 0, 0], solid(WALL_RGB.xMin)),
    rect([x1, 0, z0], [0, 0, D], [0, h, 0], [-1, 0, 0], solid(WALL_RGB.xMax)),
    ...boxFaces(TABLE.min, TABLE.max, TABLE_RGB),
    ...boxFaces(CABINET.min, CABINET.max, CABINET_RGB),
  ];
}

/** Quaternion (w, x, y, z) rotating local +Z onto unit normal n. */
export function quatZTo(n: V3): [number, number, number, number] {
  const [nx, ny, nz] = n;
  if (nz > 1 - 1e-12) return [1, 0, 0, 0];
  if (nz < -1 + 1e-12) return [0, 1, 0, 0]; // 180° about X
  const ax = -ny, ay = nx, s = Math.hypot(ax, ay); // z × n
  const half = Math.acos(nz) / 2, k = Math.sin(half) / s;
  return [Math.cos(half), ax * k, ay * k, 0];
}

export const SPLAT_PROPS = ['x', 'y', 'z', 'f_dc_0', 'f_dc_1', 'f_dc_2', 'opacity', 'scale_0', 'scale_1', 'scale_2', 'rot_0', 'rot_1', 'rot_2', 'rot_3'];
const DENSITY = 1000; // gaussians per m²
const SH_C0 = 0.28209479;

export function buildSplat(seed = 0x5eed): Buffer {
  const rnd = mulberry32(seed);
  const rows: number[][] = [];
  const opacity = Math.log(0.95 / 0.05);
  const sIn = Math.log(0.02), sN = Math.log(0.004);
  for (const r of surfaces()) {
    const area = Math.hypot(...r.e1) * Math.hypot(...r.e2);
    const q = quatZTo(r.n);
    for (let i = 0, n = Math.round(area * DENSITY); i < n; i++) {
      const a = rnd(), b = rnd();
      const p: V3 = [0, 1, 2].map((k) => r.o[k]! + a * r.e1[k]! + b * r.e2[k]!) as V3;
      const jitter = (rnd() - 0.5) * 0.06;
      const rgb = r.rgb(p).map((c) => Math.min(1, Math.max(0, c + jitter)));
      rows.push([...p, ...rgb.map((c) => (c - 0.5) / SH_C0), opacity, sIn, sIn, sN, ...q]);
    }
  }
  const header = `ply\nformat binary_little_endian 1.0\nelement vertex ${rows.length}\n${SPLAT_PROPS.map((p) => `property float ${p}`).join('\n')}\nend_header\n`;
  const body = Buffer.alloc(rows.length * SPLAT_PROPS.length * 4);
  rows.forEach((row, k) => row.forEach((v, p) => body.writeFloatLE(v, (k * SPLAT_PROPS.length + p) * 4)));
  return Buffer.concat([Buffer.from(header, 'latin1'), body]);
}

// --- collider ----------------------------------------------------------------

const WALL_T = 0.02; // collider walls are 2 cm slabs whose outer face is the room boundary

export function buildCollider(): string {
  const verts: V3[] = [];
  const tris: number[][] = [];
  const quad = (...c: V3[]) => {
    const b = verts.length;
    verts.push(...c);
    tris.push([b, b + 1, b + 2], [b, b + 2, b + 3]);
  };
  // CCW seen from outside, so normals point outward (three raycasts are FrontSide).
  const box = ([x0, y0, z0]: V3, [x1, y1, z1]: V3) => {
    quad([x0, y0, z0], [x0, y0, z1], [x0, y1, z1], [x0, y1, z0]);
    quad([x1, y0, z0], [x1, y1, z0], [x1, y1, z1], [x1, y0, z1]);
    quad([x0, y0, z0], [x1, y0, z0], [x1, y0, z1], [x0, y0, z1]);
    quad([x0, y1, z0], [x0, y1, z1], [x1, y1, z1], [x1, y1, z0]);
    quad([x0, y0, z0], [x0, y1, z0], [x1, y1, z0], [x1, y0, z0]);
    quad([x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1]);
  };
  const [x0, , z0] = ROOM.min, [x1, h, z1] = ROOM.max, { halfWidth: hw, height: dh } = DOOR, t = WALL_T;
  quad([x0, 0, z0], [x0, 0, z1], [x1, 0, z1], [x1, 0, z0]); // floor, facing up
  box([x0, 0, z0], [x1, h, z0 + t]);
  box([x0, 0, z1 - t], [-hw, h, z1]);
  box([hw, 0, z1 - t], [x1, h, z1]);
  box([-hw, dh, z1 - t], [hw, h, z1]);
  box([x0, 0, z0 + t], [x0 + t, h, z1 - t]);
  box([x1 - t, 0, z0 + t], [x1, h, z1 - t]);
  box(TABLE.min, TABLE.max);
  box(CABINET.min, CABINET.max);
  const fmt = (v: number) => String(Math.round(v * 1e6) / 1e6);
  return `ply\nformat ascii 1.0\nelement vertex ${verts.length}\nproperty float x\nproperty float y\nproperty float z\nelement face ${tris.length}\nproperty list uchar int vertex_indices\nend_header\n${verts.map((v) => v.map(fmt).join(' ')).join('\n')}\n${tris.map((f) => `3 ${f.join(' ')}`).join('\n')}\n`;
}

// --- floor plan --------------------------------------------------------------

const MPP = 0.02;
const PLAN_W = Math.round((ROOM.max[0] - ROOM.min[0]) / MPP); // 200
const PLAN_H = Math.round((ROOM.max[2] - ROOM.min[2]) / MPP); // 250
const PLAN_WALL = 0.06; // drawn wall thickness (3 px)

type Cell = 'floor' | 'wall' | 'obstacle';
const inXZ = (x: number, z: number, b: { min: V3; max: V3 }) => x >= b.min[0] && x <= b.max[0] && z >= b.min[2] && z <= b.max[2];

/** Classify a world XZ point in the floor-plan cut (furniture is drawn regardless of cut height). */
function cellAt(x: number, z: number): Cell {
  const [x0, , z0] = ROOM.min, [x1, , z1] = ROOM.max;
  if (z > z1 - PLAN_WALL && Math.abs(x) < DOOR.halfWidth) return 'floor'; // doorway is open at the cut
  if (x < x0 + PLAN_WALL || x > x1 - PLAN_WALL || z < z0 + PLAN_WALL || z > z1 - PLAN_WALL) return 'wall';
  if (inXZ(x, z, TABLE) || inXZ(x, z, CABINET)) return 'obstacle';
  return 'floor';
}

export function buildFloorplanMeta() {
  const [ox, , oz] = ROOM.min;
  return {
    version: 1, coordinate_system: 'spaitial-world-v1', projection: 'orthographic_top_down',
    origin_xz: [ox, oz], image_x_axis_xz: [1, 0], image_y_axis_xz: [0, 1],
    extent_m: [ROOM.max[0] - ox, ROOM.max[2] - oz], cut_height_y: 1.0,
    scene_bounds: { min: ROOM.min, max: ROOM.max },
    image: {
      width_px: PLAN_W, height_px: PLAN_H, meters_per_pixel: MPP,
      // Continuous pixel coords: pixel (i, j) covers [i, i+1) x [j, j+1); its centre is (i+0.5, j+0.5).
      world_xz_from_pixel: [[MPP, 0, ox], [0, MPP, oz], [0, 0, 1]],
      pixel_from_world_xz: [[1 / MPP, 0, -ox / MPP], [0, 1 / MPP, -oz / MPP], [0, 0, 1]],
      download_url: 'floorplan.png',
    },
    raw_image: null, generated_at: '2026-11-24T00:00:00Z',
  };
}

function planGray(): Buffer {
  const level: Record<Cell, number> = { wall: 40, obstacle: 140, floor: 235 };
  const buf = Buffer.alloc(PLAN_W * PLAN_H);
  for (let j = 0; j < PLAN_H; j++) {
    for (let i = 0; i < PLAN_W; i++) {
      buf[j * PLAN_W + i] = level[cellAt(ROOM.min[0] + (i + 0.5) * MPP, ROOM.min[2] + (j + 0.5) * MPP)];
    }
  }
  return buf;
}

/** 1200x630 preview: the plan in room colours, letterboxed on the door-wall blue. */
function thumbRgb(): Buffer {
  const TW = 1200, TH = 630, margin = 30;
  const s = (TH - 2 * margin) / (ROOM.max[2] - ROOM.min[2]); // px per metre
  const planW = (ROOM.max[0] - ROOM.min[0]) * s, left = (TW - planW) / 2;
  const bg = [0.16, 0.2, 0.3];
  const wallColour = (x: number, z: number) => {
    const d = [z - ROOM.min[2], ROOM.max[2] - z, x - ROOM.min[0], ROOM.max[0] - x];
    return [WALL_RGB.zMin, WALL_RGB.zMax, WALL_RGB.xMin, WALL_RGB.xMax][d.indexOf(Math.min(...d))]!;
  };
  const buf = Buffer.alloc(TW * TH * 3);
  for (let j = 0; j < TH; j++) {
    for (let i = 0; i < TW; i++) {
      const x = ROOM.min[0] + (i + 0.5 - left) / s, z = ROOM.min[2] + (j + 0.5 - margin) / s;
      let c: readonly number[] = bg;
      if (x >= ROOM.min[0] && x <= ROOM.max[0] && z >= ROOM.min[2] && z <= ROOM.max[2]) {
        const cell = cellAt(x, z);
        c = cell === 'wall' ? wallColour(x, z) : cell === 'floor' ? floorRgb(x, z) : inXZ(x, z, TABLE) ? TABLE_RGB : CABINET_RGB;
      }
      for (let k = 0; k < 3; k++) buf[(j * TW + i) * 3 + k] = Math.round(c[k]! * 255);
    }
  }
  return buf;
}

// --- cameras -------------------------------------------------------------------

/** three.js camera matrixWorld (GL camera: looks down -Z, +Y up) at eye looking at target. */
function lookAt(eye: V3, target: V3): M4 {
  const norm = (v: number[]) => { const l = Math.hypot(...v); return v.map((a) => a / l); };
  const cross = (a: number[], b: number[]) => [a[1]! * b[2]! - a[2]! * b[1]!, a[2]! * b[0]! - a[0]! * b[2]!, a[0]! * b[1]! - a[1]! * b[0]!];
  const zc = norm(eye.map((e, k) => e - target[k]!)); // camera +Z points away from the target
  const xc = norm(cross([0, 1, 0], zc));
  const yc = cross(zc, xc);
  return [0, 1, 2].map((r) => [xc[r]!, yc[r]!, zc[r]!, eye[r]!]).concat([[0, 0, 0, 1]]);
}

export const CAM_K = { width: 1920, height: 1440, fx: 1500, fy: 1500, cx: 960, cy: 720 };

export function buildCameras() {
  const { radius, y, frames } = CAMERA_LOOP;
  return {
    schema_version: 'spaitial.capture_cameras.v1', capture_id: 'demo-room', splat: 'splat.ply',
    coordinate_system: 'opencv', width_px: CAM_K.width, height_px: CAM_K.height, source_frame_count: frames,
    frames: Array.from({ length: frames }, (_, k) => {
      const a = (2 * Math.PI * k) / frames;
      const T = lookAt([radius * Math.cos(a), y, radius * Math.sin(a)], [0, 1.0, 0]);
      return {
        source_index: k, image: `images/Image_${String(k + 1).padStart(6, '0')}.jpg`,
        camera_from_splat: mul(mul(F, rigidInv(T)), F), // F · inv(T_three) · F
        fx_px: CAM_K.fx, fy_px: CAM_K.fy, cx_px: CAM_K.cx, cy_px: CAM_K.cy,
      };
    }),
  };
}

// --- entry -------------------------------------------------------------------------

export const DEMO_ROOM_DIR = fileURLToPath(new URL('../test/fixtures/demo-room/', import.meta.url));
const json = (v: unknown) => `${JSON.stringify(v, null, 2)}\n`;

export function main(outDir = DEMO_ROOM_DIR): void {
  mkdirSync(outDir, { recursive: true });
  const splat = buildSplat();
  writeFileSync(join(outDir, 'splat.ply'), splat);
  writeFileSync(join(outDir, 'collider.ply'), buildCollider());
  writeFileSync(join(outDir, 'floorplan.json'), json(buildFloorplanMeta()));
  writeFileSync(join(outDir, 'cameras.json'), json(buildCameras()));
  ffmpeg(['-f', 'rawvideo', '-pix_fmt', 'gray', '-s', `${PLAN_W}x${PLAN_H}`, '-i', 'pipe:0', '-frames:v', '1', '-bitexact', join(outDir, 'floorplan.png')], planGray());
  ffmpeg(['-f', 'rawvideo', '-pix_fmt', 'rgb24', '-s', '1200x630', '-i', 'pipe:0', '-frames:v', '1', '-q:v', '3', '-bitexact', join(outDir, 'thumbnail.jpg')], thumbRgb());
  console.log(`[demo-room] ${splat.length} B splat -> ${outDir}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
