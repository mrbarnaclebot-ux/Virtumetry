// D-06 bundle validation. Pure, never throws: returns named issues so a bad
// capture fails as `failed`/stage `validate` before any credit is spent.

import { MAX_FRAME_BYTES } from '../storage/index.js';
import { cameraCentre, rotationIssues } from './convert.js';
import { jpegSize } from './exif.js';
import type { FrameLine, Session } from './manifest.js';
import type { PrecheckRules } from '../capture-config.js';

/** D-06 / Echo-3 docs: image long edge must be at most this many pixels. */
export const MAX_LONG_EDGE = 1920;
/** D-06 / Echo-3 docs: image short edge must be at least this many pixels. */
export const MIN_SHORT_EDGE = 360;
/** D-06 / Echo-3 docs: fx and fy lower bound (pixels). */
export const MIN_F = 100;
/** D-06 / Echo-3 docs: fx and fy upper bound (pixels). */
export const MAX_F = 10000;
/** D-06 semantic check: adjacent camera centres further apart than this (metres) mean a tracking jump. */
export const MAX_CENTRE_JUMP_M = 0.5;

/** D-16(a): a frame whose predicted blur (blurPx) is above this many pixels counts as blurry. */
export const BLUR_PX_THRESHOLD = 64;
/** D-16(a): yaw coverage is counted in this many 30-degree sectors (app coverage.ts uses the same). */
export const YAW_SECTORS = 12;
/** Horizontal length of the camera forward below which yaw is undefined (looking up/down). */
export const MIN_HORIZONTAL_FORWARD = 0.3;
/** D-16(c): median XZ angle between camera forward and travel above this means walking backwards. */
export const MAX_FORWARD_MOTION_DEG = 120;
/** D-16(c): segments that move less than this (metres, XZ) are jitter and skipped. */
export const MIN_SEGMENT_MOVE_M = 0.02;
/** D-16(c): fewer moving segments than this and the forward-motion rule does not apply. */
export const MIN_MOVING_SEGMENTS = 5;
/** D-16(d): cx, cy must lie within this fraction of width/height from the image centre. */
export const PRINCIPAL_POINT_TOLERANCE = 0.25;
/** D-16(d): |fx/fy - 1| above this is a broken intrinsics matrix. */
export const MAX_FOCAL_ASPECT_DEVIATION = 0.1;

export type BundleIssue = { code: string; message: string };

const pad6 = (i: number) => String(i).padStart(6, '0');
const DEG = 180 / Math.PI;

/** Yaw (degrees) of the camera forward (-Z column) in the world XZ plane; null when looking near vertical. */
export function frameYawDeg(T: number[]): number | null {
  if (Math.hypot(T[8]!, T[10]!) < MIN_HORIZONTAL_FORWARD) return null;
  return Math.atan2(-T[8]!, -T[10]!) * DEG;
}

/** Distinct 30-degree yaw sectors, the first centred on the first defined look direction. */
export function yawSectorCount(frames: FrameLine[]): number {
  const sectors = new Set<number>();
  let yaw0: number | null = null;
  for (const f of frames) {
    const y = frameYawDeg(f.T_arkit);
    if (y === null) continue;
    yaw0 ??= y;
    const d = (((y - yaw0 + 180 / YAW_SECTORS) % 360) + 360) % 360;
    sectors.add(Math.floor(d / (360 / YAW_SECTORS)));
  }
  return sectors.size;
}

/** D-16(c): median XZ angle between camera forward and travel, moving segments only; null if too few. */
export function forwardMotionMedianDeg(frames: FrameLine[]): number | null {
  const a: number[] = [];
  for (let k = 1; k < frames.length; k++) {
    const p = frames[k - 1]!.T_arkit, T = frames[k]!.T_arkit;
    const mx = T[12]! - p[12]!, mz = T[14]! - p[14]!, mn = Math.hypot(mx, mz);
    const fx = -T[8]!, fz = -T[10]!, fn = Math.hypot(fx, fz);
    if (mn < MIN_SEGMENT_MOVE_M || fn < MIN_HORIZONTAL_FORWARD) continue;
    a.push(Math.acos(Math.max(-1, Math.min(1, (fx * mx + fz * mz) / (mn * fn)))) * DEG);
  }
  if (a.length < MIN_MOVING_SEGMENTS) return null;
  a.sort((x, y) => x - y);
  return a[Math.floor(a.length / 2)]!;
}

/**
 * Validate a parsed session against D-06. `objects` lists what is actually
 * stored, with keys relative to the capture prefix (e.g. "frames/000001.jpg").
 * Storage keys are always generated from `i`, never taken from the manifest.
 */
export function validateSession(
  session: Session,
  frames: FrameLine[],
  objects: { key: string; size: number }[],
  opts: { minFrames: number; maxFrames: number; rules: PrecheckRules },
): BundleIssue[] {
  const issues: BundleIssue[] = [];
  const add = (code: string, message: string) => issues.push({ code, message });

  if (frames.length < opts.minFrames || frames.length > opts.maxFrames) {
    add('FRAME_COUNT_OUT_OF_RANGE', `${frames.length} frames, allowed ${opts.minFrames}..${opts.maxFrames}`);
  }

  const w = session.imageWidth, h = session.imageHeight;
  if (Math.max(w, h) > MAX_LONG_EDGE) add('IMAGE_LONG_EDGE', `long edge ${Math.max(w, h)} > ${MAX_LONG_EDGE}`);
  if (Math.min(w, h) < MIN_SHORT_EDGE) add('IMAGE_SHORT_EDGE', `short edge ${Math.min(w, h)} < ${MIN_SHORT_EDGE}`);

  const sizes = new Map(objects.map((o) => [o.key, o.size]));
  frames.forEach((f, k) => {
    const n = `frame ${k + 1}`;
    if (f.i !== k + 1) add('FRAME_INDEX_GAP', `${n} has index ${f.i}`);
    const key = `frames/${pad6(k + 1)}.jpg`;
    if (f.file !== key) add('FRAME_FILE_MISMATCH', `${n} file is not ${key}`);
    const size = sizes.get(key);
    if (size === undefined) add('FRAME_OBJECT_MISSING', `${n} image not uploaded`);
    else if (size > MAX_FRAME_BYTES) add('FRAME_TOO_LARGE', `${n} is ${size} bytes > ${MAX_FRAME_BYTES}`);

    const { fx, fy, cx, cy } = f.K;
    if (!(fx >= MIN_F && fx <= MAX_F && fy >= MIN_F && fy <= MAX_F)) {
      add('INTRINSICS_FOCAL_RANGE', `${n} fx/fy outside [${MIN_F}, ${MAX_F}]`);
    }
    const tol = PRINCIPAL_POINT_TOLERANCE;
    if (!(Math.abs(cx - w / 2) <= tol * w && Math.abs(cy - h / 2) <= tol * h)) {
      add('INTRINSICS_PRINCIPAL_POINT', `${n} principal point more than ${tol * 100}% from the image centre`);
    }
    if (!(Math.abs(fx / fy - 1) <= MAX_FOCAL_ASPECT_DEVIATION)) {
      add('INTRINSICS_ASPECT', `${n} fx/fy ${(fx / fy).toFixed(3)} deviates more than ${MAX_FOCAL_ASPECT_DEVIATION * 100}%`);
    }

    const rot = rotationIssues(f.T_arkit);
    if (rot.length) add('POSE_INVALID', `${n}: ${rot.join(', ')}`);

    const prev = frames[k - 1];
    if (prev) {
      if (!(f.wallMs > prev.wallMs)) add('TIMESTAMP_NOT_INCREASING', `${n} wallMs is not after frame ${k}`);
      const a = cameraCentre(prev.T_arkit), b = cameraCentre(f.T_arkit);
      const d = Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]);
      if (!(d <= MAX_CENTRE_JUMP_M)) add('CAMERA_JUMP', `${n} moved ${d.toFixed(3)} m from frame ${k}`);
    }
  });

  // Share and semantic rules (D-16): at most one issue each.
  const { rules } = opts;
  if (frames.length) {
    const share = (pred: (f: FrameLine) => boolean) => frames.filter(pred).length / frames.length;
    const gap = share((f) => f.tracking !== 'normal');
    if (gap > rules.maxTrackingGapShare) {
      add('TRACKING_GAP', `${(gap * 100).toFixed(0)}% of frames lost tracking, allowed ${(rules.maxTrackingGapShare * 100).toFixed(0)}%`);
    }
    const blur = share((f) => (f.blurPx ?? 0) > BLUR_PX_THRESHOLD);
    if (blur > rules.maxBlurShare) {
      add('BLUR_SHARE', `${(blur * 100).toFixed(0)}% of frames blurry, allowed ${(rules.maxBlurShare * 100).toFixed(0)}%`);
    }
    const sectors = yawSectorCount(frames);
    if (sectors < rules.minCoverageSectors) add('COVERAGE_LOW', `${sectors} of ${YAW_SECTORS} sectors covered, need ${rules.minCoverageSectors}`);
    const median = forwardMotionMedianDeg(frames);
    if (median !== null && median > MAX_FORWARD_MOTION_DEG) {
      add('FORWARD_MOTION_MISMATCH', `median forward-vs-travel angle ${median.toFixed(0)} deg > ${MAX_FORWARD_MOTION_DEG}`);
    }
  }
  return issues;
}

/** Per-image D-06 checks on the stored JPEG bytes (dimensions, no pre-existing EXIF). */
export function validateFrameImage(jpeg: Buffer, session: Session): BundleIssue[] {
  const issues: BundleIssue[] = [];
  try {
    const { w, h } = jpegSize(jpeg);
    if (w !== session.imageWidth || h !== session.imageHeight) {
      issues.push({ code: 'IMAGE_SIZE_MISMATCH', message: `image is ${w}x${h}, session says ${session.imageWidth}x${session.imageHeight}` });
    }
  } catch {
    issues.push({ code: 'IMAGE_SIZE_MISMATCH', message: 'not a readable JPEG (no SOF marker)' });
  }
  // Scan leading marker segments up to SOS for an APP1 "Exif\0\0" (we insert our own at pack time).
  let p = 2;
  while (jpeg.length >= 4 && jpeg.readUInt16BE(0) === 0xffd8 && p + 4 <= jpeg.length && jpeg[p] === 0xff) {
    const mk = jpeg[p + 1]!;
    if (mk === 0xda || mk === 0xd9) break;
    if (mk === 0xe1 && jpeg.toString('latin1', p + 4, p + 10) === 'Exif\0\0') {
      issues.push({ code: 'EXIF_ALREADY_PRESENT', message: 'image already has an EXIF APP1 segment' });
      break;
    }
    p += 2 + jpeg.readUInt16BE(p + 2);
  }
  return issues;
}
