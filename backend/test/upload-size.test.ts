import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Fastify from 'fastify';

let currentDb: unknown;
vi.mock('../src/db/client.js', () => ({ getDb: () => currentDb }));

import { createLocalStorage } from '../src/storage/local.js';
import { createS3Storage } from '../src/storage/s3.js';
import { MAX_DEPTH_BYTES, MAX_FRAME_BYTES, type StorageDriver } from '../src/storage/index.js';
import { worldsRoutes, frameSizeMap } from '../src/routes/worlds.js';
import { handleStitch, NonRetryableJobError, type WorkerDeps } from '../src/worker.js';
import { loadConfig, type Config } from '../src/config.js';
import { worlds, captures, users, type World } from '../src/db/schema.js';

// spec §10 R7 — presigned frame uploads had NO enforced size cap: s3.ts took a
// `_maxBytes` argument and ignored it. Now an exact declared size is signed into
// the URL, and the worker ALWAYS size-checks a frame before reading it.

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
    S3_BUCKET: 'virtspace',
    S3_ACCESS_KEY_ID: 'AKIAEXAMPLE',
    S3_SECRET_ACCESS_KEY: 'secret',
  } as Config;
}

describe('s3 presignUpload size binding', () => {
  // Presigning is pure local SigV4 crypto — no network call is made.
  it('signs content-length into the URL when the exact size is declared', async () => {
    const storage = createS3Storage(s3Config());
    const res = await storage.presignUpload(
      'captures/c1/frame_0.heic',
      'image/heic',
      MAX_FRAME_BYTES,
      1234,
    );

    const signedHeaders = new URL(res.url).searchParams.get('X-Amz-SignedHeaders');
    expect(signedHeaders).toContain('content-length');
    expect(res.headers['content-length']).toBe('1234');
    expect(res.headers['content-type']).toBe('image/heic');
  });

  it('does not bind a length when the client declared none', async () => {
    const storage = createS3Storage(s3Config());
    const res = await storage.presignUpload(
      'captures/c1/frame_0.heic',
      'image/heic',
      MAX_FRAME_BYTES,
    );

    const signedHeaders = new URL(res.url).searchParams.get('X-Amz-SignedHeaders');
    expect(signedHeaders).not.toContain('content-length');
    expect(res.headers['content-length']).toBeUndefined();
  });

  it('ignores a declared size above the cap rather than signing it', async () => {
    const storage = createS3Storage(s3Config());
    const res = await storage.presignUpload(
      'captures/c1/frame_0.heic',
      'image/heic',
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
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'virtspace-size-'));
  });
  afterAll(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  const makeConfig = () =>
    ({ LOCAL_STORAGE_DIR: dir, PUBLIC_BASE_URL: 'http://localhost:8080' }) as unknown as Config;

  it('tightens the PUT limit to the declared exact size', async () => {
    const storage = createLocalStorage(makeConfig());
    await storage.presignUpload('captures/c1/frame_0.heic', 'image/heic', MAX_FRAME_BYTES, 10);
    expect(storage.maxBytesFor('captures/c1/frame_0.heic')).toBe(10);
  });

  it('falls back to the ceiling when no size is declared', async () => {
    const storage = createLocalStorage(makeConfig());
    await storage.presignUpload('captures/c1/frame_1.heic', 'image/heic', MAX_FRAME_BYTES);
    expect(storage.maxBytesFor('captures/c1/frame_1.heic')).toBe(MAX_FRAME_BYTES);
  });

  it('objectSize reports the stored byte length (and throws when absent)', async () => {
    const storage = createLocalStorage(makeConfig());
    await storage.putObject('captures/c1/frame_2.heic', Buffer.alloc(4096, 7));
    expect(await storage.objectSize('captures/c1/frame_2.heic')).toBe(4096);
    await expect(storage.objectSize('captures/c1/missing.heic')).rejects.toBeTruthy();
  });
});

// --- route: optional per-frame `bytes` --------------------------------------

function fakeWorld(): World {
  return {
    id: 'w-1', ownerId: 'user-1', title: null, caption: null, lat: null, lng: null,
    placeName: null, isPublic: false, status: 'uploading', phase: null, progress: null,
    panoUrl: null, thumbnailUrl: null, spz100kUrl: null, spz500kUrl: null,
    spzFullUrl: null, colliderGlbUrl: null, assetVersion: 1, provider: null,
    draftWorldId: null, hqWorldId: null, draftModel: null, hqModel: null, creditsSpent: 0,
    createdAt: new Date('2026-07-12T10:00:00Z'),
    updatedAt: new Date('2026-07-12T10:00:00Z'), deletedAt: null,
  };
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
  return {
    kind: 'local',
    presignUpload,
    presignDownload: vi.fn(async (k: string) => `https://signed.example/${k}`),
    putObject: vi.fn(),
    getObject: vi.fn(),
    deleteObject: vi.fn(),
    objectSize: vi.fn(async () => 1),
  } as unknown as StorageDriver & { presignUpload: typeof presignUpload };
}

function routeDb() {
  return {
    select: () => ({
      from: (table: unknown) => {
        const rows =
          table === users
            ? [{ id: 'user-1', dailyScanCount: 0, quotaResetAt: null }]
            : table === worlds
              ? [fakeWorld()]
              : [];
        const chain = { where: () => chain, orderBy: () => chain, limit: async () => rows };
        return chain;
      },
    }),
    update: () => ({ set: () => ({ where: async () => undefined }) }),
    insert: (table: unknown) => ({
      values: () => ({
        returning: async () =>
          table === worlds
            ? [fakeWorld()]
            : [{ id: 'cap-1', worldId: 'w-1', frameCount: 2, r2FramesPrefix: null }],
      }),
    }),
    // Shape chargeScanQuota reads: a charged row (§10 R9).
    execute: async () => ({
      rows: [{ user_id: 'user-1', new_count: 1, reset_at: new Date('2026-09-18T00:00:00Z') }],
    }),
  };
}

async function buildApp(storage: StorageDriver) {
  const app = Fastify();
  app.addHook('preHandler', async (req) => {
    req.userId = 'user-1';
  });
  worldsRoutes(app, { config, storage });
  await app.ready();
  return app;
}

describe('POST /v1/worlds per-frame size declaration', () => {
  it('signs the declared exact size for each frame', async () => {
    currentDb = routeDb();
    const storage = routeStorage();
    const app = await buildApp(storage);

    const res = await app.inject({
      method: 'POST',
      url: '/v1/worlds',
      payload: {
        frame_count: 2,
        frames: [
          { index: 0, bytes: 1000 },
          { index: 1, bytes: 2000 },
        ],
      },
    });

    expect(res.statusCode).toBe(201);
    const calls = storage.presignUpload.mock.calls;
    expect(calls[0]![3]).toBe(1000);
    expect(calls[1]![3]).toBe(2000);
    expect(res.json().uploads[0].headers['content-length']).toBe('1000');
    await app.close();
  });

  it('still works with no frames declaration (shipped client)', async () => {
    currentDb = routeDb();
    const storage = routeStorage();
    const app = await buildApp(storage);

    const res = await app.inject({
      method: 'POST',
      url: '/v1/worlds',
      payload: { frame_count: 2 },
    });

    expect(res.statusCode).toBe(201);
    expect(storage.presignUpload.mock.calls[0]![3]).toBeUndefined();
    await app.close();
  });

  it('rejects a declared size over the 12 MB cap with 400', async () => {
    currentDb = routeDb();
    const storage = routeStorage();
    const app = await buildApp(storage);

    const res = await app.inject({
      method: 'POST',
      url: '/v1/worlds',
      payload: {
        frame_count: 1,
        frames: [{ index: 0, bytes: MAX_FRAME_BYTES + 1 }],
      },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('invalid_body');
    expect(storage.presignUpload).not.toHaveBeenCalled();
    await app.close();
  });
});

// --- route: optional depth maps (spec §5.2 capture v2) ----------------------

describe('POST /v1/worlds depth opt-in', () => {
  it('absent → response and presign calls identical to the pre-depth contract', async () => {
    currentDb = routeDb();
    const storage = routeStorage();
    const app = await buildApp(storage);

    const res = await app.inject({ method: 'POST', url: '/v1/worlds', payload: { frame_count: 2 } });
    const off = await app.inject({
      method: 'POST',
      url: '/v1/worlds',
      payload: { frame_count: 2, depth: false },
    });

    expect(res.statusCode).toBe(201);
    expect(Object.keys(res.json())).toEqual(['world', 'capture_id', 'uploads']);
    expect(off.body).toBe(res.body);
    // Only frame presigns: 2 per request.
    expect(storage.presignUpload).toHaveBeenCalledTimes(4);
    expect(storage.presignUpload.mock.calls.every((c) => c[1] === 'image/heic')).toBe(true);
    await app.close();
  });

  it('depth: true → depth_uploads with the uploads shape, png keys, 1 MB ceiling', async () => {
    currentDb = routeDb();
    const storage = routeStorage();
    const app = await buildApp(storage);

    const res = await app.inject({
      method: 'POST',
      url: '/v1/worlds',
      payload: { frame_count: 2, depth: true, depth_frames: [{ index: 1, bytes: 98765 }] },
    });

    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.uploads.map((u: { key: string }) => u.key)).toEqual([
      'captures/cap-1/frame_0.heic',
      'captures/cap-1/frame_1.heic',
    ]);
    expect(body.depth_uploads).toEqual([
      {
        index: 0,
        key: 'captures/cap-1/depth_0.png',
        url: 'https://signed.example/captures/cap-1/depth_0.png',
        method: 'PUT',
        headers: { 'content-type': 'image/png' },
      },
      {
        index: 1,
        key: 'captures/cap-1/depth_1.png',
        url: 'https://signed.example/captures/cap-1/depth_1.png',
        method: 'PUT',
        headers: { 'content-type': 'image/png', 'content-length': '98765' },
      },
    ]);
    const depthCalls = storage.presignUpload.mock.calls.filter((c) => c[1] === 'image/png');
    expect(depthCalls.map((c) => [c[0], c[2], c[3]])).toEqual([
      ['captures/cap-1/depth_0.png', MAX_DEPTH_BYTES, undefined],
      ['captures/cap-1/depth_1.png', MAX_DEPTH_BYTES, 98765],
    ]);
    await app.close();
  });

  it('rejects a declared depth size over 1 MB, and a non-boolean depth, with 400', async () => {
    currentDb = routeDb();
    const storage = routeStorage();
    const app = await buildApp(storage);

    const big = await app.inject({
      method: 'POST',
      url: '/v1/worlds',
      payload: { frame_count: 1, depth: true, depth_frames: [{ index: 0, bytes: MAX_DEPTH_BYTES + 1 }] },
    });
    const bad = await app.inject({
      method: 'POST',
      url: '/v1/worlds',
      payload: { frame_count: 1, depth: 'yes' },
    });

    expect(big.statusCode).toBe(400);
    expect(bad.statusCode).toBe(400);
    expect(storage.presignUpload).not.toHaveBeenCalled();
    await app.close();
  });
});

describe('frameSizeMap', () => {
  it('maps declared indices and leaves the rest undeclared', () => {
    const m = frameSizeMap([{ index: 3, bytes: 99 }]);
    expect(m.get(3)).toBe(99);
    expect(m.get(0)).toBeUndefined();
    expect(frameSizeMap().size).toBe(0);
  });
});

// --- worker guard (mandatory, independent of presigning) ---------------------

describe('worker frame size guard', () => {
  const capture = {
    id: 'cap-1',
    worldId: 'w-1',
    frameCount: 1,
    posesJson: null,
    r2FramesPrefix: 'captures/cap-1',
    createdAt: new Date(),
  };

  function stitchDeps(sizes: Record<string, number>, gets: string[]): WorkerDeps {
    const world = { ...fakeWorld(), status: 'stitching' } as World;
    const db = {
      select: () => ({
        from: (table: unknown) => {
          const rows = table === worlds ? [world] : [capture];
          const chain = { where: () => chain, orderBy: () => chain, limit: async () => rows };
          return chain;
        },
      }),
      update: () => ({
        set: () => ({
          where: () =>
            Object.assign(Promise.resolve([{ id: 'w-1' }]), {
              returning: async () => [{ id: 'w-1' }],
            }),
        }),
      }),
      insert: () => ({ values: () => ({ returning: async () => [{ id: 'j' }] }) }),
      execute: async () => ({ rows: [{ id: 'job-1' }] }),
      transaction: async <T>(cb: (tx: unknown) => Promise<T>): Promise<T> => cb(db),
    };
    const storage = {
      kind: 'local',
      presignUpload: vi.fn(),
      presignDownload: vi.fn(),
      putObject: vi.fn(),
      getObject: vi.fn(async (key: string) => {
        gets.push(key);
        return Buffer.from('bytes');
      }),
      deleteObject: vi.fn(),
      objectSize: vi.fn(async (key: string) => {
        const size = sizes[key];
        if (size === undefined) throw new Error('NoSuchKey');
        return size;
      }),
    } as unknown as StorageDriver;
    return {
      db: db as unknown as WorkerDeps['db'],
      storage,
      provider: {} as WorkerDeps['provider'],
      config,
      push: (async () => undefined) as unknown as WorkerDeps['push'],
    };
  }

  const job = { id: 'job-1', kind: 'stitch', worldId: 'w-1' } as never;

  it('refuses (non-retryably) to read a frame over the cap, and never reads it', async () => {
    const gets: string[] = [];
    const deps = stitchDeps({ 'captures/cap-1/frame_0.heic': MAX_FRAME_BYTES + 1 }, gets);

    await expect(handleStitch(deps, job)).rejects.toBeInstanceOf(NonRetryableJobError);
    expect(gets).toEqual([]); // never pulled into memory
  });

  it('reads a frame at or under the cap', async () => {
    const gets: string[] = [];
    const deps = stitchDeps({ 'captures/cap-1/frame_0.heic': MAX_FRAME_BYTES }, gets);

    await handleStitch(deps, job);
    expect(gets).toEqual(['captures/cap-1/frame_0.heic']);
  });

  it('treats an unsizeable (missing) frame as non-retryable', async () => {
    const gets: string[] = [];
    const deps = stitchDeps({}, gets);

    await expect(handleStitch(deps, job)).rejects.toBeInstanceOf(NonRetryableJobError);
    expect(gets).toEqual([]);
  });
});
