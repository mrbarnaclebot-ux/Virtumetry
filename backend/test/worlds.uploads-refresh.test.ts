import { describe, it, expect, vi } from 'vitest';
import Fastify from 'fastify';

// Mock the lazy DB module BEFORE importing the routes. The factory reads
// `currentDb` at call time, so each test swaps in its own fake.
let currentDb: unknown;
vi.mock('../src/db/client.js', () => ({
  getDb: () => currentDb,
}));

import { worldsRoutes } from '../src/routes/worlds.js';
import { worlds, captures, type World } from '../src/db/schema.js';
import { loadConfig } from '../src/config.js';
import type { StorageDriver } from '../src/storage/index.js';

// POST /v1/worlds/:id/uploads:refresh — re-presign the world's capture frames so
// an interrupted upload resumes onto the SAME R2 keys without a new world.

const config = loadConfig({
  DATABASE_URL: 'postgres://u:p@localhost:5432/db',
  DEV_AUTH_TOKEN: 't',
} as NodeJS.ProcessEnv);

function makeStorage(): StorageDriver & { presignUpload: ReturnType<typeof vi.fn> } {
  return {
    kind: 'local',
    // Mirror the create-time presign shape (url/method/headers).
    presignUpload: vi.fn(async (key: string, contentType: string) => ({
      url: `https://signed.example/${key}`,
      method: 'PUT' as const,
      headers: { 'content-type': contentType },
    })),
    presignDownload: vi.fn(async (key: string) => `https://signed.example/${key}`),
    putObject: vi.fn(),
    getObject: vi.fn(),
    deleteObject: vi.fn(),
  } as unknown as StorageDriver & { presignUpload: ReturnType<typeof vi.fn> };
}

function fakeWorld(): World {
  return {
    id: 'w-1',
    ownerId: 'user-1',
    title: null,
    caption: null,
    lat: null,
    lng: null,
    placeName: null,
    isPublic: false,
    status: 'uploading',
    phase: null,
    progress: null,
    panoUrl: null,
    thumbnailUrl: null,
    spz100kUrl: null,
    spz500kUrl: null,
    spzFullUrl: null,
    colliderGlbUrl: null,
    assetVersion: 1,
    provider: null,
    draftWorldId: null,
    hqWorldId: null,
    draftModel: null,
    hqModel: null,
    creditsSpent: 0,
    createdAt: new Date('2026-07-12T10:00:00Z'),
    updatedAt: new Date('2026-07-12T10:00:00Z'),
    deletedAt: null,
  };
}

interface FakeCapture {
  id: string;
  worldId: string;
  frameCount: number;
  r2FramesPrefix: string | null;
  createdAt: Date;
}

interface DbState {
  // undefined models an ownership-filtered query that returns no row (the exact
  // path a non-owner — or a missing world — takes through findOwnedWorld).
  world: World | undefined;
  capture: FakeCapture | null;
}

/** Minimal chainable stand-in for the drizzle calls this route makes. */
function makeFakeDb(state: DbState) {
  return {
    select: () => ({
      from: (table: unknown) => {
        const rows =
          table === worlds
            ? state.world
              ? [state.world]
              : []
            : table === captures && state.capture
              ? [state.capture]
              : [];
        const chain = {
          where: () => chain,
          orderBy: () => chain,
          limit: async () => rows,
        };
        return chain;
      },
    }),
    update: () => ({ set: () => ({ where: async () => {} }) }),
    insert: () => ({ values: () => ({ returning: async () => [{ id: 'job-1' }] }) }),
  };
}

async function makeApp(state: DbState, storage: StorageDriver) {
  currentDb = makeFakeDb(state);
  const app = Fastify();
  // Stand-in for the auth preHandler: attach the requester's user id.
  app.addHook('preHandler', async (req) => {
    (req as { userId?: string }).userId = 'user-1';
  });
  worldsRoutes(app, { config, storage });
  await app.ready();
  return app;
}

describe('POST /v1/worlds/:id/uploads:refresh', () => {
  it('owner → fresh presigned PUT URLs for every capture frame (same keys)', async () => {
    const storage = makeStorage();
    const state: DbState = {
      world: fakeWorld(),
      capture: {
        id: 'cap-1',
        worldId: 'w-1',
        frameCount: 3,
        r2FramesPrefix: 'captures/cap-1',
        createdAt: new Date('2026-07-12T10:00:00Z'),
      },
    };
    const app = await makeApp(state, storage);
    const res = await app.inject({ method: 'POST', url: '/v1/worlds/w-1/uploads:refresh' });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.capture_id).toBe('cap-1');
    expect(body.world.id).toBe('w-1');
    // One upload slot per frame, index-ordered, on the same frame_<i>.heic keys.
    expect(body.uploads).toHaveLength(3);
    expect(body.uploads.map((u: { index: number }) => u.index)).toEqual([0, 1, 2]);
    expect(body.uploads.map((u: { key: string }) => u.key)).toEqual([
      'captures/cap-1/frame_0.heic',
      'captures/cap-1/frame_1.heic',
      'captures/cap-1/frame_2.heic',
    ]);
    expect(body.uploads[0].method).toBe('PUT');
    expect(body.uploads[0].url).toBe('https://signed.example/captures/cap-1/frame_0.heic');
    // Presigned with the same content-type + ceiling as create.
    expect(storage.presignUpload).toHaveBeenCalledTimes(3);
    // No `frames` declaration in the body → no exact size to bind (§10 R7).
    expect(storage.presignUpload).toHaveBeenCalledWith(
      'captures/cap-1/frame_0.heic',
      'image/heic',
      12 * 1024 * 1024,
      undefined,
    );
    await app.close();
  });

  it('depth: true → depth_uploads on the same capture prefix; absent → no key', async () => {
    const storage = makeStorage();
    const state: DbState = {
      world: fakeWorld(),
      capture: {
        id: 'cap-1',
        worldId: 'w-1',
        frameCount: 2,
        r2FramesPrefix: 'captures/cap-1',
        createdAt: new Date('2026-07-12T10:00:00Z'),
      },
    };
    const app = await makeApp(state, storage);
    const plain = await app.inject({ method: 'POST', url: '/v1/worlds/w-1/uploads:refresh' });
    const res = await app.inject({
      method: 'POST',
      url: '/v1/worlds/w-1/uploads:refresh',
      payload: { depth: true, depth_frames: [{ index: 0, bytes: 4242 }] },
    });

    expect(Object.keys(plain.json())).toEqual(['world', 'capture_id', 'uploads']);
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.uploads).toHaveLength(2);
    expect(body.depth_uploads.map((u: { index: number; key: string }) => [u.index, u.key])).toEqual([
      [0, 'captures/cap-1/depth_0.png'],
      [1, 'captures/cap-1/depth_1.png'],
    ]);
    expect(storage.presignUpload).toHaveBeenCalledWith(
      'captures/cap-1/depth_0.png',
      'image/png',
      1024 * 1024,
      4242,
    );
    await app.close();
  });

  it('non-owner → 404 world_not_found (no presign work)', async () => {
    const storage = makeStorage();
    // Ownership-filtered query yields no row — identical to a foreign owner.
    const state: DbState = { world: undefined, capture: null };
    const app = await makeApp(state, storage);
    const res = await app.inject({ method: 'POST', url: '/v1/worlds/w-1/uploads:refresh' });

    expect(res.statusCode).toBe(404);
    expect(res.json().error).toBe('world_not_found');
    expect(storage.presignUpload).not.toHaveBeenCalled();
    await app.close();
  });

  it('owned world with no capture → 404 capture_not_found', async () => {
    const storage = makeStorage();
    const state: DbState = { world: fakeWorld(), capture: null };
    const app = await makeApp(state, storage);
    const res = await app.inject({ method: 'POST', url: '/v1/worlds/w-1/uploads:refresh' });

    expect(res.statusCode).toBe(404);
    expect(res.json().error).toBe('capture_not_found');
    expect(storage.presignUpload).not.toHaveBeenCalled();
    await app.close();
  });
});
