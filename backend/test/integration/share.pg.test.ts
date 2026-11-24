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
      const { res, json } = await create(worldA, { password: 'abcdef' });
      expect(res.statusCode).toBe(201);
      expect(json.has_password).toBe(true);
      expect((await shareRow(json.id as string)).password_hash).toMatch(/^scrypt\$/);
    });

    it.each([[{ password: 'abcde' }], [{ password: 'a'.repeat(65) }], [{ extra: 1 }], [{ password: 5 }]])(
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

  describe('public get/open (D-17)', () => {
    // A fresh IP per request keeps the per-IP limiters out of these assertions.
    let ip = 0;
    const pub = (method: 'GET' | 'POST', path: string, body?: unknown) =>
      app.inject({
        method,
        url: path,
        remoteAddress: `10.1.${Math.floor(++ip / 250)}.${ip % 250}`,
        ...(body !== undefined
          ? { headers: { 'content-type': 'application/json' }, payload: JSON.stringify(body) }
          : {}),
      });
    const open = (slug: string, body?: unknown) => pub('POST', `/v1/public/shares/${slug}/open`, body);
    const slugOf = async (worldId: string, body: unknown = {}) => {
      const { json } = await create(worldId, body);
      return { id: json.id as string, slug: json.slug as string };
    };

    it('GET returns title + needs_password for a live link', async () => {
      const plain = await slugOf(worldA);
      const locked = await slugOf(worldA, { password: 'abcdef' });
      const a = await pub('GET', `/v1/public/shares/${plain.slug}`);
      expect(a.statusCode).toBe(200);
      expect(JSON.parse(a.body)).toEqual({ title: 'Kitchen', needs_password: false });
      expect(JSON.parse((await pub('GET', `/v1/public/shares/${locked.slug}`)).body)).toEqual({
        title: 'Kitchen',
        needs_password: true,
      });
    });

    it('revoked, unknown, malformed, not-ready and deleted all give one byte-identical 404', async () => {
      const revoked = await slugOf(worldA);
      await call('DELETE', `/v1/worlds/${worldA}/shares/${revoked.id}`, cookieA);
      const nrWorld = await insertWorld(userA, 'Reprocessing');
      const notReady = await slugOf(nrWorld);
      await schema.pool.query(`UPDATE worlds SET status = 'processing' WHERE id = $1`, [nrWorld]);
      const delWorld = await insertWorld(userA, 'Gone');
      const deleted = await slugOf(delWorld);
      await schema.pool.query('UPDATE worlds SET deleted_at = now() WHERE id = $1', [delWorld]);

      const slugs = [revoked.slug, 'B'.repeat(22), 'bad!slug', notReady.slug, deleted.slug];
      for (const s of slugs) {
        for (const res of [await pub('GET', `/v1/public/shares/${s}`), await open(s)]) {
          expect(res.statusCode).toBe(404);
          expect(res.body).toBe('{"error":"share_not_found"}');
        }
      }
    });

    it('password link: missing → 401, wrong → 401 (no count), right → assets + count', async () => {
      const { id, slug } = await slugOf(worldA, { password: 'hunter22' });
      const none = await open(slug);
      expect(none.statusCode).toBe(401);
      expect(JSON.parse(none.body).error).toBe('password_required');
      const wrong = await open(slug, { password: 'nope' });
      expect(wrong.statusCode).toBe(401);
      expect(JSON.parse(wrong.body).error).toBe('wrong_password');
      expect((await shareRow(id)).open_count).toBe(0);

      const ok = await open(slug, { password: 'hunter22' });
      expect(ok.statusCode).toBe(200);
      const body = JSON.parse(ok.body);
      expect(body.title).toBe('Kitchen');
      expect(body.floorplan_meta).toEqual({ scale: 1 });
      expect(body.assets.splat_url).toContain('scene.spz');
      expect(body.assets.collider_url).toContain('collider.ply');
      expect(body.assets).not.toHaveProperty('thumbnail_url');
      const r = await shareRow(id);
      expect(r.open_count).toBe(1);
      expect(r.last_opened_at).not.toBeNull();
    });

    it('unprotected link counts every open; revoke 404s the very next open', async () => {
      const { id, slug } = await slugOf(worldA);
      expect((await open(slug)).statusCode).toBe(200);
      expect((await open(slug)).statusCode).toBe(200);
      expect((await shareRow(id)).open_count).toBe(2);
      expect((await call('DELETE', `/v1/worlds/${worldA}/shares/${id}`, cookieA)).statusCode).toBe(204);
      expect((await open(slug)).statusCode).toBe(404);
      expect((await pub('GET', `/v1/public/shares/${slug}`)).statusCode).toBe(404);
    });

    it('SHARE_FAIL_MAX=2: the third attempt is 429, even with the right password', async () => {
      const { id, slug } = await slugOf(worldA, { password: 'hunter22' });
      expect((await open(slug, { password: 'x1' })).statusCode).toBe(401);
      expect((await open(slug, { password: 'x2' })).statusCode).toBe(401);
      for (const pw of ['x3', 'hunter22']) {
        const res = await open(slug, { password: pw });
        expect(res.statusCode).toBe(429);
        const body = JSON.parse(res.body);
        expect(body.error).toBe('rate_limited');
        expect(body.retry_after).toBeGreaterThan(0);
      }
      expect((await shareRow(id)).open_count).toBe(0);
    });

    it('parallel wrong guesses cannot race past SHARE_FAIL_MAX=2 (WR-04)', async () => {
      const { slug } = await slugOf(worldA, { password: 'hunter22' });
      const codes = (await Promise.all(['y1', 'y2', 'y3', 'y4', 'y5'].map((pw) => open(slug, { password: pw })))).map(
        (r) => r.statusCode,
      );
      expect(codes.filter((c) => c === 401)).toHaveLength(2);
      expect(codes.filter((c) => c === 429)).toHaveLength(3);
    });

    it('rejects an unknown body key with 400', async () => {
      const { slug } = await slugOf(worldA);
      expect((await open(slug, { password: 'x', extra: 1 })).statusCode).toBe(400);
    });
  });

  describe('landing /s/:slug (D-20)', () => {
    const land = (slug: string, target: FastifyInstance = app) =>
      target.inject({ method: 'GET', url: `/s/${slug}`, remoteAddress: '10.2.2.2' });
    const noindex = (res: { headers: Record<string, unknown>; body: string }) => {
      expect(res.headers['x-robots-tag']).toBe('noindex, nofollow');
      expect(res.headers['cache-control']).toBe('no-store');
      expect(res.body).toContain('<meta name="robots" content="noindex,nofollow">');
    };

    it('live link: OG preview + redirect, never counts an open', async () => {
      const { json } = await create(worldA);
      const slug = json.slug as string;
      for (let i = 0; i < 3; i++) {
        const res = await land(slug);
        expect(res.statusCode).toBe(200);
        expect(res.headers['content-type']).toBe('text/html; charset=utf-8');
        noindex(res);
        expect(res.body).toContain('<meta property="og:title" content="Kitchen">');
        expect(res.body).toContain(
          '<meta property="og:description" content="A 3D room you can walk through, shared with Virtumetry.">',
        );
        expect(res.body).toContain(`<meta property="og:url" content="${BASE}/s/${slug}">`);
        expect(res.body).toMatch(/<meta property="og:image" content="[^"]*thumb\.jpg">/);
        expect(res.body).toContain('<meta name="twitter:card" content="summary_large_image">');
        expect(res.body).toContain(`<meta http-equiv="refresh" content="0;url=${SHARE_ORIGIN}/r/${slug}">`);
        expect(res.body).toContain(`href="${SHARE_ORIGIN}/r/${slug}"`);
        expect(res.body).toContain('Open the room');
      }
      expect((await shareRow(json.id as string)).open_count).toBe(0);
    });

    it('password link: no og:image, summary card, private description', async () => {
      const { json } = await create(worldA, { password: 'abcdef' });
      const res = await land(json.slug as string);
      expect(res.statusCode).toBe(200);
      expect(res.body).not.toContain('og:image');
      expect(res.body).toContain('<meta name="twitter:card" content="summary">');
      expect(res.body).toContain('A password-protected 3D room, shared with Virtumetry.');
    });

    it('escapes the title everywhere', async () => {
      const evil = `<script>alert(1)</script>"&'`;
      const w = await insertWorld(userA, 'Evil');
      await schema.pool.query('UPDATE worlds SET title = $2 WHERE id = $1', [w, evil]);
      const { json } = await create(w);
      const res = await land(json.slug as string);
      expect(res.body).not.toContain('<script>alert');
      expect(res.body).toContain('&lt;script&gt;alert(1)&lt;/script&gt;&quot;&amp;&#39;');
    });

    it('revoked / unknown → noindex 404 page without og:image', async () => {
      const { json } = await create(worldA);
      await call('DELETE', `/v1/worlds/${worldA}/shares/${json.id}`, cookieA);
      for (const slug of [json.slug as string, 'C'.repeat(22), 'bad!slug']) {
        const res = await land(slug);
        expect(res.statusCode).toBe(404);
        noindex(res);
        expect(res.body).toContain('This link is no longer available');
        expect(res.body).not.toContain('og:image');
      }
    });

    it('without WEB_SHARE_ORIGIN → 503 share_unavailable, still noindex', async () => {
      const res = await land('D'.repeat(22), bare);
      expect(res.statusCode).toBe(503);
      expect(JSON.parse(res.body)).toEqual({ error: 'share_unavailable' });
      expect(res.headers['x-robots-tag']).toBe('noindex, nofollow');
    });
  });
});
