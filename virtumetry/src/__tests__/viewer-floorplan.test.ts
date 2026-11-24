/// <reference types="node" />
import { readFileSync } from 'fs';
import { join } from 'path';

import {
  applyAffine,
  hasFloorplan,
  headingAngle,
  pixelFromWorld,
  tapToPixel,
  worldFromPixel,
} from '@/viewer/floorplan';
import type { FloorplanMeta } from '@/viewer/types';

const fixture = (name: string) =>
  JSON.parse(
    readFileSync(join(__dirname, `../../../backend/test/fixtures/${name}/floorplan.json`), 'utf8'),
  ) as FloorplanMeta & { image: NonNullable<FloorplanMeta['image']>; scene_bounds: { min: number[]; max: number[] } };

const DEMO = fixture('demo-room');
const MOCK = fixture('mock-outputs');

describe.each([
  ['demo-room', DEMO],
  ['mock-outputs', MOCK],
])('floorplan affines (%s)', (_name, meta) => {
  it('world → pixel → world round-trips', () => {
    for (const [x, z] of [
      [0, 0],
      [0.5, -1.2],
      [-1.1, 0.9],
      [1.3, 1.3],
    ]) {
      const [px, py] = pixelFromWorld(meta, x, z);
      const [x2, z2] = worldFromPixel(meta, px, py);
      expect(x2).toBeCloseTo(x, 9);
      expect(z2).toBeCloseTo(z, 9);
    }
  });

  it('a tap on the displayed image at world (0.5, 0) lands inside scene_bounds', () => {
    const [px, py] = pixelFromWorld(meta, 0.5, 0);
    const clientW = 280;
    const clientH = (280 * meta.image.height_px) / meta.image.width_px;
    const [tx, ty] = tapToPixel(
      (px / meta.image.width_px) * clientW,
      (py / meta.image.height_px) * clientH,
      clientW,
      clientH,
      meta,
    );
    const [x, z] = worldFromPixel(meta, tx, ty);
    expect(x).toBeCloseTo(0.5, 9);
    expect(z).toBeCloseTo(0, 9);
    const { min, max } = meta.scene_bounds;
    expect(x).toBeGreaterThanOrEqual(min[0]);
    expect(x).toBeLessThanOrEqual(max[0]);
    expect(z).toBeGreaterThanOrEqual(min[2]);
    expect(z).toBeLessThanOrEqual(max[2]);
  });

  it('heading: forward (0,0,-1) = atan2 of the linear part applied to (0,-1)', () => {
    const [[a, b], [c, d]] = meta.image.pixel_from_world_xz;
    expect(headingAngle(meta, 0, -1)).toBeCloseTo(Math.atan2(c * 0 + d * -1, a * 0 + b * -1), 12);
  });

  it('hasFloorplan sees the affines', () => expect(hasFloorplan(meta)).toBe(true));
});

describe('floorplan helpers', () => {
  it('demo-room world (0,0) is the image centre ±1 px', () => {
    const [px, py] = pixelFromWorld(DEMO, 0, 0);
    expect(Math.abs(px - DEMO.image.width_px / 2)).toBeLessThanOrEqual(1);
    expect(Math.abs(py - DEMO.image.height_px / 2)).toBeLessThanOrEqual(1);
  });

  it('tapToPixel scales to image pixels without +0.5', () => {
    expect(tapToPixel(0, 0, 100, 125, DEMO)).toEqual([0, 0]);
    expect(tapToPixel(50, 62.5, 100, 125, DEMO)).toEqual([100, 125]);
  });

  it('applyAffine uses the row-major 3x3', () => {
    expect(applyAffine([[2, 0, 1], [0, 3, -1], [0, 0, 1]], 1, 1)).toEqual([3, 2]);
  });

  it('hasFloorplan rejects missing or malformed meta (T-05-24)', () => {
    expect(hasFloorplan(null)).toBe(false);
    expect(hasFloorplan(undefined)).toBe(false);
    expect(hasFloorplan({ scene_bounds: DEMO.scene_bounds })).toBe(false);
    expect(
      hasFloorplan({ image: { ...DEMO.image, pixel_from_world_xz: [[1, 0]] } } as unknown as FloorplanMeta),
    ).toBe(false);
    expect(hasFloorplan({ image: { ...DEMO.image, width_px: 0 } })).toBe(false);
  });
});
