import { describe, it, expect, vi, beforeEach } from 'vitest';
import Fastify from 'fastify';

// spec §10 R3 — `users.deleted_at` was written by DELETE /v1/account but never
// read, so a deleted account's credentials kept working and the row kept being
// upserted. Auth must reject deleted users, and purge must null the per-frame
// ARKit poses (spec §13 data minimization).

// The auth preHandler resolves users through db/users.js over the lazy db
// client; both are mocked so no Postgres is involved.
let currentUser: { id: string; deletedAt: Date | null } | undefined;
const upsertSpy = vi.fn(async () => currentUser);

vi.mock('../src/db/client.js', () => ({ getDb: () => ({}) }));
vi.mock('../src/db/users.js', () => ({
  upsertUserBySub: (...args: unknown[]) => upsertSpy(...(args as [])),
}));
// Apple mode: stub the JWKS verification so the test never touches the network.
vi.mock('jose', () => ({
  createRemoteJWKSet: () => ({}),
  jwtVerify: async () => ({ payload: { sub: 'apple-sub-1', email: 'a@b.c' } }),
}));

import { makeAuthPreHandler } from '../src/auth.js';
import { loadConfig } from '../src/config.js';
import { captures, jobs, worlds } from '../src/db/schema.js';
import type { WorkerDeps } from '../src/worker.js';
import type { StorageDriver } from '../src/storage/index.js';

const devConfig = loadConfig({
  DATABASE_URL: 'postgres://u:p@localhost:5432/db',
  DEV_AUTH_TOKEN: 'dev-token',
} as NodeJS.ProcessEnv);

const appleConfig = loadConfig({
  DATABASE_URL: 'postgres://u:p@localhost:5432/db',
  AUTH_MODE: 'apple',
  APPLE_BUNDLE_ID: 'com.example.app',
} as NodeJS.ProcessEnv);

async function buildApp(config: typeof devConfig) {
  const app = Fastify();
  app.addHook('preHandler', makeAuthPreHandler(config));
  app.get('/whoami', async (req) => ({ user_id: req.userId }));
  await app.ready();
  return app;
}

beforeEach(() => {
  upsertSpy.mockClear();
});

describe('auth rejects deleted accounts', () => {
  it('dev mode: a user with deleted_at is 403 account_deleted', async () => {
    currentUser = { id: 'u-1', deletedAt: new Date('2026-09-01T00:00:00Z') };
    const app = await buildApp(devConfig);

    const res = await app.inject({
      method: 'GET',
      url: '/whoami',
      headers: { authorization: 'Bearer dev-token', 'x-dev-user': 'alice' },
    });

    expect(res.statusCode).toBe(403);
    expect(res.json()).toEqual({ error: 'account_deleted' });
    await app.close();
  });

  it('dev mode: a live user still authenticates', async () => {
    currentUser = { id: 'u-2', deletedAt: null };
    const app = await buildApp(devConfig);

    const res = await app.inject({
      method: 'GET',
      url: '/whoami',
      headers: { authorization: 'Bearer dev-token', 'x-dev-user': 'bob' },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ user_id: 'u-2' });
    await app.close();
  });

  it('apple mode: a deleted user is 403, not silently re-upserted and served', async () => {
    currentUser = { id: 'u-3', deletedAt: new Date('2026-09-01T00:00:00Z') };
    const app = await buildApp(appleConfig);

    const res = await app.inject({
      method: 'GET',
      url: '/whoami',
      headers: { authorization: 'Bearer apple-identity-token' },
    });

    expect(res.statusCode).toBe(403);
    expect(res.json()).toEqual({ error: 'account_deleted' });
    await app.close();
  });

  it('apple mode: a live user still authenticates', async () => {
    currentUser = { id: 'u-4', deletedAt: null };
    const app = await buildApp(appleConfig);

    const res = await app.inject({
      method: 'GET',
      url: '/whoami',
      headers: { authorization: 'Bearer apple-identity-token' },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ user_id: 'u-4' });
    await app.close();
  });
});

// --- purge nulls captures.poses_json ----------------------------------------

interface PurgeSink {
  updates: { table: unknown; patch: Record<string, unknown> }[];
  deletedKeys: string[];
  completed: number;
}

function makePurgeDb(captureRows: unknown[], sink: PurgeSink) {
  return {
    select: () => ({
      from: (table: unknown) => ({
        where: async () => (table === captures ? captureRows : []),
      }),
    }),
    update: (table: unknown) => ({
      set: (patch: Record<string, unknown>) => ({
        where: async () => {
          sink.updates.push({ table, patch });
        },
      }),
    }),
    insert: (table: unknown) => ({
      values: () => ({ returning: async () => [{ id: 'job-x' }] }),
    }),
    execute: async () => {
      sink.completed += 1;
    },
  } as unknown as WorkerDeps['db'];
}

function purgeStorage(sink: PurgeSink): StorageDriver {
  return {
    kind: 'local',
    presignUpload: vi.fn(),
    presignDownload: vi.fn(),
    putObject: vi.fn(),
    getObject: vi.fn(),
    deleteObject: vi.fn(async (key: string) => {
      sink.deletedKeys.push(key);
    }),
  } as unknown as StorageDriver;
}

describe('purge job clears per-frame poses', () => {
  const capture = {
    id: 'cap-1',
    worldId: 'w-1',
    frameCount: 2,
    posesJson: [{ index: 0 }, { index: 1 }],
    r2FramesPrefix: 'captures/cap-1',
    createdAt: new Date(),
  };

  async function runPurge(payload: unknown, sink: PurgeSink) {
    const { processJob } = await import('../src/worker.js');
    const deps = {
      db: makePurgeDb([capture], sink),
      storage: purgeStorage(sink),
      provider: {} as WorkerDeps['provider'],
      config: devConfig,
      push: (async () => undefined) as unknown as WorkerDeps['push'],
    } as WorkerDeps;
    await processJob(deps, {
      id: 'job-1',
      kind: 'purge',
      worldId: 'w-1',
      payload,
    } as never);
  }

  it('nulls captures.poses_json for the purged world', async () => {
    const sink: PurgeSink = { updates: [], deletedKeys: [], completed: 0 };
    await runPurge(null, sink);

    const posePurge = sink.updates.find((u) => u.table === captures);
    expect(posePurge).toBeDefined();
    expect(posePurge!.patch).toEqual({ posesJson: null });
    // Frames still deleted, world row untouched (soft-delete is kept).
    expect(sink.deletedKeys).toContain('captures/cap-1/frame_0.heic');
    expect(sink.deletedKeys).toContain('captures/cap-1/frame_1.heic');
    expect(sink.updates.some((u) => u.table === worlds)).toBe(false);
    expect(sink.updates.some((u) => u.table === jobs)).toBe(false);
  });

  it('nulls poses on the frames-only (reaper) purge too', async () => {
    const sink: PurgeSink = { updates: [], deletedKeys: [], completed: 0 };
    await runPurge({ framesOnly: true }, sink);

    expect(sink.updates.some((u) => u.table === captures)).toBe(true);
    // framesOnly skips the world-asset keys…
    expect(sink.deletedKeys.some((k) => k.startsWith('worlds/'))).toBe(false);
    // …but still removes the frames.
    expect(sink.deletedKeys).toContain('captures/cap-1/frame_0.heic');
  });
});
