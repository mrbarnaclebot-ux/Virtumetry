// D-04/D-07: stored session (captures/{cid}/) → store-only Echo-3 bundle ZIP
// streamed into bundles/{cid}/capture_bundle.zip. One frame in memory at a time.

import { Readable } from 'node:stream';
import yazl from 'yazl';
import { bundleKeyFor, captureKey, type StorageDriver } from '../storage/index.js';
import { arkitToOpenCV } from './convert.js';
import { EXIF_APP1_BYTES, withExif } from './exif.js';
import { SessionV1, parseFramesJsonl, type FrameLine, type Session } from './manifest.js';
import { validateFrameImage, validateSession, type BundleIssue } from './validate.js';

export class BundleInvalidError extends Error {
  constructor(readonly issues: BundleIssue[]) {
    super(`bundle invalid: ${issues.map((i) => i.code).join(', ')}`);
    this.name = 'BundleInvalidError';
  }
}

const pad6 = (i: number) => String(i).padStart(6, '0');

async function readManifest(storage: StorageDriver, cid: string): Promise<{ session: Session; frames: FrameLine[] }> {
  const [sessionBuf, framesBuf] = await Promise.all([
    storage.getObject(captureKey(cid, 'session.json')),
    storage.getObject(captureKey(cid, 'frames.jsonl')),
  ]);
  try {
    return { session: SessionV1.parse(JSON.parse(sessionBuf.toString('utf8'))), frames: parseFramesJsonl(framesBuf.toString('utf8')) };
  } catch (e) {
    throw new BundleInvalidError([{ code: 'MANIFEST_INVALID', message: e instanceof Error ? e.message : String(e) }]);
  }
}

export async function packCapture(
  storage: StorageDriver,
  captureId: string,
  opts: { minFrames: number; maxFrames: number; onProgress?: () => Promise<void> },
): Promise<{ bundleKey: string; bundleBytes: number; manifestKey: string; frameCount: number; imageW: number; imageH: number }> {
  const { session, frames } = await readManifest(storage, captureId);
  const prefix = captureKey(captureId, '');
  const objects = (await storage.list(captureKey(captureId, 'frames/'))).map((o) => ({ key: o.key.slice(prefix.length), size: o.size }));
  const issues = validateSession(session, frames, objects, opts);
  if (issues.length) throw new BundleInvalidError(issues);
  const sizes = new Map(objects.map((o) => [o.key, o.size]));

  const zip = new yazl.ZipFile();
  const intrinsics = {
    frame_count: frames.length,
    width_px: session.imageWidth,
    height_px: session.imageHeight,
    fx_px: frames.map((f) => f.K.fx),
    fy_px: frames.map((f) => f.K.fy),
    cx_px: frames.map((f) => f.K.cx),
    cy_px: frames.map((f) => f.K.cy),
  };
  // [N][4][4] nested row-major (Pitfall 2), never flat.
  const trajectory = frames.map((f) => arkitToOpenCV(f.T_arkit));
  zip.addBuffer(Buffer.from(JSON.stringify(intrinsics)), 'cameras/per_frame_intrinsics.json', { compress: false });
  zip.addBuffer(Buffer.from(JSON.stringify(trajectory)), 'cameras/camera_trajectory.json', { compress: false });

  // Entry names come from the validated index, never from the manifest (T-02-12).
  frames.forEach((f, k) => {
    const rel = `frames/${pad6(k + 1)}.jpg`;
    zip.addReadStreamLazy(
      `images/Image_${pad6(k + 1)}.jpg`,
      { compress: false, size: sizes.get(rel)! + EXIF_APP1_BYTES },
      (cb) => {
        (async () => {
          const jpg = await storage.getObject(captureKey(captureId, rel));
          const bad = validateFrameImage(jpg, session);
          if (bad.length) throw new BundleInvalidError(bad);
          const out = withExif(jpg, f.wallMs, session.tzOffset);
          await opts.onProgress?.(); // job heartbeat
          return out;
        })().then((buf) => cb(null, Readable.from([buf])), (e: Error) => cb(e, null as unknown as Readable));
      },
    );
  });

  let bundleBytes = -1;
  // yazl passes calculatedTotalSize (exact for stored + sized entries); @types/yazl omits the arg.
  zip.end({ forceZip64Format: false, comment: '' }, ((n: number) => { bundleBytes = n; }) as unknown as () => void);
  const bundleKey = bundleKeyFor(captureId);
  const upload = storage.putStream(bundleKey, zip.outputStream as Readable, 'application/zip');
  // Pitfall 10: a lazy-entry error lands on the ZipFile; without abort the upload waits forever.
  let zipErr: unknown;
  const failed = new Promise<never>((_, reject) => {
    zip.on('error', (e: unknown) => { zipErr = e; upload.abort(e); reject(e); });
  });
  failed.catch(() => undefined);
  try {
    await Promise.race([upload.done, failed]);
  } catch (e) {
    await upload.done.catch(() => undefined);
    await storage.deleteObject(bundleKey).catch(() => undefined);
    throw zipErr ?? e;
  }

  return {
    bundleKey,
    bundleBytes,
    manifestKey: captureKey(captureId, 'frames.jsonl'),
    frameCount: frames.length,
    imageW: session.imageWidth,
    imageH: session.imageHeight,
  };
}
