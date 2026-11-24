import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';

let currentDb: unknown;
vi.mock('../../src/db/client.js', () => ({ getDb: () => currentDb, closeDb: async () => {} }));

import { createTestSchema } from '../helpers/pg-schema.js';
import { buildSessionApp, cookieFrom, seedOwner, signIn } from '../helpers/auth-app.js';

// AUTH-01 / AUTH-03 / AUTH-05 server proof against real Postgres (throwaway
// schema, D-14). Run via `npm run test:pg -- test/integration/auth-session.pg.test.ts`.

const url = process.env.TEST_DATABASE_URL;

describe.skipIf(!url)('session auth (Better Auth, real Postgres)', () => {
  let schema: Awaited<ReturnType<typeof createTestSchema>>;
  let s: Awaited<ReturnType<typeof buildSessionApp>>;
  let app: FastifyInstance;
  let pwA: string;
  let pwB: string;
  let pwStranger: string;
  const extra: FastifyInstance[] = [];
  let ip = 0;
  /** Distinct client address per call so the shared limiter never interferes. */
  const nextIp = () => `10.1.${Math.floor(++ip / 250)}.${ip % 250}`;

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
    pwB = await seedOwner(s.auth, 'owner-b@example.com');
    // Has a real credential but is NOT on the allowlist.
    pwStranger = await seedOwner(s.auth, 'stranger@example.com');
  }, 60_000);

  /** Another app on the same schema with different env. */
  const other = async (env: Record<string, string>) => {
    const o = await buildSessionApp({ db: schema.db, env });
    extra.push(o.app);
    return o.app;
  };

  afterAll(async () => {
    for (const a of extra) await a.close();
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

  it('non-allowlisted credential and wrong password get the identical 401', async () => {
    const stranger = await signIn(app, 'stranger@example.com', pwStranger, { remoteAddress: nextIp() });
    const wrong = await signIn(app, 'owner-a@example.com', `${pwA}x`, { remoteAddress: nextIp() });
    expect(stranger.status).toBe(401);
    expect(wrong.status).toBe(401);
    expect(stranger.body.code).toBe('INVALID_EMAIL_OR_PASSWORD');
    expect(wrong.body.code).toBe('INVALID_EMAIL_OR_PASSWORD');
    expect(Object.keys(stranger.body).sort()).toEqual(Object.keys(wrong.body).sort());
    expect(stranger.body).toEqual(wrong.body);
    expect(stranger.cookie).toBe('');
  });

  it('sign-up is refused with EMAIL_PASSWORD_SIGN_UP_DISABLED and creates no user row', async () => {
    const before = Number((await schema.pool.query('SELECT count(*) AS n FROM "user"')).rows[0].n);
    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/sign-up/email',
      remoteAddress: nextIp(),
      headers: { 'content-type': 'application/json', origin: 'virtumetry://' },
      payload: JSON.stringify({ email: 'owner-a2@example.com', password: 'Abcdefgh1234!', name: 'x' }),
    });
    expect(res.statusCode).toBeGreaterThanOrEqual(400);
    expect(res.statusCode).toBeLessThan(500);
    expect(JSON.parse(res.body).code).toBe('EMAIL_PASSWORD_SIGN_UP_DISABLED');
    const after = Number((await schema.pool.query('SELECT count(*) AS n FROM "user"')).rows[0].n);
    expect(after).toBe(before);
  });

  it('empty OWNER_ALLOWLIST lets nobody in', async () => {
    const closed = await other({ AUTH_RATE_LIMIT: '0', OWNER_ALLOWLIST: '' });
    const r = await signIn(closed, 'owner-a@example.com', pwA, { remoteAddress: nextIp() });
    expect(r.status).toBe(401);
    expect(r.body.code).toBe('INVALID_EMAIL_OR_PASSWORD');
  });

  it('a live session whose email left the allowlist gets 401 on /v1', async () => {
    const r = await signIn(app, 'owner-b@example.com', pwB, { remoteAddress: nextIp() });
    expect(r.status).toBe(200);
    expect((await worlds(r.cookie)).statusCode).toBe(200);
    const narrowed = await other({ AUTH_RATE_LIMIT: '0', OWNER_ALLOWLIST: 'owner-a@example.com' });
    const res = await narrowed.inject({
      method: 'GET',
      url: '/v1/worlds',
      remoteAddress: nextIp(),
      headers: { cookie: r.cookie },
    });
    expect(res.statusCode).toBe(401);
  });

  it('untrusted origin is 403; Expo Go expo-origin is accepted outside production', async () => {
    const evil = await signIn(app, 'owner-a@example.com', pwA, {
      remoteAddress: nextIp(),
      origin: 'https://evil.example',
    });
    expect(evil.status).toBe(403);
    expect(evil.cookie).toBe('');

    const expoGo = await signIn(app, 'owner-a@example.com', pwA, {
      remoteAddress: nextIp(),
      origin: null,
      headers: { 'expo-origin': 'exp://192.168.1.5:8081' },
    });
    expect(expoGo.status).toBe(200);
  });

  it('sign-in is rate limited to 5/60 s per client IP; X-Forwarded-For cannot dodge it', async () => {
    const limited = await other({}); // AUTH_RATE_LIMIT unset → limiter on
    const statuses: number[] = [];
    for (let i = 0; i < 6; i++) {
      const r = await signIn(limited, 'owner-a@example.com', `${pwA}-wrong`, {
        remoteAddress: '10.200.0.1',
        headers: { 'x-forwarded-for': `203.0.113.${i + 1}`, 'x-vm-client-ip': `198.51.100.${i}` },
      });
      statuses.push(r.status);
    }
    expect(statuses.slice(0, 5)).toEqual([401, 401, 401, 401, 401]);
    expect(statuses[5]).toBe(429);
  });

  it('sign-out revokes: the old cookie then gets 401 on /v1/worlds', async () => {
    const r = await signIn(app, 'owner-a@example.com', pwA, { remoteAddress: nextIp() });
    expect((await worlds(r.cookie)).statusCode).toBe(200);
    const out = await app.inject({
      method: 'POST',
      url: '/api/auth/sign-out',
      remoteAddress: nextIp(),
      headers: { cookie: r.cookie, origin: 'virtumetry://' },
    });
    expect(out.statusCode).toBe(200);
    expect(cookieFrom(out.headers['set-cookie'])).toContain('better-auth.session_token=');
    expect((await worlds(r.cookie)).statusCode).toBe(401);
  });

  it('dev bearer works in session mode only while DEV_AUTH_TOKEN is set', async () => {
    const bearer = { authorization: 'Bearer dev-tok', 'x-dev-user': 'dev-user-1' };
    const withDev = await other({ AUTH_RATE_LIMIT: '0', DEV_AUTH_TOKEN: 'dev-tok' });
    const ok = await withDev.inject({ method: 'GET', url: '/v1/worlds', remoteAddress: nextIp(), headers: bearer });
    expect(ok.statusCode).toBe(200);
    const noDev = await app.inject({ method: 'GET', url: '/v1/worlds', remoteAddress: nextIp(), headers: bearer });
    expect(noDev.statusCode).toBe(401);
  });
});
