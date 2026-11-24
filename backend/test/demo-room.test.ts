import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  buildCameras,
  buildCollider,
  buildFloorplanMeta,
  buildSplat,
  CABINET,
  DEMO_ROOM_DIR,
  SPLAT_PROPS,
  TABLE,
} from '../scripts/make-demo-room.js';

type M = number[][];
const read = (f: string) => readFileSync(join(DEMO_ROOM_DIR, f));
const meta = JSON.parse(read('floorplan.json').toString('utf8'));
const { min, max } = meta.scene_bounds as { min: number[]; max: number[] };
const TOL = 0.01;
const inBounds = (p: number[]) => p.every((v, k) => v >= min[k]! - TOL && v <= max[k]! + TOL);
const mul = (A: M, B: M): M => A.map((row) => B[0]!.map((_, c) => row.reduce((s, v, k) => s + v * B[k]![c]!, 0)));
const F: M = [[1, 0, 0, 0], [0, -1, 0, 0], [0, 0, -1, 0], [0, 0, 0, 1]];
function rigidInv(M: M): M {
  const out: M = [];
  for (let r = 0; r < 3; r++) {
    const row = [M[0]![r]!, M[1]![r]!, M[2]![r]!];
    out.push([...row, -(row[0]! * M[0]![3]! + row[1]! * M[1]![3]! + row[2]! * M[2]![3]!)]);
  }
  out.push([0, 0, 0, 1]);
  return out;
}

describe('demo-room fixture', () => {
  it('has every file', () => {
    for (const f of ['splat.ply', 'collider.ply', 'floorplan.png', 'floorplan.json', 'cameras.json', 'thumbnail.jpg', 'README.md']) {
      expect(read(f).length, f).toBeGreaterThan(0);
    }
  });

  it('splat.ply is a 3DGS PLY inside scene_bounds with a flat floor', () => {
    const buf = read('splat.ply');
    expect(buf.length).toBeLessThanOrEqual(5 * 1024 * 1024);
    const end = buf.indexOf('end_header\n') + 'end_header\n'.length;
    const header = buf.subarray(0, end).toString('latin1');
    expect(header).toContain('format binary_little_endian 1.0');
    expect([...header.matchAll(/property float (\w+)/g)].map((m) => m[1])).toEqual(SPLAT_PROPS);
    const n = Number(/element vertex (\d+)/.exec(header)![1]);
    expect(n).toBeGreaterThanOrEqual(60_000);
    expect(n).toBeLessThanOrEqual(120_000);
    const P = SPLAT_PROPS.length;
    expect(buf.length - end).toBe(n * P * 4);
    let floor = 0;
    for (let i = 0; i < n; i++) {
      const f = (p: number) => buf.readFloatLE(end + (i * P + p) * 4);
      const pos = [f(0), f(1), f(2)];
      if (!inBounds(pos)) throw new Error(`splat ${i} out of bounds: ${pos}`);
      // Local +Z rotated by (w, x, y, z) = the face normal; up-facing and low = floor.
      const [w, x, y, z] = [f(10), f(11), f(12), f(13)];
      const ny = 2 * (y * z - w * x);
      if (ny > 0.99 && pos[1]! < 0.5) {
        expect(Math.abs(pos[1]!)).toBeLessThan(1e-6);
        floor++;
      }
    }
    expect(floor).toBeGreaterThan(15_000);
  });

  it('collider.ply is ASCII with faces, all vertices inside scene_bounds', () => {
    const text = read('collider.ply').toString('utf8');
    expect(text).toContain('format ascii 1.0');
    const nv = Number(/element vertex (\d+)/.exec(text)![1]);
    const nf = Number(/element face (\d+)/.exec(text)![1]);
    expect(nf).toBeGreaterThan(0);
    const body = text.split('end_header\n')[1]!.trim().split('\n');
    expect(body).toHaveLength(nv + nf);
    for (const line of body.slice(0, nv)) expect(inBounds(line.split(' ').map(Number)), line).toBe(true);
  });

  it('floorplan.json image affines are exact inverses', () => {
    const A: M = meta.image.world_xz_from_pixel, B: M = meta.image.pixel_from_world_xz;
    const I = mul(A, B);
    I.forEach((row, r) => row.forEach((v, c) => expect(Math.abs(v - (r === c ? 1 : 0))).toBeLessThan(1e-9)));
    const px = mul(B, [[0], [0], [1]]);
    const back = mul(A, px);
    expect(Math.abs(back[0]![0]!)).toBeLessThan(1e-9);
    expect(Math.abs(back[1]![0]!)).toBeLessThan(1e-9);
    expect(meta.image.width_px * meta.image.meters_per_pixel).toBeCloseTo(max[0]! - min[0]!, 9);
    expect(meta.image.height_px * meta.image.meters_per_pixel).toBeCloseTo(max[2]! - min[2]!, 9);
  });

  it('cameras.json frames sit inside the room at eye height, clear of the furniture', () => {
    const cams = JSON.parse(read('cameras.json').toString('utf8'));
    expect(cams.schema_version).toBe('spaitial.capture_cameras.v1');
    expect(cams.coordinate_system).toBe('opencv');
    expect(cams.frames.length).toBe(cams.source_frame_count);
    const outside = (x: number, z: number, b: { min: number[]; max: number[] }) =>
      x < b.min[0]! || x > b.max[0]! || z < b.min[2]! || z > b.max[2]!;
    for (const fr of cams.frames) {
      const T = mul(mul(F, rigidInv(fr.camera_from_splat)), F); // three camera matrixWorld
      const c = [T[0]![3]!, T[1]![3]!, T[2]![3]!];
      expect(c[1]).toBeCloseTo(1.5, 6);
      expect(inBounds(c)).toBe(true);
      expect(outside(c[0]!, c[2]!, TABLE) && outside(c[0]!, c[2]!, CABINET)).toBe(true);
      // GL camera looks down -Z: the view direction must point roughly at the room centre.
      const fwd = [-T[0]![2]!, -T[1]![2]!, -T[2]![2]!];
      expect(fwd[0]! * -c[0]! + fwd[2]! * -c[2]!).toBeGreaterThan(0);
    }
  });

  // Determinism without ffmpeg (CI has none): the pure builders must reproduce the committed bytes.
  it('builders reproduce the committed files byte-for-byte', () => {
    const json = (v: unknown) => `${JSON.stringify(v, null, 2)}\n`;
    expect(buildSplat().equals(read('splat.ply'))).toBe(true);
    expect(buildCollider()).toBe(read('collider.ply').toString('utf8'));
    expect(json(buildFloorplanMeta())).toBe(read('floorplan.json').toString('utf8'));
    expect(json(buildCameras())).toBe(read('cameras.json').toString('utf8'));
  });
});
