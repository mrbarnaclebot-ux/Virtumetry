import { describe, it, expect, vi } from 'vitest';
import Fastify from 'fastify';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';

// Mock the lazy DB module BEFORE importing the routes. The factory reads
// `currentDb` at call time, so each test swaps in its own fake.
let currentDb: unknown;
vi.mock('../src/db/client.js', () => ({
  getDb: () => currentDb,
}));

import { worldsRoutes } from '../src/routes/worlds.js';
import { worlds, captures, jobs, type World } from '../src/db/schema.js';
import { loadConfig } from '../src/config.js';
import type { StorageDriver } from '../src/storage/index.js';

// POST /v1/worlds/:id/frames:done — optional { poses } body contract.

const config = loadConfig({
  DATABASE_URL: 'postgres://u:p@localhost:5432/db',
  DEV_AUTH_TOKEN: 't',
} as NodeJS.ProcessEnv);

const storage = {
  kind: 'local',
  presignUpload: vi.fn(),
  presignDownload: vi.fn(async (key: string) => `https://signed.example/${key}`),
  putObject: vi.fn(),
  getObject: vi.fn(),
  deleteObject: vi.fn(),
} as unknown as StorageDriver;

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

interface DbState {
  world: World;
  capture: { id: string } | null;
  updates: { table: unknown; patch: Record<string, unknown> }[];
  inserts: { table: unknown; vals: Record<string, unknown> }[];
}

const dialect = new PgDialect();

/**
 * Would the route's conditional world flip match the fake row? Renders the
 * route's real WHERE clause and applies its IN-list to the row's status, so the
 * test exercises the predicate the route ships rather than a copy of it.
 */
function flipMatches(state: DbState, where: SQL): boolean {
  const { sql, params } = dialect.sqlToQuery(where);
  expect(sql).toContain('"deleted_at" is null');
  return state.world.deletedAt === null && params.slice(1).includes(state.world.status);
}

/** Minimal chainable stand-in for the drizzle calls this route makes. */
function makeFakeDb(state: DbState) {
  const db = {
    transaction: async <T>(fn: (tx: unknown) => Promise<T>) => fn(db),
    select: () => ({
      from: (table: unknown) => {
        const rows =
          table === worlds
            ? [state.world]
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
    update: (table: unknown) => ({
      set: (patch: Record<string, unknown>) => ({
        where: (where: SQL) => {
          // The world flip is conditional and read via RETURNING; the capture
          // write is awaited directly. Record only writes that actually apply.
          const applies = table !== worlds || flipMatches(state, where);
          if (applies) {
            state.updates.push({ table, patch });
            if (table === worlds) state.world = { ...state.world, ...patch } as World;
          }
          return Object.assign(Promise.resolve(), {
            returning: async () => (applies ? [state.world] : []),
          });
        },
      }),
    }),
    insert: (table: unknown) => ({
      values: (vals: Record<string, unknown>) => ({
        returning: async () => {
          state.inserts.push({ table, vals });
          return [{ id: 'job-1' }];
        },
      }),
    }),
  };
  return db;
}

async function makeApp(state: DbState) {
  currentDb = makeFakeDb(state);
  const app = Fastify();
  // Stand-in for the auth preHandler: attach the owner's user id.
  app.addHook('preHandler', async (req) => {
    (req as { userId?: string }).userId = 'user-1';
  });
  worldsRoutes(app, { config, storage });
  await app.ready();
  return app;
}

function freshState(): DbState {
  return { world: fakeWorld(), capture: { id: 'cap-1' }, updates: [], inserts: [] };
}

const validPose = {
  index: 0,
  timestamp: 1.25,
  transform: Array.from({ length: 16 }, (_v, i) => i * 0.5),
  intrinsics: Array.from({ length: 9 }, (_v, i) => i + 1),
  exposureLocked: true,
};

describe('POST /v1/worlds/:id/frames:done', () => {
  it('no body → unchanged behavior: status=stitching, stitch job, no capture write', async () => {
    const state = freshState();
    const app = await makeApp(state);
    const res = await app.inject({ method: 'POST', url: '/v1/worlds/w-1/frames:done' });

    expect(res.statusCode).toBe(200);
    expect(res.json().job_id).toBe('job-1');
    // Exactly one update — the world's status. Captures untouched.
    expect(state.updates).toHaveLength(1);
    expect(state.updates[0]!.table).toBe(worlds);
    // Status flip + progress reset + heartbeat touch, in one update.
    expect(state.updates[0]!.patch).toEqual({
      status: 'stitching',
      progress: null,
      updatedAt: expect.any(Date),
    });
    expect(state.inserts).toHaveLength(1);
    expect(state.inserts[0]!.table).toBe(jobs);
    expect(state.inserts[0]!.vals['kind']).toBe('stitch');
    await app.close();
  });

  it('valid poses → stored verbatim (incl. extra keys) into captures.poses_json', async () => {
    const state = freshState();
    const app = await makeApp(state);
    const pose = { ...validPose, arkitTrackingState: 'normal' }; // extra field kept.
    const res = await app.inject({
      method: 'POST',
      url: '/v1/worlds/w-1/frames:done',
      payload: { poses: [pose] },
    });

    expect(res.statusCode).toBe(200);
    const captureUpdate = state.updates.find((u) => u.table === captures);
    expect(captureUpdate).toBeDefined();
    expect(captureUpdate!.patch['posesJson']).toEqual([pose]);
    // World/job flow still ran.
    expect(state.updates.some((u) => u.table === worlds)).toBe(true);
    expect(state.inserts[0]!.vals['kind']).toBe('stitch');
    await app.close();
  });

  it('capture v2 pose fields → stored verbatim alongside unknown extras', async () => {
    const state = freshState();
    const app = await makeApp(state);
    const pose = {
      ...validPose,
      iso: 320,
      exposureDuration: 0.008,
      featureDepthMedian: 2.4,
      depth: { width: 256, height: 192 },
      futureField: 'kept',
    };
    const res = await app.inject({
      method: 'POST',
      url: '/v1/worlds/w-1/frames:done',
      payload: { poses: [pose, validPose] },
    });

    expect(res.statusCode).toBe(200);
    const captureUpdate = state.updates.find((u) => u.table === captures);
    expect(captureUpdate!.patch['posesJson']).toEqual([pose, validPose]);
    await app.close();
  });

  it.each([
    ['iso as a string', { iso: '320' }],
    ['negative exposureDuration', { exposureDuration: -1 }],
    ['null featureDepthMedian', { featureDepthMedian: null }],
    ['depth missing height', { depth: { width: 256 } }],
    ['fractional depth width', { depth: { width: 256.5, height: 192 } }],
    ['depth as a boolean', { depth: true }],
  ])('malformed v2 field (%s) → 400, no state change', async (_name, extra) => {
    const state = freshState();
    const app = await makeApp(state);
    const res = await app.inject({
      method: 'POST',
      url: '/v1/worlds/w-1/frames:done',
      payload: { poses: [{ ...validPose, ...extra }] },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('invalid_body');
    expect(state.updates).toHaveLength(0);
    expect(state.inserts).toHaveLength(0);
    await app.close();
  });

  it('empty poses array → 200, no capture write', async () => {
    const state = freshState();
    const app = await makeApp(state);
    const res = await app.inject({
      method: 'POST',
      url: '/v1/worlds/w-1/frames:done',
      payload: { poses: [] },
    });
    expect(res.statusCode).toBe(200);
    expect(state.updates.some((u) => u.table === captures)).toBe(false);
    expect(state.inserts).toHaveLength(1);
    await app.close();
  });

  it('invalid poses shape → 400 and NO state change (no status update, no job)', async () => {
    const state = freshState();
    const app = await makeApp(state);
    const res = await app.inject({
      method: 'POST',
      url: '/v1/worlds/w-1/frames:done',
      payload: {
        poses: [{ ...validPose, transform: validPose.transform.slice(0, 15) }],
      },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('invalid_body');
    expect(state.updates).toHaveLength(0); // world untouched…
    expect(state.inserts).toHaveLength(0); // …and no stitch job enqueued.
    await app.close();
  });

  it('replay after draft_ready → 200 with current world, no job, no writes', async () => {
    // iOS stranded-session recovery replays frames:done when a response was
    // lost. Re-stitching here would enqueue a second billable generate_draft.
    const state = freshState();
    state.world.status = 'draft_ready';
    const app = await makeApp(state);
    const res = await app.inject({
      method: 'POST',
      url: '/v1/worlds/w-1/frames:done',
      payload: { poses: [validPose] },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().job_id).toBeNull();
    expect(res.json().world.status).toBe('draft_ready');
    expect(state.updates).toHaveLength(0); // no status flip, no poses overwrite
    expect(state.inserts).toHaveLength(0); // no stitch job
    await app.close();
  });

  it.each(['stitching', 'generating_draft', 'generating_hq', 'complete'] as const)(
    'replay while %s → no job enqueued',
    async (status) => {
      const state = freshState();
      state.world.status = status;
      const app = await makeApp(state);
      const res = await app.inject({ method: 'POST', url: '/v1/worlds/w-1/frames:done' });
      expect(res.statusCode).toBe(200);
      expect(state.inserts).toHaveLength(0);
      expect(state.world.status).toBe(status);
      await app.close();
    },
  );

  it('after failed_stitch → re-stitch allowed', async () => {
    const state = freshState();
    state.world.status = 'failed_stitch';
    const app = await makeApp(state);
    const res = await app.inject({ method: 'POST', url: '/v1/worlds/w-1/frames:done' });
    expect(res.statusCode).toBe(200);
    expect(res.json().job_id).toBe('job-1');
    expect(state.world.status).toBe('stitching');
    expect(state.inserts[0]!.vals['kind']).toBe('stitch');
    await app.close();
  });

  it('rejects > 64 poses', async () => {
    const state = freshState();
    const app = await makeApp(state);
    const res = await app.inject({
      method: 'POST',
      url: '/v1/worlds/w-1/frames:done',
      payload: { poses: Array.from({ length: 65 }, (_v, i) => ({ ...validPose, index: i })) },
    });
    expect(res.statusCode).toBe(400);
    expect(state.updates).toHaveLength(0);
    await app.close();
  });
});
