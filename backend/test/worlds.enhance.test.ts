import { describe, it, expect, vi } from 'vitest';
import Fastify from 'fastify';

// Mock the lazy DB module BEFORE importing the routes. The factory reads
// `currentDb` at call time, so each test swaps in its own fake.
let currentDb: unknown;
vi.mock('../src/db/client.js', () => ({
  getDb: () => currentDb,
}));

import { worldsRoutes } from '../src/routes/worlds.js';
import { worlds, jobs, type World } from '../src/db/schema.js';
import { loadConfig } from '../src/config.js';
import type { StorageDriver } from '../src/storage/index.js';

// POST /v1/worlds/{id}:enhance — the spec §7.1 custom-method path the iOS client
// calls (literal colon), plus the legacy `/enhance` alias.
//
// The two things worth a test here are money-shaped: the route must actually
// RESOLVE (it did not — the app's Enhance button 404'd for the whole life of the
// feature), and it must enqueue AT MOST ONE `generate_hq` job per draft, because
// each one is a marble-1.1 generation (1500 credits).

const config = loadConfig({
  DATABASE_URL: 'postgres://u:p@localhost:5432/db',
  DEV_AUTH_TOKEN: 't',
} as NodeJS.ProcessEnv);

const WORLD_ID = '11111111-2222-3333-4444-555555555555';

const storage = {
  kind: 'local',
  presignUpload: vi.fn(),
  presignDownload: vi.fn(async (key: string) => `https://signed.example/${key}`),
  putObject: vi.fn(),
  getObject: vi.fn(),
  deleteObject: vi.fn(),
} as unknown as StorageDriver;

function fakeWorld(status = 'draft_ready'): World {
  return {
    id: WORLD_ID,
    ownerId: 'user-1',
    title: null,
    caption: null,
    lat: null,
    lng: null,
    placeName: null,
    isPublic: false,
    status,
    phase: null,
    progress: 100,
    panoUrl: 'worlds/w/pano.jpg',
    thumbnailUrl: null,
    spz100kUrl: null,
    spz500kUrl: null,
    spzFullUrl: null,
    colliderGlbUrl: null,
    assetVersion: 1,
    provider: 'mock',
    draftWorldId: 'pw-draft',
    hqWorldId: null,
    draftModel: 'marble-1.0-draft',
    hqModel: null,
    creditsSpent: 150,
    createdAt: new Date('2026-07-12T10:00:00Z'),
    updatedAt: new Date('2026-07-12T10:00:00Z'),
    deletedAt: null,
  };
}

interface DbState {
  /** undefined models the ownership-filtered query returning no row. */
  world: World | undefined;
  updates: { table: unknown; patch: Record<string, unknown> }[];
  inserts: { table: unknown; vals: Record<string, unknown> }[];
  /** Thrown by the world SELECT — models a Postgres 22P02 on a non-uuid id. */
  selectError?: unknown;
  /** What budgetFits reads as today's spend. */
  creditsSpentToday?: number;
}

/**
 * Chainable stand-in for the drizzle calls the enhance route makes. The UPDATE
 * is the interesting one: it mirrors the real conditional
 * `WHERE status = 'draft_ready'` by only "matching" while the in-memory world is
 * still draft_ready, and returns the mutated row — so a second request through
 * the same fake sees exactly what a second request would see in Postgres.
 */
function makeFakeDb(state: DbState) {
  const db = {
    transaction: async <T>(fn: (tx: unknown) => Promise<T>) => fn(db),
    select: () => ({
      from: (table: unknown) => {
        const chain = {
          where: () => chain,
          orderBy: () => chain,
          limit: async () => {
            if (state.selectError) throw state.selectError;
            return table === worlds && state.world ? [state.world] : [];
          },
        };
        return chain;
      },
    }),
    update: (table: unknown) => ({
      set: (patch: Record<string, unknown>) => ({
        where: () => ({
          returning: async () => {
            // Conditional update: only the request that finds the world still
            // in draft_ready flips it (and therefore gets a row back). Only the
            // enhance flip is modelled; frames:done's flip never matches a
            // draft_ready world, so it matches nothing here either.
            if (table !== worlds || patch['status'] !== 'generating_hq') return [];
            if (state.world?.status !== 'draft_ready') return [];
            state.updates.push({ table, patch });
            state.world = { ...state.world, ...(patch as Partial<World>) };
            return [state.world];
          },
        }),
      }),
    }),
    insert: (table: unknown) => ({
      values: (vals: Record<string, unknown>) => ({
        returning: async () => {
          state.inserts.push({ table, vals });
          return [{ id: `job-${state.inserts.length}` }];
        },
      }),
    }),
    // budgetFits' SUM over today's credit_events.
    execute: async () => ({ rows: [{ total: state.creditsSpentToday ?? 0 }] }),
  };
  return db;
}

async function makeApp(state: DbState, cfg = config) {
  currentDb = makeFakeDb(state);
  const app = Fastify();
  // Stand-in for the auth preHandler: attach the owner's user id.
  app.addHook('preHandler', async (req) => {
    (req as { userId?: string }).userId = 'user-1';
  });
  worldsRoutes(app, { config: cfg, storage });
  await app.ready();
  return app;
}

function freshState(status = 'draft_ready'): DbState {
  return { world: fakeWorld(status), updates: [], inserts: [] };
}

const COLON_URL = `/v1/worlds/${WORLD_ID}:enhance`;
const ENCODED_URL = `/v1/worlds/${WORLD_ID}%3Aenhance`;
const SLASH_URL = `/v1/worlds/${WORLD_ID}/enhance`;

describe('POST /v1/worlds/{id}:enhance', () => {
  it('spec colon path: 200, status→generating_hq, one generate_hq job', async () => {
    const state = freshState();
    const app = await makeApp(state);
    const res = await app.inject({ method: 'POST', url: COLON_URL });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    // The regex-constrained param must yield the BARE id — a route string of
    // `:id::enhance` would hand the handler `<uuid>:enhance` instead.
    expect(body.world.id).toBe(WORLD_ID);
    expect(body.world.status).toBe('generating_hq');
    expect(body.job_id).toBe('job-1');

    expect(state.updates).toHaveLength(1);
    expect(state.updates[0]!.patch).toEqual({
      status: 'generating_hq',
      progress: null,
      updatedAt: expect.any(Date),
    });
    expect(state.inserts).toHaveLength(1);
    expect(state.inserts[0]!.table).toBe(jobs);
    expect(state.inserts[0]!.vals['kind']).toBe('generate_hq');
    expect(state.inserts[0]!.vals['worldId']).toBe(WORLD_ID);
    await app.close();
  });

  it('percent-encoded colon (…%3Aenhance) reaches the same handler', async () => {
    const state = freshState();
    const app = await makeApp(state);
    const res = await app.inject({ method: 'POST', url: ENCODED_URL });

    expect(res.statusCode).toBe(200);
    // The param is decoded — no stray %3A, no `:enhance` suffix.
    expect(res.json().world.id).toBe(WORLD_ID);
    expect(state.inserts[0]!.vals['kind']).toBe('generate_hq');
    await app.close();
  });

  it('legacy slash alias still works and shares the handler', async () => {
    const state = freshState();
    const app = await makeApp(state);
    const res = await app.inject({ method: 'POST', url: SLASH_URL });

    expect(res.statusCode).toBe(200);
    expect(res.json().world.status).toBe('generating_hq');
    expect(state.inserts).toHaveLength(1);
    expect(state.inserts[0]!.vals['kind']).toBe('generate_hq');
    await app.close();
  });

  it("someone else's (or a missing) world → 404, no job", async () => {
    const state: DbState = { world: undefined, updates: [], inserts: [] };
    const app = await makeApp(state);
    const res = await app.inject({ method: 'POST', url: COLON_URL });

    expect(res.statusCode).toBe(404);
    expect(res.json().error).toBe('world_not_found');
    expect(state.inserts).toHaveLength(0);
    await app.close();
  });

  it('world not in draft_ready → 409 not_enhanceable, no job', async () => {
    const state = freshState('generating_draft');
    const app = await makeApp(state);
    const res = await app.inject({ method: 'POST', url: COLON_URL });

    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({
      error: 'not_enhanceable',
      status: 'generating_draft',
    });
    expect(state.updates).toHaveLength(0);
    expect(state.inserts).toHaveLength(0);
    await app.close();
  });

  it('an HQ that cannot fit today\'s credit budget → 429 credit_budget_exceeded, no flip', async () => {
    const live = loadConfig({
      DATABASE_URL: 'postgres://u:p@localhost:5432/db',
      DEV_AUTH_TOKEN: 't',
      PROVIDER_MODE: 'live',
      DAILY_CREDIT_BUDGET: '2000',
    } as NodeJS.ProcessEnv);
    const state: DbState = { ...freshState(), creditsSpentToday: 600 }; // 600 + 1500 > 2000
    const app = await makeApp(state, live);
    const res = await app.inject({ method: 'POST', url: COLON_URL });

    expect(res.statusCode).toBe(429);
    expect(res.json()).toMatchObject({
      error: 'credit_budget_exceeded',
      message: expect.any(String),
      retry_at: expect.any(String),
    });
    // Distinct from the per-user scan quota code.
    expect(res.json().error).not.toBe('scan_quota_exceeded');
    expect(state.updates).toHaveLength(0);
    expect(state.inserts).toHaveLength(0);
    await app.close();
  });

  it('double-submit enqueues EXACTLY ONE generate_hq (1500 credits each)', async () => {
    const state = freshState();
    const app = await makeApp(state);

    const [first, second] = await Promise.all([
      app.inject({ method: 'POST', url: COLON_URL }),
      app.inject({ method: 'POST', url: COLON_URL }),
    ]);

    const codes = [first!.statusCode, second!.statusCode].sort();
    expect(codes).toEqual([200, 409]);
    const loser = first!.statusCode === 409 ? first! : second!;
    expect(loser.json()).toMatchObject({
      error: 'not_enhanceable',
      status: 'generating_hq',
    });
    // The whole point: one flip, one job.
    expect(state.updates).toHaveLength(1);
    expect(state.inserts).toHaveLength(1);
    await app.close();
  });

  it('a sequential retry after the flip also gets 409 and enqueues nothing', async () => {
    const state = freshState();
    const app = await makeApp(state);

    const first = await app.inject({ method: 'POST', url: COLON_URL });
    expect(first.statusCode).toBe(200);
    const retry = await app.inject({ method: 'POST', url: SLASH_URL });

    expect(retry.statusCode).toBe(409);
    expect(retry.json().status).toBe('generating_hq');
    expect(state.inserts).toHaveLength(1);
    await app.close();
  });

  it('GET on the :enhance URL is a clean 4xx, never a 500', async () => {
    // `GET /v1/worlds/<uuid>:enhance` matches GET /v1/worlds/:id with a garbage
    // id; Postgres answers 22P02 on the uuid cast, which must read as "no such
    // world" rather than escaping as an unhandled 500.
    const state: DbState = {
      world: fakeWorld(),
      updates: [],
      inserts: [],
      selectError: Object.assign(new Error('invalid input syntax for type uuid'), {
        code: '22P02',
      }),
    };
    const app = await makeApp(state);
    const res = await app.inject({ method: 'GET', url: COLON_URL });

    expect(res.statusCode).toBe(404);
    expect(res.json().error).toBe('world_not_found');
    await app.close();
  });

  it('DELETE on the :enhance URL likewise does not delete or 500', async () => {
    const state: DbState = {
      world: fakeWorld(),
      updates: [],
      inserts: [],
      selectError: Object.assign(new Error('invalid input syntax for type uuid'), {
        code: '22P02',
      }),
    };
    const app = await makeApp(state);
    const res = await app.inject({ method: 'DELETE', url: COLON_URL });

    expect(res.statusCode).toBe(404);
    expect(state.inserts).toHaveLength(0); // no purge job
    await app.close();
  });

  it('a non-22P02 DB error is NOT swallowed', async () => {
    const state: DbState = {
      world: fakeWorld(),
      updates: [],
      inserts: [],
      selectError: Object.assign(new Error('connection terminated'), { code: '08006' }),
    };
    const app = await makeApp(state);
    const res = await app.inject({ method: 'POST', url: COLON_URL });

    expect(res.statusCode).toBe(500);
    expect(state.inserts).toHaveLength(0);
    await app.close();
  });

  it('sibling colon routes and the plain GET/DELETE are not shadowed', async () => {
    const state = freshState();
    const app = await makeApp(state);

    // The enhance route is a parametric node with a static ending, which
    // find-my-way prioritises over the bare `:id` node — make sure that does not
    // swallow the ordinary world routes.
    const get = await app.inject({ method: 'GET', url: `/v1/worlds/${WORLD_ID}` });
    expect(get.statusCode).toBe(200);
    expect(get.json().world.id).toBe(WORLD_ID);

    const framesDone = await app.inject({
      method: 'POST',
      url: `/v1/worlds/${WORLD_ID}/frames:done`,
    });
    // Reached the frames:done handler (not enhance): a draft_ready world is a
    // replay, so it answers 200 with no job instead of flipping to generating_hq.
    expect(framesDone.statusCode).toBe(200);
    expect(framesDone.json().job_id).toBeNull();
    expect(state.inserts).toHaveLength(0);

    const del = await app.inject({ method: 'DELETE', url: `/v1/worlds/${WORLD_ID}` });
    expect(del.statusCode).toBe(200);
    expect(state.inserts.at(-1)!.vals['kind']).toBe('purge');
    await app.close();
  });
});
