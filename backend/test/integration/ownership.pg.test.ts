import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';

let currentDb: unknown;
vi.mock('../../src/db/client.js', () => ({ getDb: () => currentDb, closeDb: async () => {} }));

import { createTestSchema } from '../helpers/pg-schema.js';
import { buildSessionApp, seedOwner, signIn } from '../helpers/auth-app.js';
import { worlds } from '../../src/db/schema.js';

// AUTH-05 / LIB-03 / D-15 / D-16: two session-authenticated owners on a
// throwaway schema (D-14). A foreign world id is indistinguishable from a
// missing one (404), and rename is validated server-side.

const url = process.env.TEST_DATABASE_URL;

describe.skipIf(!url)('library ownership + rename (real Postgres)', () => {
  let schema: Awaited<ReturnType<typeof createTestSchema>>;
  let app: FastifyInstance;
  let cookieA: string;
  let cookieB: string;
  let userA: string;
  let userB: string;
  let worldA: string;
  let worldB: string;

  const call = (method: 'GET' | 'PATCH' | 'DELETE', path: string, cookie?: string, body?: unknown) =>
    app.inject({
      method,
      url: path,
      remoteAddress: '10.9.9.9',
      headers: {
        ...(cookie ? { cookie } : {}),
        ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      },
      ...(body !== undefined ? { payload: JSON.stringify(body) } : {}),
    });

  /** Sign in, touch /v1 so the users row exists, return cookie + users.id. */
  async function owner(email: string, password: string) {
    const r = await signIn(app, email, password);
    expect(r.status).toBe(200);
    expect((await call('GET', '/v1/worlds', r.cookie)).statusCode).toBe(200);
    const q = await schema.pool.query(
      `SELECT u.id FROM users u JOIN "user" b ON u.apple_sub = 'ba:' || b.id WHERE b.email = $1`,
      [email],
    );
    expect(q.rows).toHaveLength(1);
    return { cookie: r.cookie, userId: q.rows[0].id as string };
  }

  async function insertWorld(ownerId: string, title: string) {
    const [row] = await schema.db.insert(worlds).values({ ownerId, title, status: 'ready' }).returning();
    return row!.id;
  }

  const row = async (id: string) =>
    (await schema.pool.query('SELECT title, deleted_at, updated_at FROM worlds WHERE id = $1', [id])).rows[0];

  beforeAll(async () => {
    schema = await createTestSchema(url!, { max: 4 });
    currentDb = schema.db;
    const s = await buildSessionApp({ db: schema.db, env: { AUTH_RATE_LIMIT: '0' } });
    app = s.app;
    const pwA = await seedOwner(s.auth, 'owner-a@example.com');
    const pwB = await seedOwner(s.auth, 'owner-b@example.com');
    ({ cookie: cookieA, userId: userA } = await owner('owner-a@example.com', pwA));
    ({ cookie: cookieB, userId: userB } = await owner('owner-b@example.com', pwB));
    worldA = await insertWorld(userA, 'A room');
    worldB = await insertWorld(userB, 'B room');
  }, 60_000);

  afterAll(async () => {
    await app?.close();
    await schema?.drop();
  });

  it("B's world is absent from A's list; A sees its own with the D-15a fields", async () => {
    const res = await call('GET', '/v1/worlds', cookieA);
    expect(res.statusCode).toBe(200);
    const items = JSON.parse(res.body).worlds as Record<string, unknown>[];
    expect(items.map((w) => w.id)).toEqual([worldA]);
    expect(items[0]).toMatchObject({
      failure_stage: null,
      failure_code: null,
      failure_message: null,
      charged: false,
      eta_seconds: null,
      assets: {},
    });
    expect(items[0]).toHaveProperty('heartbeat_at');
  });

  it("A's GET, PATCH and DELETE on B's id are 404; B's world is unchanged", async () => {
    expect((await call('GET', `/v1/worlds/${worldB}`, cookieA)).statusCode).toBe(404);
    expect((await call('PATCH', `/v1/worlds/${worldB}`, cookieA, { title: 'x' })).statusCode).toBe(404);
    expect((await call('DELETE', `/v1/worlds/${worldB}`, cookieA)).statusCode).toBe(404);
    const b = await row(worldB);
    expect(b.title).toBe('B room');
    expect(b.deleted_at).toBeNull();
    // B still sees it.
    expect((await call('GET', `/v1/worlds/${worldB}`, cookieB)).statusCode).toBe(200);
  });

  it('junk id is 404 on GET and PATCH', async () => {
    expect((await call('GET', '/v1/worlds/not-a-uuid', cookieA)).statusCode).toBe(404);
    expect((await call('PATCH', '/v1/worlds/not-a-uuid', cookieA, { title: 'x' })).statusCode).toBe(404);
  });

  it('PATCH trims the title and bumps updated_at', async () => {
    const before = (await row(worldA)).updated_at as Date;
    const res = await call('PATCH', `/v1/worlds/${worldA}`, cookieA, { title: '  Kitchen  ' });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toMatchObject({ id: worldA, title: 'Kitchen' });
    const after = await row(worldA);
    expect(after.title).toBe('Kitchen');
    expect((after.updated_at as Date).getTime()).toBeGreaterThan(before.getTime());
  });

  it('whitespace-only and 81-char titles are 400; 80 chars is 200', async () => {
    expect((await call('PATCH', `/v1/worlds/${worldA}`, cookieA, { title: '   ' })).statusCode).toBe(400);
    expect((await call('PATCH', `/v1/worlds/${worldA}`, cookieA, { title: 'a'.repeat(81) })).statusCode).toBe(400);
    const ok = await call('PATCH', `/v1/worlds/${worldA}`, cookieA, { title: 'a'.repeat(80) });
    expect(ok.statusCode).toBe(200);
    expect(JSON.parse(ok.body).title).toHaveLength(80);
  });

  it('extra fields are rejected (strict body) and nothing changes', async () => {
    const res = await call('PATCH', `/v1/worlds/${worldA}`, cookieA, { title: 'ok', status: 'failed' });
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).error).toBe('invalid_body');
    const r = await schema.pool.query('SELECT title, status FROM worlds WHERE id = $1', [worldA]);
    expect(r.rows[0]).toEqual({ title: 'a'.repeat(80), status: 'ready' });
  });

  it("CR-01: DELETE with the app's exact headers (Cookie only, no content type) is 200", async () => {
    // Same headers apiFetch sends for a bodiless DELETE (asserted in the app's library-actions test).
    const victim = await insertWorld(userA, 'Doomed');
    const res = await app.inject({
      method: 'DELETE',
      url: `/v1/worlds/${victim}`,
      remoteAddress: '10.9.9.9',
      headers: { Cookie: cookieA },
    });
    expect(res.statusCode).toBe(200);
    expect((await row(victim)).deleted_at).not.toBeNull();
    // The old header set (JSON content type, no body) is what broke it: Fastify 400s the empty body.
    const old = await app.inject({
      method: 'DELETE',
      url: `/v1/worlds/${worldA}`,
      remoteAddress: '10.9.9.9',
      headers: { Cookie: cookieA, 'content-type': 'application/json' },
    });
    expect(old.statusCode).toBe(400);
    // Keep the AUTH-05 row count below to worldA + worldB.
    await schema.pool.query('DELETE FROM jobs WHERE world_id = $1', [victim]);
    await schema.pool.query('DELETE FROM worlds WHERE id = $1', [victim]);
  });

  it('PATCH without a cookie is 401', async () => {
    expect((await call('PATCH', `/v1/worlds/${worldA}`, undefined, { title: 'x' })).statusCode).toBe(401);
  });

  it('AUTH-05: every world owner_id maps to its Better Auth user via ba:<id>', async () => {
    const q = await schema.pool.query(
      `SELECT w.id, b.email FROM worlds w JOIN users u ON u.id = w.owner_id
         JOIN "user" b ON u.apple_sub = 'ba:' || b.id ORDER BY b.email`,
    );
    expect(q.rows).toEqual([
      { id: worldA, email: 'owner-a@example.com' },
      { id: worldB, email: 'owner-b@example.com' },
    ]);
  });
});
