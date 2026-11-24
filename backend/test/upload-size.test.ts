import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Fastify from 'fastify';

let currentDb: unknown;
vi.mock('../src/db/client.js', () => ({ getDb: () => currentDb }));

import { createLocalStorage } from '../src/storage/local.js';
import { createS3Storage } from '../src/storage/s3.js';
import { MAX_FRAME_BYTES, type StorageDriver } from '../src/storage/index.js';
import { scansRoutes } from '../src/routes/scans.js';
import { createMockProvider } from '../src/provider/mock.js';
import { MANIFEST_MAX_BYTES } from '../src/bundle/pack.js';

import { loadConfig, type Config } from '../src/config.js';
import { worlds, captures, type World } from '../src/db/schema.js';

// spec §10 R7 — presigned frame uploads had NO enforced size cap: s3.ts took a
// `_maxBytes` argument and ignored it. Now an exact declared size is signed into
// the URL. (The worker-side pre-read guard returns with the reconstruction worker.)

const config = loadConfig({
  DATABASE_URL: 'postgres://u:p@localhost:5432/db',
  DEV_AUTH_TOKEN: 't',
} as NodeJS.ProcessEnv);

describe('MAX_FRAME_BYTES', () => {
  it('is the 12 MB per-frame ceiling from spec §8', () => {
    expect(MAX_FRAME_BYTES).toBe(12 * 1024 * 1024);
  });
});

// --- S3 presign command construction ----------------------------------------

function s3Config(): Config {
  return {
    ...config,
    STORAGE_DRIVER: 's3',
    S3_ENDPOINT: 'https://accountid.r2.cloudflarestorage.com',
    S3_REGION: 'auto',
    S3_BUCKET: 'virtumetry',
    S3_ACCESS_KEY_ID: 'AKIAEXAMPLE',
    S3_SECRET_ACCESS_KEY: 'secret',
  } as Config;
}

describe('s3 presignUpload size binding', () => {
  // Presigning is pure local SigV4 crypto — no network call is made.
  it('signs content-length into the URL when the exact size is declared', async () => {
    const storage = createS3Storage(s3Config());
    const res = await storage.presignUpload(
      'captures/c1/frames/000001.jpg',
      'image/jpeg',
      MAX_FRAME_BYTES,
      1234,
    );

    const signedHeaders = new URL(res.url).searchParams.get('X-Amz-SignedHeaders');
    expect(signedHeaders).toContain('content-length');
    expect(res.headers['content-length']).toBe('1234');
    expect(res.headers['content-type']).toBe('image/jpeg');
  });

  it('does not bind a length when the client declared none', async () => {
    const storage = createS3Storage(s3Config());
    const res = await storage.presignUpload(
      'captures/c1/frames/000001.jpg',
      'image/jpeg',
      MAX_FRAME_BYTES,
    );

    const signedHeaders = new URL(res.url).searchParams.get('X-Amz-SignedHeaders');
    expect(signedHeaders).not.toContain('content-length');
    expect(res.headers['content-length']).toBeUndefined();
  });

  it('ignores a declared size above the cap rather than signing it', async () => {
    const storage = createS3Storage(s3Config());
    const res = await storage.presignUpload(
      'captures/c1/frames/000001.jpg',
      'image/jpeg',
      MAX_FRAME_BYTES,
      MAX_FRAME_BYTES + 1,
    );
    expect(res.headers['content-length']).toBeUndefined();
  });
});

// --- local driver ------------------------------------------------------------

describe('local driver size enforcement', () => {
  let dir: string;

  beforeAll(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'virtumetry-size-'));
  });
  afterAll(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  const makeConfig = () =>
    ({ LOCAL_STORAGE_DIR: dir, PUBLIC_BASE_URL: 'http://localhost:8080' }) as unknown as Config;

  it('tightens the PUT limit to the declared exact size', async () => {
    const storage = createLocalStorage(makeConfig());
    await storage.presignUpload('captures/c1/frames/000001.jpg', 'image/jpeg', MAX_FRAME_BYTES, 10);
    expect(storage.maxBytesFor('captures/c1/frames/000001.jpg')).toBe(10);
  });

  it('falls back to the ceiling when no size is declared', async () => {
    const storage = createLocalStorage(makeConfig());
    await storage.presignUpload('captures/c1/frames/000002.jpg', 'image/jpeg', MAX_FRAME_BYTES);
    expect(storage.maxBytesFor('captures/c1/frames/000002.jpg')).toBe(MAX_FRAME_BYTES);
  });

  it('objectSize reports the stored byte length (and throws when absent)', async () => {
    const storage = createLocalStorage(makeConfig());
    await storage.putObject('captures/c1/frames/000003.jpg', Buffer.alloc(4096, 7));
    expect(await storage.objectSize('captures/c1/frames/000003.jpg')).toBe(4096);
    await expect(storage.objectSize('captures/c1/frames/999999.jpg')).rejects.toBeTruthy();
  });
});

// --- route: exact Content-Length on scan uploads --------------------------

function fakeWorld(): World {
  return {
    id: 'w-1', ownerId: 'user-1', title: null, caption: null, lat: null, lng: null,
    placeName: null, isPublic: false, status: 'uploading', phase: null, progress: null,
    splatKey: null, colliderKey: null, floorplanKey: null,
    camerasKey: null, thumbnailKey: null, assetVersion: 1, provider: null,
    creditsSpent: 0,
    createdAt: new Date('2026-07-12T10:00:00Z'),
    updatedAt: new Date('2026-07-12T10:00:00Z'), deletedAt: null,
  } as World;
}

function routeStorage() {
  const presignUpload = vi.fn(
    async (key: string, contentType: string, _max: number, exact?: number) => ({
      url: `https://signed.example/${key}`,
      method: 'PUT' as const,
      headers: {
        'content-type': contentType,
        ...(exact ? { 'content-length': String(exact) } : {}),
      },
    }),
  );
  return { kind: 'local', presignUpload } as unknown as StorageDriver & {
    presignUpload: typeof presignUpload;
  };
}

function routeDb() {
  return {
    select: () => ({
      from: (table: unknown) => {
        const rows =
          table === worlds
            ? [fakeWorld()]
            : table === captures
              ? [{ id: 'cap-1', worldId: 'w-1', frameCount: 2, r2FramesPrefix: 'captures/cap-1' }]
              : [];
        const chain = { where: () => chain, orderBy: () => chain, limit: async () => rows };
        return chain;
      },
    }),
  };
}

async function buildApp(storage: StorageDriver) {
  const app = Fastify();
  app.addHook('preHandler', async (req) => {
    req.userId = 'user-1';
  });
  scansRoutes(app, { config, storage, provider: createMockProvider({}) });
  await app.ready();
  return app;
}

const W = '00000000-0000-4000-8000-000000000001';
const presign = (app: Awaited<ReturnType<typeof buildApp>>, files: object[]) =>
  app.inject({ method: 'POST', url: `/v1/scans/${W}/uploads`, payload: { files } });

describe('POST /v1/scans/:id/uploads size binding', () => {
  it('signs the exact declared size for a frame and a manifest file', async () => {
    currentDb = routeDb();
    const storage = routeStorage();
    const app = await buildApp(storage);

    const res = await presign(app, [
      { path: 'frames/000001.jpg', bytes: 1000 },
      { path: 'frames.jsonl', bytes: 2000 },
    ]);

    expect(res.statusCode).toBe(200);
    const calls = storage.presignUpload.mock.calls;
    expect(calls[0]).toEqual(['captures/cap-1/frames/000001.jpg', 'image/jpeg', MAX_FRAME_BYTES, 1000, 21600]);
    expect(calls[1]).toEqual(['captures/cap-1/frames.jsonl', 'application/json', MANIFEST_MAX_BYTES, 2000, 21600]);
    expect(res.json().uploads[0].headers['content-length']).toBe('1000');
    await app.close();
  });

  it('rejects a frame over the 12 MB cap with 400 before signing', async () => {
    currentDb = routeDb();
    const storage = routeStorage();
    const app = await buildApp(storage);

    const res = await presign(app, [{ path: 'frames/000001.jpg', bytes: MAX_FRAME_BYTES + 1 }]);

    expect(res.statusCode).toBe(400);
    expect(storage.presignUpload).not.toHaveBeenCalled();
    await app.close();
  });

  it('rejects a manifest over its cap with 400 before signing', async () => {
    currentDb = routeDb();
    const storage = routeStorage();
    const app = await buildApp(storage);

    const res = await presign(app, [{ path: 'session.json', bytes: MANIFEST_MAX_BYTES + 1 }]);

    expect(res.statusCode).toBe(400);
    expect(storage.presignUpload).not.toHaveBeenCalled();
    await app.close();
  });
});
