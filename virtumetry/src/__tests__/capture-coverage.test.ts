import { readFileSync } from 'fs';
import { join } from 'path';

import { coverage, fitToBox, sectorOf, yawDeg } from '@/capture/coverage';
import type { KeyframeEvent } from '@/capture/types';

const FIXTURE = join(__dirname, '../../../backend/test/fixtures/tiny-session/frames.jsonl');
const fixture: KeyframeEvent[] = readFileSync(FIXTURE, 'utf8')
  .split(/\r?\n/)
  .filter((l) => l.trim())
  .map((l) => JSON.parse(l));

/** Column-major T looking along world forward (fx, fz) from position (x, z); -Z column = forward. */
function frame(i: number, x: number, z: number, fx: number, fz: number, fy = 0): KeyframeEvent {
  const T = [1, 0, 0, 0, 0, 1, 0, 0, -fx, -fy, -fz, 0, x, 0, z, 1];
  return { i, file: '', t: i, wallMs: i, T_arkit: T, K: { fx: 1, fy: 1, cx: 0, cy: 0 }, tracking: 'normal' };
}

describe('coverage (D-10)', () => {
  it('fixture: one sector, non-degenerate path, first heading points up', () => {
    const c = coverage(fixture);
    expect(c.seenCount).toBe(1);
    expect(c.sectorsSeen).toHaveLength(12);
    expect(c.sectorsSeen[0]).toBe(true);
    expect(c.rawSpanM).toBeGreaterThanOrEqual(2);
    expect(c.path).toHaveLength(fixture.length);

    const first = coverage(fixture.slice(0, 1)).current!;
    expect(first.dy).toBeLessThan(0);
    expect(Math.abs(first.dx)).toBeLessThan(1e-9);
  });

  it('emits a heading tick every 5th keyframe and tracks the current pose', () => {
    const frames = Array.from({ length: 12 }, (_, k) => frame(k + 1, k * 0.1, 0, 0, -1));
    const c = coverage(frames);
    expect(c.ticks).toHaveLength(2);
    expect(c.current).toEqual({ ...c.path[11], dx: expect.any(Number), dy: expect.any(Number) });
    expect(c.current!.dy).toBeCloseTo(-1);
  });

  it('turning around fills more sectors; looking straight down adds none', () => {
    expect(coverage([frame(1, 0, 0, 0, -1), frame(2, 0, 0, 0, 1)]).seenCount).toBe(2);
    expect(coverage([frame(1, 0, 0, 0, -1), frame(2, 0, 0, 0.1, 0.1, -0.99)]).seenCount).toBe(1);
    expect(yawDeg(frame(1, 0, 0, 0.1, 0.1, -0.99).T_arkit)).toBeNull();
  });

  it('sectorOf matches the backend formula', () => {
    expect(sectorOf(10, 0)).toBe(0);
    expect(sectorOf(16, 0)).toBe(1);
    expect(sectorOf(-16, 0)).toBe(11);
    expect(sectorOf(180, 0)).toBe(6);
  });
});

describe('fitToBox', () => {
  it('uses a 1 m minimum span for a tiny cloud', () => {
    const map = fitToBox([{ x: 0, y: 0 }, { x: 0.1, y: 0.1 }], 72, 1);
    const a = map({ x: 0, y: 0 });
    const b = map({ x: 0.1, y: 0.1 });
    expect(b.x - a.x).toBeCloseTo(7.2);
    expect((a.x + b.x) / 2).toBeCloseTo(36);
  });

  it('keeps aspect for a long thin path and stays inside the box', () => {
    const pts = [{ x: 0, y: 0 }, { x: 2.5, y: 0.1 }];
    const map = fitToBox(pts, 72, 1);
    const [a, b] = pts.map(map);
    expect(b.x - a.x).toBeCloseTo(72);
    expect(b.y - a.y).toBeCloseTo(72 * (0.1 / 2.5));
    for (const p of [a, b]) {
      expect(p.x).toBeGreaterThanOrEqual(0);
      expect(p.x).toBeLessThanOrEqual(72);
      expect(p.y).toBeGreaterThanOrEqual(0);
      expect(p.y).toBeLessThanOrEqual(72);
    }
  });
});
