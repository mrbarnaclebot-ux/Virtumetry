import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';

let currentDb: unknown;
vi.mock('../../src/db/client.js', () => ({ getDb: () => currentDb, closeDb: async () => {} }));

import { createTestSchema } from '../helpers/pg-schema.js';
import { buildSessionApp, seedOwner, signIn } from '../helpers/auth-app.js';
import { worlds } from '../../src/db/schema.js';

// SHARE-01..05 / D-15..D-17 / D-20: share links driven through the real HTTP
// routes on a throwaway schema (D-23).

const url = process.env.TEST_DATABASE_URL;
const SHARE_ORIGIN = 'https://share.test';
const BASE = 'https://api.test';
const SLUG_RE = /^[A-Za-z0-9_-]{22}$/;

describe.skipIf(!url)('share links (real Postgres)', () => {
  let schema: Awaited<ReturnType<typeof createTestSchema>>;
  let app: FastifyInstance;
  let bare: FastifyInstance; // built without WEB_SHARE_ORIGIN
  let cookieA: string;
  let cookieB: string;
  let userA: string;
  let worldA: string;
  let worldB: string;
  let pendingA: string;

  const call = (
    method: 'GET' | 'POST' | 'DELETE',
    path: string,
    cookie?: string,
    body?: unknown,
    target: FastifyInstance = app,
  ) =>
    target.inject({
      method,
      url: path,
      remoteAddress: '10.9.9.9',
      headers: {
        ...(cookie ? { cookie } : {}),
        ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      },
      ...(body !== undefined ? { payload: JSON.stringify(body) } : {}),
    });

  async function owner(email: string, password: string) {
    const r = await signIn(app, email, password);
    expect(r.status).toBe(200);
    expect((await call('GET', '/v1/worlds', r.cookie)).statusCode).toBe(200);
    const q = await schema.pool.query(
      `SELECT u.id FROM users u JOIN "user" b ON u.apple_sub = 'ba:' || b.id WHERE b.email = $1`,
      [email],
    );
    return { cookie: r.cookie, userId: q.rows[0].id as string };
  }

  async function insertWorld(ownerId: string, title: string, status = 'ready') {
    const [row] = await schema.db
      .insert(worlds)
      .values({
        ownerId,
        title,
        status,
        splatKey: `worlds/${title}/scene.spz`,
        colliderKey: `worlds/${title}/collider.ply`,
        thumbnailKey: `worlds/${title}/thumb.jpg`,
        floorplanMeta: { scale: 1 },
      })
      .returning();
    return row!.id;
  }

  const shareRow = async (id: string) =>
    (await schema.pool.query('SELECT * FROM share_slugs WHERE id = $1', [id])).rows[0];

  const create = async (worldId: string, body: unknown = {}, cookie = cookieA) => {
    const res = await call('POST', `/v1/worlds/${worldId}/shares`, cookie, body);
    return { res, json: JSON.parse(res.body) as Record<string, unknown> };
  };

  beforeAll(async () => {
    schema = await createTestSchema(url!, { max: 4 });
    currentDb = schema.db;
    const s = await buildSessionApp({
      db: schema.db,
      env: { AUTH_RATE_LIMIT: '0', WEB_SHARE_ORIGIN: SHARE_ORIGIN, PUBLIC_BASE_URL: BASE, SHARE_FAIL_MAX: '2' },
    });
    app = s.app;
    bare = (await buildSessionApp({ db: schema.db, env: { AUTH_RATE_LIMIT: '0' } })).app;
    const pwA = await seedOwner(s.auth, 'owner-a@example.com');
    const pwB = await seedOwner(s.auth, 'owner-b@example.com');
    ({ cookie: cookieA, userId: userA } = await owner('owner-a@example.com', pwA));
    const b = await owner('owner-b@example.com', pwB);
    cookieB = b.cookie;
    worldA = await insertWorld(userA, 'Kitchen');
    worldB = await insertWorld(b.userId, 'Other');
    pendingA = await insertWorld(userA, 'Pending', 'processing');
  }, 60_000);

  afterAll(async () => {
    await app?.close();
    await bare?.close();
    await schema?.drop();
  });

  describe('owner routes (D-16)', () => {
    it('creates an unprotected link for a ready world', async () => {
      const { res, json } = await create(worldA);
      expect(res.statusCode).toBe(201);
      expect(json.slug).toMatch(SLUG_RE);
      expect(json).toMatchObject({
        url: `${BASE}/s/${json.slug}`,
        has_password: false,
        open_count: 0,
        revoked_at: null,
      });
      expect(json).toHaveProperty('id');
      expect(json).toHaveProperty('created_at');
      expect(json).not.toHaveProperty('password_hash');
    });

    it('stores a scrypt hash for a password link', async () => {
      const { res, json } = await create(worldA, { password: 'abcd' });
      expect(res.statusCode).toBe(201);
      expect(json.has_password).toBe(true);
      expect((await shareRow(json.id as string)).password_hash).toMatch(/^scrypt\$/);
    });

    it.each([[{ password: 'abc' }], [{ password: 'a'.repeat(65) }], [{ extra: 1 }], [{ password: 5 }]])(
      'rejects body %j with 400 invalid_body',
      async (body) => {
        const { res, json } = await create(worldA, body);
        expect(res.statusCode).toBe(400);
        expect(json.error).toBe('invalid_body');
      },
    );

    it('409 world_not_ready for a non-ready world', async () => {
      const { res, json } = await create(pendingA);
      expect(res.statusCode).toBe(409);
      expect(json.error).toBe('world_not_ready');
    });

    it("404 world_not_found for another owner's world or a junk id", async () => {
      expect((await create(worldB)).res.statusCode).toBe(404);
      const junk = await create('not-a-uuid');
      expect(junk.res.statusCode).toBe(404);
      expect(junk.json.error).toBe('world_not_found');
      expect((await call('GET', `/v1/worlds/${worldB}/shares`, cookieA)).statusCode).toBe(404);
    });

    it('lists newest first without password hashes; revoke is idempotent', async () => {
      const { json: made } = await create(worldA);
      const list = await call('GET', `/v1/worlds/${worldA}/shares`, cookieA);
      expect(list.statusCode).toBe(200);
      const shares = JSON.parse(list.body).shares as Record<string, unknown>[];
      expect(shares.length).toBeGreaterThanOrEqual(3);
      expect(shares[0]!.id).toBe(made.id);
      const times = shares.map((s) => new Date(s.created_at as string).getTime());
      expect([...times].sort((a, b) => b - a)).toEqual(times);
      for (const s of shares) {
        expect(s).not.toHaveProperty('password_hash');
        expect(s).toHaveProperty('has_password');
        expect(s).toHaveProperty('open_count');
        expect(s).toHaveProperty('revoked_at');
      }

      const del = `/v1/worlds/${worldA}/shares/${made.id}`;
      expect((await call('DELETE', del, cookieA)).statusCode).toBe(204);
      const first = (await shareRow(made.id as string)).revoked_at as Date;
      expect(first).not.toBeNull();
      expect((await call('DELETE', del, cookieA)).statusCode).toBe(204);
      expect(((await shareRow(made.id as string)).revoked_at as Date).getTime()).toBe(first.getTime());
    });

    it('DELETE: junk shareId → 404; another owner cannot revoke', async () => {
      expect((await call('DELETE', `/v1/worlds/${worldA}/shares/nope`, cookieA)).statusCode).toBe(404);
      const { json: made } = await create(worldA);
      expect((await call('DELETE', `/v1/worlds/${worldA}/shares/${made.id}`, cookieB)).statusCode).toBe(404);
      expect((await shareRow(made.id as string)).revoked_at).toBeNull();
    });

    it('without a cookie → 401', async () => {
      expect((await call('POST', `/v1/worlds/${worldA}/shares`, undefined, {})).statusCode).toBe(401);
    });
  });

  describe('share vars unset (T-05-41)', () => {
    it('create → 503 share_unavailable; list and revoke still work', async () => {
      const res = await call('POST', `/v1/worlds/${worldA}/shares`, cookieA, {}, bare);
      expect(res.statusCode).toBe(503);
      expect(JSON.parse(res.body)).toEqual({ error: 'share_unavailable' });
      const list = await call('GET', `/v1/worlds/${worldA}/shares`, cookieA, undefined, bare);
      expect(list.statusCode).toBe(200);
      const { json: made } = await create(worldA);
      expect(
        (await call('DELETE', `/v1/worlds/${worldA}/shares/${made.id}`, cookieA, undefined, bare)).statusCode,
      ).toBe(204);
    });
  });
});
