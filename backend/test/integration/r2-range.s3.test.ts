// D-22 / ROADMAP SC1: a packed bundle on virtumetry-dev, presigned for 24 h,
// answers HTTP Range requests. Gated: run via `node --env-file=.env scripts/test-r2.mjs`.
// Never prints the presigned URL (24 h bearer credential).
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { loadConfig } from '../../src/config.js';
import { createS3Storage } from '../../src/storage/s3.js';
import { captureKey, type StorageDriver } from '../../src/storage/index.js';
import { packCapture } from '../../src/bundle/pack.js';
import { readCentralDirectory, type ReadRange } from '../../src/bundle/zipread.js';

const FIX = fileURLToPath(new URL('../fixtures/tiny-session/', import.meta.url));
const gated = process.env.R2_IT !== '1' || process.env.S3_BUCKET !== 'virtumetry-dev';

describe.skipIf(gated)('R2 Range preflight (virtumetry-dev)', () => {
  const cid = `it-${randomUUID()}`;
  let storage: StorageDriver;

  beforeAll(async () => {
    const config = loadConfig({ ...process.env, STORAGE_DRIVER: 's3' });
    expect(config.S3_BUCKET).toBe('virtumetry-dev');
    storage = createS3Storage(config);
    await storage.putObject(captureKey(cid, 'session.json'), readFileSync(path.join(FIX, 'session.json')));
    await storage.putObject(captureKey(cid, 'frames.jsonl'), readFileSync(path.join(FIX, 'frames.jsonl')));
    for (const f of readdirSync(path.join(FIX, 'frames'))) {
      await storage.putObject(captureKey(cid, `frames/${f}`), readFileSync(path.join(FIX, 'frames', f)));
    }
  }, 120_000);

  afterAll(async () => {
    if (!storage) return;
    for (const p of [`captures/${cid}/`, `bundles/${cid}/`]) {
      for (const o of await storage.list(p)) await storage.deleteObject(o.key);
    }
    expect(await storage.list(`captures/${cid}/`)).toEqual([]);
    expect(await storage.list(`bundles/${cid}/`)).toEqual([]);
  }, 120_000);

  it('packs to R2, presigns 24 h, serves Range 206 and a readable central directory', async () => {
    const res = await packCapture(storage, cid, { minFrames: 1, maxFrames: 5000 });
    console.log(`[r2-it] bundle ${res.bundleKey} bytes=${res.bundleBytes} frames=${res.frameCount}`);
    const listed = await storage.list(`bundles/${cid}/`);
    expect(listed).toEqual([{ key: res.bundleKey, size: res.bundleBytes }]);

    const url = await storage.presignDownload(res.bundleKey, 86_400);
    expect(new URL(url).searchParams.get('X-Amz-Expires')).toBe('86400');

    const head = await fetch(url, { headers: { Range: 'bytes=0-15' }, signal: AbortSignal.timeout(30_000) });
    expect(head.status).toBe(206);
    const body = Buffer.from(await head.arrayBuffer());
    expect(body.subarray(0, 4).equals(Buffer.from([0x50, 0x4b, 0x03, 0x04]))).toBe(true);
    expect(head.headers.get('content-range')).toBe(`bytes 0-15/${res.bundleBytes}`);

    const read: ReadRange = async (a, b) => {
      const r = await fetch(url, { headers: { Range: `bytes=${a}-${b}` }, signal: AbortSignal.timeout(30_000) });
      if (r.status !== 206) throw new Error(`Range read returned ${r.status}`);
      return Buffer.from(await r.arrayBuffer());
    };
    const entries = await readCentralDirectory(res.bundleBytes, read);
    expect(entries).toHaveLength(res.frameCount + 2);
    expect(entries.every((e) => e.method === 0)).toBe(true);
  }, 300_000);
});
