import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import Fastify from 'fastify';
import { createLocalStorage, registerDevStorageRoutes } from '../src/storage/local.js';
import type { Config } from '../src/config.js';

let dir: string;

function makeConfig(): Config {
  return {
    LOCAL_STORAGE_DIR: dir,
    PUBLIC_BASE_URL: 'http://localhost:8080',
  } as unknown as Config;
}

beforeAll(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'virtumetry-storage-'));
});

afterAll(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

describe('local storage driver', () => {
  it('round-trips put → get → delete', async () => {
    const storage = createLocalStorage(makeConfig());
    const key = 'captures/abc/frame_0.heic';
    const payload = Buffer.from('hello-world');

    await storage.putObject(key, payload);
    const got = await storage.getObject(key);
    expect(got.equals(payload)).toBe(true);

    await storage.deleteObject(key);
    await expect(storage.getObject(key)).rejects.toBeTruthy();
  });

  it('builds dev-storage presigned URLs', async () => {
    const storage = createLocalStorage(makeConfig());
    const up = await storage.presignUpload('captures/x/frame_1.heic', 'image/heic', 100);
    expect(up.method).toBe('PUT');
    expect(up.url).toBe('http://localhost:8080/dev-storage/captures/x/frame_1.heic');

    const down = await storage.presignDownload('captures/x/frame_1.heic', 60);
    expect(down).toContain('/dev-storage/captures/x/frame_1.heic');
  });

  it('rejects path traversal keys', async () => {
    const storage = createLocalStorage(makeConfig());
    await expect(storage.putObject('../escape.txt', Buffer.from('x'))).rejects.toThrow(
      /Unsafe/,
    );
  });

  it('putStream → getStream round-trips', async () => {
    const storage = createLocalStorage(makeConfig());
    const key = 'bundles/s1/capture_bundle.zip';
    await storage.putStream(key, Readable.from([Buffer.from('ab'), Buffer.from('cd')]), 'application/zip').done;
    const chunks: Buffer[] = [];
    for await (const c of await storage.getStream(key)) chunks.push(c as Buffer);
    expect(Buffer.concat(chunks).toString()).toBe('abcd');
    await expect(storage.getStream('bundles/nope/x.zip')).rejects.toBeTruthy();
  });

  it('list returns forward-slash keys + sizes under a prefix, [] when missing', async () => {
    const storage = createLocalStorage(makeConfig());
    await storage.putObject('captures/L1/frames/000001.jpg', Buffer.from('123'));
    await storage.putObject('captures/L1/session.json', Buffer.from('{}'));
    const got = (await storage.list('captures/L1/')).sort((a, b) => a.key.localeCompare(b.key));
    expect(got).toEqual([
      { key: 'captures/L1/frames/000001.jpg', size: 3 },
      { key: 'captures/L1/session.json', size: 2 },
    ]);
    expect(await storage.list('captures/missing/')).toEqual([]);
  });

  it('dev-storage GET honours Range with 206 + Content-Range, 416 when unsatisfiable', async () => {
    const storage = createLocalStorage(makeConfig());
    await storage.putObject('bundles/r1/b.zip', Buffer.from('0123456789'));
    const app = Fastify();
    registerDevStorageRoutes(app, storage);
    const r = await app.inject({ method: 'GET', url: '/dev-storage/bundles/r1/b.zip', headers: { range: 'bytes=2-5' } });
    expect(r.statusCode).toBe(206);
    expect(r.headers['content-range']).toBe('bytes 2-5/10');
    expect(r.headers['accept-ranges']).toBe('bytes');
    expect(r.body).toBe('2345');
    const open = await app.inject({ method: 'GET', url: '/dev-storage/bundles/r1/b.zip', headers: { range: 'bytes=7-' } });
    expect(open.statusCode).toBe(206);
    expect(open.body).toBe('789');
    const bad = await app.inject({ method: 'GET', url: '/dev-storage/bundles/r1/b.zip', headers: { range: 'bytes=20-30' } });
    expect(bad.statusCode).toBe(416);
    const full = await app.inject({ method: 'GET', url: '/dev-storage/bundles/r1/b.zip' });
    expect(full.statusCode).toBe(200);
    expect(full.body).toBe('0123456789');
    await app.close();
  });
});
