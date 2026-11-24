import { promises as fs, readFileSync, readdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createLocalStorage, type LocalStorage } from '../../src/storage/local.js';
import { captureKey, bundleKeyFor } from '../../src/storage/index.js';
import { packCapture, validateStored, BundleInvalidError, MANIFEST_MAX_BYTES } from '../../src/bundle/pack.js';
import { parseFramesJsonl } from '../../src/bundle/manifest.js';
import { arkitToOpenCV } from '../../src/bundle/convert.js';
import { readCentralDirectory, readEntry, type ReadRange } from '../../src/bundle/zipread.js';
import { captureExifTimestampSeconds, readCaptureExif } from '../helpers/capture-exif.js';
import type { Config } from '../../src/config.js';

const FIX = fileURLToPath(new URL('../fixtures/tiny-session/', import.meta.url));
const frames = parseFramesJsonl(readFileSync(path.join(FIX, 'frames.jsonl'), 'utf8'));
const N = frames.length;
const DEV_RULES = { minFrames: 20, maxBlurShare: 0.25, maxTrackingGapShare: 0, minCoverageSectors: 1 };
const OPTS = { minFrames: 1, maxFrames: 5000, rules: DEV_RULES };

let dir: string;
let storage: LocalStorage;

async function upload(cid: string) {
  await storage.putObject(captureKey(cid, 'session.json'), readFileSync(path.join(FIX, 'session.json')));
  await storage.putObject(captureKey(cid, 'frames.jsonl'), readFileSync(path.join(FIX, 'frames.jsonl')));
  for (const f of readdirSync(path.join(FIX, 'frames'))) {
    await storage.putObject(captureKey(cid, `frames/${f}`), readFileSync(path.join(FIX, 'frames', f)));
  }
}

function fileRange(file: string): ReadRange {
  return async (a, b) => {
    const fh = await fs.open(file, 'r');
    try {
      const buf = Buffer.alloc(b - a + 1);
      await fh.read(buf, 0, buf.length, a);
      return buf;
    } finally {
      await fh.close();
    }
  };
}

beforeAll(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'virtumetry-pack-'));
  storage = createLocalStorage({ LOCAL_STORAGE_DIR: dir, PUBLIC_BASE_URL: 'http://localhost:8080' } as unknown as Config);
});
afterAll(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

describe('packCapture (local driver)', () => {
  it('packs the fixture into a store-only Echo-3 bundle', async () => {
    const cid = randomUUID();
    await upload(cid);
    let beats = 0;
    const res = await packCapture(storage, cid, { ...OPTS, onProgress: async () => { beats++; } });
    expect(res).toMatchObject({ bundleKey: bundleKeyFor(cid), manifestKey: captureKey(cid, 'frames.jsonl'), frameCount: N, imageW: 640, imageH: 480 });
    expect(beats).toBe(N);

    const file = storage.resolvePath(res.bundleKey);
    const total = (await fs.stat(file)).size;
    expect(res.bundleBytes).toBe(total);
    expect((await storage.list(`bundles/${cid}/`))).toEqual([{ key: res.bundleKey, size: total }]);

    const read = fileRange(file);
    const entries = await readCentralDirectory(total, read);
    const names = entries.map((e) => e.name);
    const imgs = frames.map((_, k) => `images/Image_${String(k + 1).padStart(6, '0')}.jpg`);
    expect(names.sort()).toEqual([...imgs, 'cameras/camera_trajectory.json', 'cameras/per_frame_intrinsics.json'].sort());
    expect(entries.every((e) => e.method === 0)).toBe(true);
    const byName = new Map(entries.map((e) => [e.name, e]));

    const intr = JSON.parse((await readEntry(byName.get('cameras/per_frame_intrinsics.json')!, read)).toString());
    expect(intr).toEqual({
      frame_count: N, width_px: 640, height_px: 480,
      fx_px: frames.map((f) => f.K.fx), fy_px: frames.map((f) => f.K.fy),
      cx_px: frames.map((f) => f.K.cx), cy_px: frames.map((f) => f.K.cy),
    });

    const traj = JSON.parse((await readEntry(byName.get('cameras/camera_trajectory.json')!, read)).toString());
    expect(traj).toHaveLength(N);
    traj.forEach((m: number[][], i: number) => {
      expect(m[3]).toEqual([0, 0, 0, 1]);
      expect(m).toEqual(arkitToOpenCV(frames[i]!.T_arkit));
    });

    let prev = -Infinity;
    for (let k = 0; k < N; k++) {
      const head = await readEntry(byName.get(imgs[k]!)!, read, 64 * 1024);
      const ts = captureExifTimestampSeconds(readCaptureExif(head)!)!;
      expect(ts).toBeCloseTo(frames[k]!.wallMs / 1000, 6);
      expect(ts).toBeGreaterThan(prev);
      prev = ts;
    }
  });

  it('rejects an invalid session before writing anything', async () => {
    const cid = randomUUID();
    await upload(cid);
    await storage.deleteObject(captureKey(cid, 'frames/000005.jpg'));
    const err = await packCapture(storage, cid, OPTS).catch((e) => e);
    expect(err).toBeInstanceOf(BundleInvalidError);
    expect(err.issues.map((i: { code: string }) => i.code)).toContain('FRAME_OBJECT_MISSING');
    expect(await storage.list(`bundles/${cid}/`)).toEqual([]);
  });

  it('a frame whose JPEG size mismatches the session fails mid-stream and leaves no bundle', async () => {
    const cid = randomUUID();
    await upload(cid);
    // Patch frame 7's SOF width to 641 (same byte length, so validateSession still passes).
    const jpg = Buffer.from(readFileSync(path.join(FIX, 'frames', '000007.jpg')));
    let p = 2;
    while (!(jpg[p + 1]! >= 0xc0 && jpg[p + 1]! <= 0xc3)) p += 2 + jpg.readUInt16BE(p + 2);
    jpg.writeUInt16BE(641, p + 7);
    await storage.putObject(captureKey(cid, 'frames/000007.jpg'), jpg);
    const err = await packCapture(storage, cid, OPTS).catch((e) => e);
    expect(err).toBeInstanceOf(BundleInvalidError);
    expect(err.issues.map((i: { code: string }) => i.code)).toContain('IMAGE_SIZE_MISMATCH');
    expect(await storage.list(`bundles/${cid}/`)).toEqual([]);
  });

  it('malformed frames.jsonl → MANIFEST_INVALID', async () => {
    const cid = randomUUID();
    await upload(cid);
    await storage.putObject(captureKey(cid, 'frames.jsonl'), Buffer.from('{nope\n'));
    const err = await packCapture(storage, cid, OPTS).catch((e) => e);
    expect(err).toBeInstanceOf(BundleInvalidError);
    expect(err.issues[0].code).toBe('MANIFEST_INVALID');
  });

  it('WR-05: a lost lease mid-zip does not delete the bundle key (the new owner writes it)', async () => {
    const cid = randomUUID();
    await upload(cid);
    const deleted: string[] = [];
    const spy = { ...storage, deleteObject: async (k: string) => void deleted.push(k) };
    const lost = Object.assign(new Error('lease lost'), { name: 'LeaseLostError' });
    const err = await packCapture(spy, cid, { ...OPTS, onProgress: async () => { throw lost; } }).catch((e) => e);
    expect(err).toBe(lost);
    expect(deleted).toEqual([]);
    // Any other mid-zip error still cleans up its own partial bundle.
    const boom = new Error('boom');
    await packCapture(spy, cid, { ...OPTS, onProgress: async () => { throw boom; } }).catch(() => undefined);
    expect(deleted).toEqual([bundleKeyFor(cid)]);
  });

  it('oversized frames.jsonl → MANIFEST_TOO_LARGE before it is read', async () => {
    const cid = randomUUID();
    await upload(cid);
    await storage.putObject(captureKey(cid, 'frames.jsonl'), Buffer.alloc(MANIFEST_MAX_BYTES + 1, 0x20));
    const err = await packCapture(storage, cid, OPTS).catch((e) => e);
    expect(err).toBeInstanceOf(BundleInvalidError);
    expect(err.issues[0].code).toBe('MANIFEST_TOO_LARGE');
  });

  it('missing session.json → MANIFEST_MISSING (not a retryable ENOENT)', async () => {
    const cid = randomUUID();
    await upload(cid);
    await storage.deleteObject(captureKey(cid, 'session.json'));
    const err = await packCapture(storage, cid, OPTS).catch((e) => e);
    expect(err).toBeInstanceOf(BundleInvalidError);
    expect(err.issues[0].code).toBe('MANIFEST_MISSING');
  });

  it('validateStored returns the parsed capture, and FRAME_COUNT_MISMATCH when the declared count differs', async () => {
    const cid = randomUUID();
    await upload(cid);
    const ok = await validateStored(storage, cid, { ...OPTS, expectedFrameCount: 30 });
    expect(ok.frames).toHaveLength(30);
    expect(ok.objects.every((o) => o.key.startsWith('frames/'))).toBe(true);
    const err = await validateStored(storage, cid, { ...OPTS, expectedFrameCount: 29 }).catch((e) => e);
    expect(err).toBeInstanceOf(BundleInvalidError);
    expect(err.issues.map((i: { code: string }) => i.code)).toEqual(['FRAME_COUNT_MISMATCH']);
  });

  it('pack applies the precheck rules (D-17 second line)', async () => {
    const cid = randomUUID();
    await upload(cid);
    const err = await packCapture(storage, cid, { ...OPTS, rules: { ...DEV_RULES, minCoverageSectors: 2 } }).catch((e) => e);
    expect(err).toBeInstanceOf(BundleInvalidError);
    expect(err.issues.map((i: { code: string }) => i.code)).toEqual(['COVERAGE_LOW']);
    expect(await storage.list(`bundles/${cid}/`)).toEqual([]);
  });
});
