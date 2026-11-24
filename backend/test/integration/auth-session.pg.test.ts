import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';

let currentDb: unknown;
vi.mock('../../src/db/client.js', () => ({ getDb: () => currentDb, closeDb: async () => {} }));

import { createTestSchema } from '../helpers/pg-schema.js';
import { buildSessionApp, seedOwner, signIn } from '../helpers/auth-app.js';

// AUTH-01 / AUTH-03 / AUTH-05 server proof against real Postgres (throwaway
// schema, D-14). Run via `npm run test:pg -- test/integration/auth-session.pg.test.ts`.

const url = process.env.TEST_DATABASE_URL;

describe.skipIf(!url)('session auth (Better Auth, real Postgres)', () => {
  let schema: Awaited<ReturnType<typeof createTestSchema>>;
  let s: Awaited<ReturnType<typeof buildSessionApp>>;
  let app: FastifyInstance;
  let pwA: string;

  const worlds = (cookie?: string, remoteAddress = '10.9.9.9') =>
    app.inject({
      method: 'GET',
      url: '/v1/worlds',
      remoteAddress,
      headers: cookie ? { cookie } : {},
    });

  beforeAll(async () => {
    schema = await createTestSchema(url!, { max: 4 });
    currentDb = schema.db;
    s = await buildSessionApp({ db: schema.db, env: { AUTH_RATE_LIMIT: '0' } });
    app = s.app;
    pwA = await seedOwner(s.auth, 'owner-a@example.com');
  }, 60_000);

  afterAll(async () => {
    await app?.close();
    await schema?.drop();
  });

  it('allowlisted owner signs in and lists worlds as exactly one users row', async () => {
    const r = await signIn(app, 'owner-a@example.com', pwA);
    expect(r.status).toBe(200);
    expect(r.cookie).toContain('better-auth.session_token=');

    const res = await worlds(r.cookie);
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toMatchObject({ worlds: [] });

    const ba = await schema.pool.query(`SELECT id FROM "user" WHERE email = 'owner-a@example.com'`);
    const rows = await schema.pool.query('SELECT apple_sub FROM users');
    expect(rows.rows).toEqual([{ apple_sub: `ba:${ba.rows[0].id}` }]);
  });

  it('no cookie → 401 on /v1/worlds', async () => {
    expect((await worlds()).statusCode).toBe(401);
  });
});
