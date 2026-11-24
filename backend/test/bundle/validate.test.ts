import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';
import { SessionV1, parseFramesJsonl, type FrameLine, type Session } from '../../src/bundle/manifest.js';
import {
  validateFrameImage,
  validateSession,
  yawSectorCount,
  forwardMotionMedianDeg,
  frameYawDeg,
  BLUR_PX_THRESHOLD,
  YAW_SECTORS,
  MIN_HORIZONTAL_FORWARD,
  MAX_FORWARD_MOTION_DEG,
  MIN_SEGMENT_MOVE_M,
  MIN_MOVING_SEGMENTS,
  PRINCIPAL_POINT_TOLERANCE,
  MAX_FOCAL_ASPECT_DEVIATION,
  MAX_CENTRE_JUMP_M,
} from '../../src/bundle/validate.js';
import type { PrecheckRules } from '../../src/capture-config.js';
import { withExif } from '../../src/bundle/exif.js';
import { MAX_FRAME_BYTES } from '../../src/storage/index.js';

const DIR = fileURLToPath(new URL('../fixtures/tiny-session/', import.meta.url));
const session0 = SessionV1.parse(JSON.parse(readFileSync(join(DIR, 'session.json'), 'utf8')));
const frames0 = parseFramesJsonl(readFileSync(join(DIR, 'frames.jsonl'), 'utf8'));
const objects0 = readdirSync(join(DIR, 'frames')).map((f) => ({ key: `frames/${f}`, size: statSync(join(DIR, 'frames', f)).size }));
const firstJpeg = readFileSync(join(DIR, 'frames', '000001.jpg'));
/** The dev CAPTURE_CONFIG_JSON precheck merged over the defaults (test/helpers/pipeline.ts). */
const DEV_RULES: PrecheckRules = { minFrames: 20, maxBlurShare: 0.25, maxTrackingGapShare: 0, minCoverageSectors: 1 };
const OPTS = { minFrames: 1, maxFrames: 5000, rules: DEV_RULES };

const clone = <T>(v: T): T => structuredClone(v);
const codes = (issues: { code: string }[]) => [...new Set(issues.map((i) => i.code))];

function run(mut: (s: Session, f: FrameLine[], o: { key: string; size: number }[]) => void, opts = OPTS) {
  const s = clone(session0), f = clone(frames0), o = clone(objects0);
  mut(s, f, o);
  return codes(validateSession(s, f, o, opts));
}

describe('validateSession: fixture', () => {
  it('the committed tiny-session passes with zero issues', () => {
    expect(frames0.length).toBeGreaterThanOrEqual(24);
    expect(validateSession(session0, frames0, objects0, OPTS)).toEqual([]);
  });
  it('every fixture JPEG passes validateFrameImage', () => {
    for (const { key } of objects0) {
      expect(validateFrameImage(readFileSync(join(DIR, key)), session0)).toEqual([]);
    }
  });
});

describe('validateSession: one failing rule per code', () => {
  it('FRAME_COUNT_OUT_OF_RANGE', () => {
    expect(run(() => {}, { ...OPTS, minFrames: 1, maxFrames: 10 })).toEqual(['FRAME_COUNT_OUT_OF_RANGE']);
    expect(run(() => {}, { ...OPTS, minFrames: 31, maxFrames: 100 })).toEqual(['FRAME_COUNT_OUT_OF_RANGE']);
    expect(run((_, f) => { f.splice(8); }, { ...OPTS, minFrames: 20 })).toEqual(['FRAME_COUNT_OUT_OF_RANGE']);
  });
  it('FRAME_INDEX_GAP (not 1-indexed / not contiguous)', () => {
    expect(run((_, f) => { f[3]!.i = 99; f[3]!.file = 'frames/000099.jpg'; })).toContain('FRAME_INDEX_GAP');
  });
  it('FRAME_FILE_MISMATCH including path traversal', () => {
    expect(run((_, f) => { f[0]!.file = '../x'; })).toEqual(['FRAME_FILE_MISMATCH']);
    expect(run((_, f) => { f[1]!.file = 'frames/000001.jpg'; })).toEqual(['FRAME_FILE_MISMATCH']);
  });
  it('FRAME_OBJECT_MISSING', () => {
    expect(run((_, __, o) => { o.splice(4, 1); })).toEqual(['FRAME_OBJECT_MISSING']);
  });
  it('FRAME_TOO_LARGE', () => {
    expect(run((_, __, o) => { o[0]!.size = MAX_FRAME_BYTES + 1; })).toEqual(['FRAME_TOO_LARGE']);
  });
  it('TIMESTAMP_NOT_INCREASING', () => {
    expect(run((_, f) => { f[5]!.wallMs = f[4]!.wallMs; })).toEqual(['TIMESTAMP_NOT_INCREASING']);
  });
  it('IMAGE_LONG_EDGE', () => {
    expect(run((s) => { s.imageWidth = 2000; })).toEqual(['IMAGE_LONG_EDGE']);
  });
  it('IMAGE_SHORT_EDGE', () => {
    expect(run((s) => { s.imageHeight = 300; })).toEqual(['IMAGE_SHORT_EDGE']);
  });
  it('INTRINSICS_FOCAL_RANGE', () => {
    expect(run((_, f) => { f[0]!.K.fx = 50; })).toEqual(['INTRINSICS_FOCAL_RANGE']);
    expect(run((_, f) => { f[0]!.K.fy = 20000; })).toEqual(['INTRINSICS_FOCAL_RANGE']);
  });
  it('INTRINSICS_PRINCIPAL_POINT', () => {
    expect(run((_, f) => { f[0]!.K.cx = 640; })).toEqual(['INTRINSICS_PRINCIPAL_POINT']);
    expect(run((_, f) => { f[0]!.K.cy = 0; })).toEqual(['INTRINSICS_PRINCIPAL_POINT']);
  });
  it('POSE_INVALID (scaled rotation / bad bottom row)', () => {
    expect(run((_, f) => { f[0]!.T_arkit[0]! *= 2; })).toEqual(['POSE_INVALID']);
    expect(run((_, f) => { f[0]!.T_arkit[3] = 0.5; })).toEqual(['POSE_INVALID']);
  });
  it('CAMERA_JUMP', () => {
    expect(run((_, f) => { f[10]!.T_arkit[12]! += MAX_CENTRE_JUMP_M * 3; })).toEqual(['CAMERA_JUMP']);
  });
  it('TRACKING_GAP: one issue for the whole gap, not one per frame', () => {
    const s = clone(session0), f = clone(frames0);
    for (let k = 9; k < 17; k++) f[k]!.tracking = 'limited'; // frames 10..17
    const issues = validateSession(s, f, objects0, OPTS);
    expect(issues.map((i) => i.code)).toEqual(['TRACKING_GAP']);
    // A tolerant share lets the same gap through (8/30 = 0.27).
    expect(run((_, g) => { for (let k = 9; k < 17; k++) g[k]!.tracking = 'limited'; },
      { ...OPTS, rules: { ...DEV_RULES, maxTrackingGapShare: 0.3 } })).toEqual([]);
  });
  it('never throws on degenerate input', () => {
    expect(() => validateSession(session0, [], [], OPTS)).not.toThrow();
    expect(codes(validateSession(session0, [], [], OPTS))).toEqual(['FRAME_COUNT_OUT_OF_RANGE']);
  });
  it('messages carry the frame index', () => {
    const s = clone(session0), f = clone(frames0);
    f[2]!.K.cx = 1;
    expect(validateSession(s, f, objects0, OPTS)[0]!.message).toMatch(/frame 3/);
  });
});

describe('validateSession: D-16 device and semantic rules', () => {
  it('good fixture with the dev rules → no issues', () => {
    expect(validateSession(session0, frames0, objects0, { minFrames: 20, maxFrames: 5000, rules: DEV_RULES })).toEqual([]);
  });
  it('walking backwards (reversed poses) → exactly FORWARD_MOTION_MISMATCH', () => {
    const got = run((_, f) => {
      const poses = f.map((x) => x.T_arkit).reverse();
      f.forEach((x, k) => { x.T_arkit = poses[k]!; });
    });
    expect(got).toEqual(['FORWARD_MOTION_MISMATCH']);
  });
  it('+0.6 m x from frame 15 → exactly CAMERA_JUMP', () => {
    expect(run((_, f) => { for (let k = 14; k < f.length; k++) f[k]!.T_arkit[12]! += 0.6; })).toEqual(['CAMERA_JUMP']);
  });
  it('BLUR_SHARE: 9 of 30 frames over the blur threshold; exactly 64 px is not blurry', () => {
    expect(run((_, f) => { for (let k = 0; k < 9; k++) f[k]!.blurPx = 80; })).toEqual(['BLUR_SHARE']);
    expect(run((_, f) => { f.forEach((x) => { x.blurPx = BLUR_PX_THRESHOLD; }); })).toEqual([]);
  });
  it('COVERAGE_LOW: the fixture covers one yaw sector', () => {
    expect(yawSectorCount(frames0)).toBe(1);
    expect(run(() => {}, { ...OPTS, rules: { ...DEV_RULES, minCoverageSectors: 2 } })).toEqual(['COVERAGE_LOW']);
  });
  it('yawSectorCount counts a full turn as 12 sectors', () => {
    const turn = Array.from({ length: 24 }, (_, k) => {
      const a = (k * 15 * Math.PI) / 180;
      // world_from_camera, column-major rotation about +Y by a
      return { ...frames0[0]!, T_arkit: [Math.cos(a), 0, -Math.sin(a), 0, 0, 1, 0, 0, Math.sin(a), 0, Math.cos(a), 0, 0, 0, 0, 1] };
    });
    expect(yawSectorCount(turn)).toBe(YAW_SECTORS);
    const y0 = frameYawDeg(turn[0]!.T_arkit)!, y2 = frameYawDeg(turn[2]!.T_arkit)!;
    expect((((y0 - y2) % 360) + 360) % 360).toBeCloseTo(30);
  });
  it('frameYawDeg is null when looking straight down', () => {
    expect(frameYawDeg([1, 0, 0, 0, 0, 0, -1, 0, 0, 1, 0, 0, 0, 0, 0, 1])).toBeNull();
  });
  it('forwardMotionMedianDeg is small for the fixture and null with too few moving segments', () => {
    expect(forwardMotionMedianDeg(frames0)!).toBeLessThan(15);
    expect(forwardMotionMedianDeg(frames0.slice(0, 3))).toBeNull();
  });
  it('INTRINSICS_PRINCIPAL_POINT outside the ±25 % centre band', () => {
    expect(run((s, f) => { f[0]!.K.cx = 0.8 * s.imageWidth; })).toEqual(['INTRINSICS_PRINCIPAL_POINT']);
  });
  it('INTRINSICS_ASPECT when fy = 1.2 fx', () => {
    expect(run((_, f) => { f[0]!.K.fy = f[0]!.K.fx * 1.2; })).toEqual(['INTRINSICS_ASPECT']);
  });
  it('pins the constants', () => {
    expect({
      BLUR_PX_THRESHOLD, YAW_SECTORS, MIN_HORIZONTAL_FORWARD, MAX_FORWARD_MOTION_DEG, MIN_SEGMENT_MOVE_M,
      MIN_MOVING_SEGMENTS, PRINCIPAL_POINT_TOLERANCE, MAX_FOCAL_ASPECT_DEVIATION, MAX_CENTRE_JUMP_M,
    }).toEqual({
      BLUR_PX_THRESHOLD: 64, YAW_SECTORS: 12, MIN_HORIZONTAL_FORWARD: 0.3, MAX_FORWARD_MOTION_DEG: 120,
      MIN_SEGMENT_MOVE_M: 0.02, MIN_MOVING_SEGMENTS: 5, PRINCIPAL_POINT_TOLERANCE: 0.25,
      MAX_FOCAL_ASPECT_DEVIATION: 0.1, MAX_CENTRE_JUMP_M: 0.5,
    });
  });
});

describe('validateFrameImage', () => {
  it('IMAGE_SIZE_MISMATCH', () => {
    expect(codes(validateFrameImage(firstJpeg, { ...session0, imageWidth: 1920, imageHeight: 1440 }))).toEqual(['IMAGE_SIZE_MISMATCH']);
  });
  it('EXIF_ALREADY_PRESENT', () => {
    expect(codes(validateFrameImage(withExif(firstJpeg, 1, '+00:00'), session0))).toEqual(['EXIF_ALREADY_PRESENT']);
  });
  it('never throws on garbage', () => {
    expect(() => validateFrameImage(Buffer.from('not a jpeg'), session0)).not.toThrow();
    expect(validateFrameImage(Buffer.alloc(0), session0).length).toBeGreaterThan(0);
  });
});
