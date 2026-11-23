import { describe, it, expect, vi } from 'vitest';
import Fastify from 'fastify';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';

let currentDb: unknown;
vi.mock('../src/db/client.js', () => ({ getDb: () => currentDb }));

import { chargeScanQuota } from '../src/quota.js';
import { worldsRoutes } from '../src/routes/worlds.js';
import { worlds, captures, type World } from '../src/db/schema.js';
import { loadConfig } from '../src/config.js';
import type { Db } from '../src/db/client.js';
import type { StorageDriver } from '../src/storage/index.js';

// spec §10 R9 — the daily scan quota was a SELECT then an UPDATE, so two
// concurrent creates could both read `count = max - 1` and both write `max`,
// handing out one scan too many at exactly the limit that protects generation
// spend. It is now a single conditional UPDATE … RETURNING.

const config = loadConfig({
  DATABASE_URL: 'postgres://u:p@localhost:5432/db',
  DEV_AUTH_TOKEN: 't',
  DAILY_SCAN_QUOTA: '3',
} as NodeJS.ProcessEnv);

// --- the statement itself ----------------------------------------------------

describe('chargeScanQuota SQL', () => {
  const dialect = new PgDialect();

  async function render(rows: Record<string, unknown>[]) {
    const statements: { sql: string; params: unknown[] }[] = [];
    const db = {
      execute: async (q: SQL) => {
        statements.push(dialect.sqlToQuery(q));
        return { rows };
      },
    } as unknown as Db;
    const res = await chargeScanQuota(db, 'user-1', 3);
    return { res, statements };
  }

  it('checks and increments in ONE statement (no read-then-write window)', async () => {
    const { statements } = await render([
      { user_id: 'user-1', new_count: 1, reset_at: new Date('2026-09-18T00:00:00Z') },
    ]);

    expect(statements).toHaveLength(1);
    const text = statements[0]!.sql;
    expect(text).toContain('UPDATE users');
    expect(text).toContain('RETURNING');
    // The limit test lives in the UPDATE's own WHERE clause — that is what makes
    // Postgres serialize concurrent writers on the row.
    expect(text).toMatch(/daily_scan_count < \$\d+/);
    // Rolling-window semantics preserved: fresh window opens at 1 + now + 24h.
    expect(text).toContain('quota_reset_at IS NULL OR quota_reset_at <= now()');
    expect(text).toContain("now() + interval '24 hours'");
    expect(statements[0]!.params).toContain('user-1');
    expect(statements[0]!.params).toContain(3);
  });

  it('reports a charge with the persisted counter and window', async () => {
    const resetAt = new Date('2026-09-18T00:00:00Z');
    const { res } = await render([{ user_id: 'user-1', new_count: 2, reset_at: resetAt }]);
    expect(res).toEqual({ userFound: true, allowed: true, newCount: 2, resetAt });
  });

  it('reports a refusal with the window reset (retry_at) when the UPDATE matched nothing', async () => {
    const resetAt = new Date('2026-09-18T00:00:00Z');
    const { res } = await render([{ user_id: 'user-1', new_count: null, reset_at: resetAt }]);
    expect(res).toEqual({ userFound: true, allowed: false, newCount: null, resetAt });
  });

  it('reports a missing user when the join yields no row', async () => {
    const { res } = await render([]);
    expect(res.userFound).toBe(false);
    expect(res.allowed).toBe(false);
  });

  it('coerces driver string values (counts and timestamps) to their JS types', async () => {
    const { res } = await render([
      { user_id: 'user-1', new_count: '3', reset_at: '2026-09-18T00:00:00.000Z' },
    ]);
    expect(res.newCount).toBe(3);
    expect(res.resetAt).toBeInstanceOf(Date);
    expect(res.resetAt!.toISOString()).toBe('2026-09-18T00:00:00.000Z');
  });
});

// --- the route ---------------------------------------------------------------

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

function storage(): StorageDriver {
  return {
    kind: 'local',
    presignUpload: vi.fn(async (key: string) => ({
      url: `https://signed.example/${key}`,
      method: 'PUT' as const,
      headers: {},
    })),
    presignDownload: vi.fn(),
    putObject: vi.fn(),
    getObject: vi.fn(),
    deleteObject: vi.fn(),
    objectSize: vi.fn(async () => 1),
  } as unknown as StorageDriver;
}

function routeDb(quotaRows: Record<string, unknown>[], counter: { executes: number }) {
  return {
    select: () => ({
      from: () => {
        const chain = { where: () => chain, orderBy: () => chain, limit: async () => [] };
        return chain;
      },
    }),
    update: () => ({ set: () => ({ where: async () => undefined }) }),
    insert: (table: unknown) => ({
      values: () => ({
        returning: async () =>
          table === worlds
            ? [fakeWorld()]
            : table === captures
              ? [{ id: 'cap-1', worldId: 'w-1', frameCount: 1, r2FramesPrefix: null }]
              : [{ id: 'x' }],
      }),
    }),
    execute: async () => {
      counter.executes += 1;
      return { rows: quotaRows };
    },
  };
}

async function buildApp() {
  const app = Fastify();
  app.addHook('preHandler', async (req) => {
    req.userId = 'user-1';
  });
  worldsRoutes(app, { config, storage: storage() });
  await app.ready();
  return app;
}

describe('POST /v1/worlds quota enforcement', () => {
  it('creates the world when the charge succeeds, using exactly one quota statement', async () => {
    const counter = { executes: 0 };
    currentDb = routeDb(
      [{ user_id: 'user-1', new_count: 1, reset_at: new Date('2026-09-18T00:00:00Z') }],
      counter,
    );
    const app = await buildApp();

    const res = await app.inject({ method: 'POST', url: '/v1/worlds', payload: { frame_count: 1 } });

    expect(res.statusCode).toBe(201);
    expect(counter.executes).toBe(1);
    await app.close();
  });

  it('429s with retry_at when the conditional charge is refused', async () => {
    const counter = { executes: 0 };
    const resetAt = new Date('2026-09-18T00:00:00Z');
    currentDb = routeDb([{ user_id: 'user-1', new_count: null, reset_at: resetAt }], counter);
    const app = await buildApp();

    const res = await app.inject({ method: 'POST', url: '/v1/worlds', payload: { frame_count: 1 } });

    expect(res.statusCode).toBe(429);
    expect(res.json()).toEqual({
      error: 'scan_quota_exceeded',
      message: 'Daily scan limit reached.',
      retry_at: resetAt.toISOString(),
    });
    await app.close();
  });

  it('401s for an unknown user row', async () => {
    const counter = { executes: 0 };
    currentDb = routeDb([], counter);
    const app = await buildApp();

    const res = await app.inject({ method: 'POST', url: '/v1/worlds', payload: { frame_count: 1 } });

    expect(res.statusCode).toBe(401);
    expect(res.json()).toEqual({ error: 'unknown_user' });
    await app.close();
  });
});
