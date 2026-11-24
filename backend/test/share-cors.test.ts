import { describe, it, expect, afterEach, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import pg from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';

// A pool that never connects (nothing here may reach a DB): every assertion is
// answered before any query.
vi.mock('../src/db/client.js', () => ({
  getDb: () => drizzle(new pg.Pool({ connectionString: 'postgres://u:p@127.0.0.1:1/none' })),
  closeDb: async () => {},
}));

import { buildSessionApp } from './helpers/auth-app.js';
import type { Db } from '../src/db/client.js';

// D-21 / T-05-19 / T-05-41: public CORS lives only in the /v1/public scope, the
// session-mode app still boots next to the Better Auth cors scope, and with no
// WEB_SHARE_ORIGIN the public routes degrade to 503 instead of failing boot.

const SLUG = 'A'.repeat(22);
let app: FastifyInstance | undefined;

async function build(env: Record<string, string> = {}) {
  const db = drizzle(new pg.Pool({ connectionString: 'postgres://u:p@127.0.0.1:1/none' })) as unknown as Db;
  app = (await buildSessionApp({ db, env })).app;
  await app.ready();
  return app;
}

afterEach(async () => {
  await app?.close();
  app = undefined;
});

const preflight = (a: FastifyInstance, origin: string, url = '/v1/public/shares/x') =>
  a.inject({
    method: 'OPTIONS',
    url,
    headers: { origin, 'access-control-request-method': 'POST' },
  });

describe('WEB_SHARE_ORIGIN unset', () => {
  it('boots; public routes answer 503 share_unavailable; no CORS', async () => {
    const a = await build();
    const get = await a.inject({ method: 'GET', url: `/v1/public/shares/${SLUG}` });
    expect(get.statusCode).toBe(503);
    expect(JSON.parse(get.body)).toEqual({ error: 'share_unavailable' });
    const open = await a.inject({ method: 'POST', url: `/v1/public/shares/${SLUG}/open` });
    expect(open.statusCode).toBe(503);
    expect(JSON.parse(open.body)).toEqual({ error: 'share_unavailable' });
    const pre = await preflight(a, 'https://anything.test');
    expect(pre.headers['access-control-allow-origin']).toBeUndefined();
  });
});

describe('WEB_SHARE_ORIGIN set', () => {
  it('allows only the share origin, only on /v1/public', async () => {
    const a = await build({ WEB_SHARE_ORIGIN: 'https://share.test' });
    const ok = await preflight(a, 'https://share.test');
    expect(ok.headers['access-control-allow-origin']).toBe('https://share.test');
    const evil = await preflight(a, 'https://evil.test');
    expect(evil.headers['access-control-allow-origin']).toBeUndefined();
    const other = await a.inject({ method: 'GET', url: '/healthz', headers: { origin: 'https://share.test' } });
    expect(other.statusCode).toBe(200);
    expect(other.headers['access-control-allow-origin']).toBeUndefined();
  });
});
