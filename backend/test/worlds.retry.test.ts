import { describe, it, expect, vi } from 'vitest';
import Fastify from 'fastify';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';

let currentDb: unknown;
vi.mock('../src/db/client.js', () => ({ getDb: () => currentDb }));

import { worldsRoutes } from '../src/routes/worlds.js';
import { worlds, jobs, type World } from '../src/db/schema.js';
import { loadConfig } from '../src/config.js';
import type { StorageDriver } from '../src/storage/index.js';

// POST /v1/worlds/{id}:retry — re-run the phase a world failed in. Money-shaped
// like enhance: a double tap must enqueue at most one job, and a draft retry
// must go through the scan quota exactly like the create that paid for the
// first draft.

const config = loadConfig({
  DATABASE_URL: 'postgres://u:p@localhost:5432/db',
  DEV_AUTH_TOKEN: 't',
} as NodeJS.ProcessEnv);

const WORLD_ID = '11111111-2222-3333-4444-555555555555';
const URL = `/v1/worlds/${WORLD_ID}:retry`;
const dialect = new PgDialect();

function fakeWorld(status: string, overrides: Partial<World> = {}): World {
  return {
    id: WORLD_ID, ownerId: 'user-1', title: null, caption: null, lat: null, lng: null,
    placeName: null, isPublic: false, status, phase: null, progress: 40,
    panoUrl: 'worlds/w/pano.jpg', thumbnailUrl: null, spz100kUrl: null,
    spz500kUrl: null, spzFullUrl: null, colliderGlbUrl: null, assetVersion: 1,
    provider: 'mock', draftWorldId: 'pw-draft', hqWorldId: null,
    draftModel: 'marble-1.0-draft', hqModel: null, creditsSpent: 150,
    createdAt: new Date('2026-07-12T10:00:00Z'),
    updatedAt: new Date('2026-07-12T10:00:00Z'), deletedAt: null,
    ...overrides,
  } as World;
}

interface DbState {
  /** undefined models the owner-filtered query finding nothing. */
  world: World | undefined;
  inserts: { table: unknown; vals: Record<string, unknown> }[];
  quotaCharges: number;
  quotaAllowed: boolean;
  creditsSpentToday: number;
}

/**
 * Fake drizzle db. The world UPDATE applies the route's real WHERE clause (id +
 * expected status), so a second request sees what it would see in Postgres;
 * transaction() restores the world when its callback throws (rollback).
 */
function makeFakeDb(state: DbState) {
  const db = {
    transaction: async <T>(fn: (tx: unknown) => Promise<T>): Promise<T> => {
      const snapshot = state.world;
      const inserts = state.inserts.length;
      try {
        return await fn(db);
      } catch (err) {
        state.world = snapshot;
        state.inserts.length = inserts;
        throw err;
      }
    },
    select: () => ({
      from: () => {
        const chain = {
          where: () => chain,
          orderBy: () => chain,
          limit: async () => (state.world ? [state.world] : []),
        };
        return chain;
      },
    }),
    update: (table: unknown) => ({
      set: (patch: Record<string, unknown>) => ({
        where: (where: SQL) => ({
          returning: async () => {
            const { sql, params } = dialect.sqlToQuery(where);
            expect(sql).toContain('"deleted_at" is null');
            const w = state.world;
            if (table !== worlds || !w || w.deletedAt || params[1] !== w.status) return [];
            state.world = { ...w, ...(patch as Partial<World>) };
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
    // budgetFits' SUM over credit_events, or chargeScanQuota's single statement.
    execute: async (q: SQL) => {
      if (dialect.sqlToQuery(q).sql.includes('credit_events')) {
        return { rows: [{ total: state.creditsSpentToday }] };
      }
      state.quotaCharges += 1;
      const reset = new Date('2026-07-13T10:00:00Z');
      return {
        rows: [{ user_id: 'user-1', new_count: state.quotaAllowed ? 1 : null, reset_at: reset }],
      };
    },
  };
  return db;
}

async function makeApp(state: DbState, cfg = config) {
  currentDb = makeFakeDb(state);
  const app = Fastify();
  app.addHook('preHandler', async (req) => {
    (req as { userId?: string }).userId = 'user-1';
  });
  worldsRoutes(app, { config: cfg, storage: {} as StorageDriver });
  await app.ready();
  return app;
}

function freshState(world: World | undefined, quotaAllowed = true): DbState {
  return { world, inserts: [], quotaCharges: 0, quotaAllowed, creditsSpentToday: 0 };
}

describe('POST /v1/worlds/{id}:retry', () => {
  it.each([
    ['failed_stitch', 'stitching', 'stitch', 0],
    ['failed_generating_draft', 'generating_draft', 'generate_draft', 1],
    ['failed_generating_hq', 'generating_hq', 'generate_hq', 0],
  ] as const)('%s → %s + one %s job (scan charges: %i)', async (from, to, kind, charges) => {
    const state = freshState(fakeWorld(from));
    const app = await makeApp(state);
    const res = await app.inject({ method: 'POST', url: URL });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.world.id).toBe(WORLD_ID); // bare id from the regex param
    expect(body.world.status).toBe(to);
    expect(body.world.progress).toBeNull();
    expect(body.job_id).toBe('job-1');
    expect(state.inserts).toHaveLength(1);
    expect(state.inserts[0]!.table).toBe(jobs);
    expect(state.inserts[0]!.vals).toMatchObject({ kind, worldId: WORLD_ID });
    expect(state.quotaCharges).toBe(charges);
    await app.close();
  });

  it('double tap: the second call enqueues nothing and returns the world with job_id null', async () => {
    const state = freshState(fakeWorld('failed_generating_draft'));
    const app = await makeApp(state);

    const first = await app.inject({ method: 'POST', url: URL });
    const second = await app.inject({ method: 'POST', url: URL });

    expect(first.json().job_id).toBe('job-1');
    expect(second.statusCode).toBe(200);
    expect(second.json()).toMatchObject({
      world: { status: 'generating_draft' },
      job_id: null,
    });
    expect(state.inserts).toHaveLength(1);
    expect(state.quotaCharges).toBe(1); // the replay is never charged
    await app.close();
  });

  it('concurrent double tap: exactly one job', async () => {
    const state = freshState(fakeWorld('failed_generating_hq'));
    const app = await makeApp(state);

    const results = await Promise.all([
      app.inject({ method: 'POST', url: URL }),
      app.inject({ method: 'POST', url: URL }),
    ]);

    expect(results.map((r) => r.statusCode)).toEqual([200, 200]);
    expect(results.filter((r) => r.json().job_id !== null)).toHaveLength(1);
    expect(state.inserts).toHaveLength(1);
    await app.close();
  });

  it.each(['draft_ready', 'complete', 'uploading', 'failed_upload'])(
    'status %s → 409 not_retryable, nothing written',
    async (status) => {
      const state = freshState(fakeWorld(status));
      const app = await makeApp(state);
      const res = await app.inject({ method: 'POST', url: URL });

      expect(res.statusCode).toBe(409);
      expect(res.json()).toEqual({ error: 'not_retryable', status });
      expect(state.world!.status).toBe(status);
      expect(state.inserts).toHaveLength(0);
      await app.close();
    },
  );

  it('draft retry without a pano → 409 (the generation could never start)', async () => {
    const state = freshState(fakeWorld('failed_generating_draft', { panoUrl: null }));
    const app = await makeApp(state);
    const res = await app.inject({ method: 'POST', url: URL });

    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe('not_retryable');
    expect(state.inserts).toHaveLength(0);
    expect(state.quotaCharges).toBe(0);
    await app.close();
  });

  it('HQ retry without a draft world → 409 (mirrors enhance needing draft_ready)', async () => {
    const state = freshState(fakeWorld('failed_generating_hq', { draftWorldId: null }));
    const app = await makeApp(state);
    const res = await app.inject({ method: 'POST', url: URL });

    expect(res.statusCode).toBe(409);
    expect(state.inserts).toHaveLength(0);
    await app.close();
  });

  it('draft retry over the scan quota → 429, flip rolled back, no job', async () => {
    const state = freshState(fakeWorld('failed_generating_draft'), false);
    const app = await makeApp(state);
    const res = await app.inject({ method: 'POST', url: URL });

    expect(res.statusCode).toBe(429);
    expect(res.json().error).toBe('scan_quota_exceeded');
    expect(res.json().retry_at).toBe('2026-07-13T10:00:00.000Z');
    expect(state.world!.status).toBe('failed_generating_draft');
    expect(state.inserts).toHaveLength(0);
    await app.close();
  });

  it.each([
    ['failed_generating_draft', 1900], // 1900 + 150 > 2000
    ['failed_generating_hq', 600], // 600 + 1500 > 2000
  ] as const)(
    '%s over the daily credit budget → 429 credit_budget_exceeded, no flip, no scan charged',
    async (status, spent) => {
      const live = loadConfig({
        DATABASE_URL: 'postgres://u:p@localhost:5432/db',
        DEV_AUTH_TOKEN: 't',
        PROVIDER_MODE: 'live',
        DAILY_CREDIT_BUDGET: '2000',
      } as NodeJS.ProcessEnv);
      const state = { ...freshState(fakeWorld(status)), creditsSpentToday: spent };
      const app = await makeApp(state, live);
      const res = await app.inject({ method: 'POST', url: URL });

      expect(res.statusCode).toBe(429);
      expect(res.json().error).toBe('credit_budget_exceeded');
      expect(state.world!.status).toBe(status);
      expect(state.inserts).toHaveLength(0);
      expect(state.quotaCharges).toBe(0);
      await app.close();
    },
  );

  it("someone else's (or a deleted) world → 404, nothing written", async () => {
    const state = freshState(undefined);
    const app = await makeApp(state);
    const res = await app.inject({ method: 'POST', url: URL });

    expect(res.statusCode).toBe(404);
    expect(res.json().error).toBe('world_not_found');
    expect(state.inserts).toHaveLength(0);
    await app.close();
  });

  it('does not shadow :enhance', async () => {
    const state = freshState(fakeWorld('failed_generating_hq'));
    const app = await makeApp(state);
    const res = await app.inject({ method: 'POST', url: `/v1/worlds/${WORLD_ID}:enhance` });

    // Reached the enhance handler: a failed world is not enhanceable.
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe('not_enhanceable');
    await app.close();
  });
});
