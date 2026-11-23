// D-06 bundle validation. Pure, never throws: returns named issues so a bad
// capture fails as `failed`/stage `validate` before any credit is spent.

import { MAX_FRAME_BYTES } from '../storage/index.js';
import { cameraCentre, rotationIssues } from './convert.js';
import { jpegSize } from './exif.js';
import type { FrameLine, Session } from './manifest.js';

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

export type BundleIssue = { code: string; message: string };

const pad6 = (i: number) => String(i).padStart(6, '0');

/**
 * Validate a parsed session against D-06. `objects` lists what is actually
 * stored, with keys relative to the capture prefix (e.g. "frames/000001.jpg").
 * Storage keys are always generated from `i`, never taken from the manifest.
 */
export function validateSession(
  session: Session,
  frames: FrameLine[],
  objects: { key: string; size: number }[],
  opts: { minFrames: number; maxFrames: number },
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
    if (!(cx > 0 && cx < w && cy > 0 && cy < h)) add('INTRINSICS_PRINCIPAL_POINT', `${n} principal point outside the image`);

    const rot = rotationIssues(f.T_arkit);
    if (rot.length) add('POSE_INVALID', `${n}: ${rot.join(', ')}`);
    if (f.tracking !== 'normal') add('TRACKING_NOT_NORMAL', `${n} tracking is ${f.tracking}`);

    const prev = frames[k - 1];
    if (prev) {
      if (!(f.wallMs > prev.wallMs)) add('TIMESTAMP_NOT_INCREASING', `${n} wallMs is not after frame ${k}`);
      const a = cameraCentre(prev.T_arkit), b = cameraCentre(f.T_arkit);
      const d = Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]);
      if (!(d <= MAX_CENTRE_JUMP_M)) add('CAMERA_JUMP', `${n} moved ${d.toFixed(3)} m from frame ${k}`);
    }
  });
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
