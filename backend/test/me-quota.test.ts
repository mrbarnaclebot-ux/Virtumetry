import { describe, it, expect, vi } from 'vitest';
import Fastify from 'fastify';

// Mock the lazy DB module BEFORE importing the routes (frames-done pattern).
let currentDb: unknown;
vi.mock('../src/db/client.js', () => ({
  getDb: () => currentDb,
}));

import { meRoutes } from '../src/routes/me.js';
import { users } from '../src/db/schema.js';
import { loadConfig } from '../src/config.js';
import type { StorageDriver } from '../src/storage/index.js';

// GET /v1/me/quota — pre-capture allowance check. DAILY_SCAN_QUOTA defaults 10.
const config = loadConfig({
  DATABASE_URL: 'postgres://u:p@localhost:5432/db',
  DEV_AUTH_TOKEN: 't',
} as NodeJS.ProcessEnv);

const storage = { kind: 'local' } as unknown as StorageDriver;

interface FakeUser {
  id: string;
  dailyScanCount: number;
  quotaResetAt: Date | null;
}

/** Minimal chainable stand-in returning the single user row this route reads. */
function makeFakeDb(user: FakeUser | null) {
  return {
    select: () => ({
      from: (table: unknown) => {
        const rows = table === users && user ? [user] : [];
        const chain = {
          where: () => chain,
          limit: async () => rows,
        };
        return chain;
      },
    }),
  };
}

async function makeApp(user: FakeUser | null) {
  currentDb = makeFakeDb(user);
  const app = Fastify();
  app.addHook('preHandler', async (req) => {
    (req as { userId?: string }).userId = 'user-1';
  });
  meRoutes(app, { config, storage });
  await app.ready();
  return app;
}

describe('GET /v1/me/quota', () => {
  it('fresh user (no window) → full remaining, null reset', async () => {
    const app = await makeApp({ id: 'user-1', dailyScanCount: 0, quotaResetAt: null });
    const res = await app.inject({ method: 'GET', url: '/v1/me/quota' });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      scans_remaining: 10,
      quota_resets_at: null,
      daily_quota: 10,
    });
    await app.close();
  });

  it('exhausted user (active window) → 0 remaining + reset time', async () => {
    const resetAt = new Date(Date.now() + 6 * 60 * 60 * 1000); // 6h ahead.
    const app = await makeApp({ id: 'user-1', dailyScanCount: 10, quotaResetAt: resetAt });
    const res = await app.inject({ method: 'GET', url: '/v1/me/quota' });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.scans_remaining).toBe(0);
    expect(body.daily_quota).toBe(10);
    expect(new Date(body.quota_resets_at).getTime()).toBe(resetAt.getTime());
    await app.close();
  });

  it('passed-reset-window user → full remaining, null reset', async () => {
    const resetAt = new Date(Date.now() - 60 * 1000); // 1min in the past.
    const app = await makeApp({ id: 'user-1', dailyScanCount: 10, quotaResetAt: resetAt });
    const res = await app.inject({ method: 'GET', url: '/v1/me/quota' });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      scans_remaining: 10,
      quota_resets_at: null,
      daily_quota: 10,
    });
    await app.close();
  });
});
