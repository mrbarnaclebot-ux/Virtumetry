import { randomUUID } from 'node:crypto';
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';

let currentDb: unknown;
vi.mock('../../src/db/client.js', () => ({ getDb: () => currentDb, closeDb: async () => {} }));

import { createTestSchema } from '../helpers/pg-schema.js';
import { buildSessionApp, seedOwner, signIn } from '../helpers/auth-app.js';
import { DEV_CAPTURE_CONFIG_JSON, readFixture } from '../helpers/pipeline.js';
import { createLocalStorage } from '../../src/storage/local.js';
import { captureKey, type StorageDriver } from '../../src/storage/index.js';

// D-17/D-19/D-20 server contract for the session-format upload path:
// POST /v1/scans → /uploads (presign) → /uploads:missing (R2 reconcile) →
// /<uuid>:complete (checks before any credit, then pack). Two owners on a
// throwaway schema; dev capture thresholds so the 30-frame fixture passes.

const url = process.env.TEST_DATABASE_URL;
const FRAMES = 30;
const pad6 = (n: number) => String(n).padStart(6, '0');

type Line = { T_arkit: number[]; tracking: string } & Record<string, unknown>;

/** Fixture files with frames.jsonl lines mutated in place (and optionally truncated). */
async function fixture(o: { keep?: number; mutate?: (lines: Line[]) => void } = {}) {
  const files = await readFixture();
  let lines = files
    .get('frames.jsonl')!
    .toString('utf8')
    .split('\n')
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l) as Line);
  if (o.keep !== undefined) {
    lines = lines.slice(0, o.keep);
    for (const k of [...files.keys()]) {
      const m = /^frames\/(\d{6})\.jpg$/.exec(k);
      if (m && Number(m[1]) > o.keep) files.delete(k);
    }
  }
  o.mutate?.(lines);
  files.set('frames.jsonl', Buffer.from(lines.map((l) => JSON.stringify(l)).join('\n') + '\n'));
  return files;
}

describe.skipIf(!url)('scans upload path (real Postgres)', () => {
  let schema: Awaited<ReturnType<typeof createTestSchema>>;
  let app: FastifyInstance;
  let storage: StorageDriver;
  let cookieA: string;
  let cookieB: string;
  let userA: string;

  const call = (method: 'GET' | 'POST', path: string, cookie?: string, body?: unknown, headers: Record<string, string> = {}) =>
    app.inject({
      method,
      url: path,
      remoteAddress: '10.9.9.8',
      headers: {
        ...(cookie ? { cookie } : {}),
        ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
        ...headers,
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

  async function create(o: { key?: string; frames?: number; approved?: number; cookie?: string } = {}) {
    const frames = o.frames ?? FRAMES;
    const res = await call(
      'POST',
      '/v1/scans',
      o.cookie ?? cookieA,
      { title: 'Room', frame_count: frames, image_w: 640, image_h: 480, approved_max_credits: o.approved ?? 900 + frames },
      { 'idempotency-key': o.key ?? randomUUID() },
    );
    return res;
  }

  async function createId(o: Parameters<typeof create>[0] = {}) {
    const res = await create(o);
    expect(res.statusCode).toBe(201);
    return JSON.parse(res.body).world.id as string;
  }

  const captureIdOf = async (worldId: string) =>
    (await schema.pool.query('SELECT id FROM captures WHERE world_id = $1', [worldId])).rows[0].id as string;

  async function put(worldId: string, files: Map<string, Buffer>, only?: (rel: string) => boolean) {
    const cid = await captureIdOf(worldId);
    for (const [rel, buf] of files) if (!only || only(rel)) await storage.putObject(captureKey(cid, rel), buf);
  }

  const complete = (id: string, cookie = cookieA) => call('POST', `/v1/scans/${id}:complete`, cookie);
  const count = async (sql: string, id: string) => Number((await schema.pool.query(sql, [id])).rows[0].n);

  beforeAll(async () => {
    schema = await createTestSchema(url!, { max: 4 });
    currentDb = schema.db;
    const s = await buildSessionApp({
      db: schema.db,
      env: { AUTH_RATE_LIMIT: '0', CAPTURE_CONFIG_JSON: DEV_CAPTURE_CONFIG_JSON, RATE_LIMIT_CREATE_MAX: '100', DAILY_SCAN_QUOTA: '100' },
    });
    app = s.app;
    storage = createLocalStorage(s.config);
    const pwA = await seedOwner(s.auth, 'owner-a@example.com');
    const pwB = await seedOwner(s.auth, 'owner-b@example.com');
    ({ cookie: cookieA, userId: userA } = await owner('owner-a@example.com', pwA));
    ({ cookie: cookieB } = await owner('owner-b@example.com', pwB));
  }, 60_000);

  afterAll(async () => {
    await app?.close();
    await schema?.drop();
  });

  it('create is idempotent on Idempotency-Key and charges the scan quota once', async () => {
    const quota = async () =>
      Number((await schema.pool.query('SELECT daily_scan_count AS n FROM users WHERE id = $1', [userA])).rows[0].n);
    const before = await quota();
    const key = randomUUID();
    const a = await create({ key });
    expect(a.statusCode).toBe(201);
    const b = await create({ key });
    expect(b.statusCode).toBe(200);
    const wa = JSON.parse(a.body).world;
    expect(JSON.parse(b.body).world.id).toBe(wa.id);
    expect(wa.status).toBe('uploading');
    expect(await quota()).toBe(before + 1);

    const cap = (await schema.pool.query('SELECT frame_count, image_w, image_h, r2_frames_prefix FROM captures WHERE world_id = $1', [wa.id])).rows;
    expect(cap).toHaveLength(1);
    expect(cap[0]).toMatchObject({ frame_count: FRAMES, image_w: 640, image_h: 480 });
    expect(cap[0].r2_frames_prefix).toMatch(/^captures\//);
  });

  it('missing / malformed Idempotency-Key is a 400', async () => {
    const body = { frame_count: FRAMES, image_w: 640, image_h: 480, approved_max_credits: 930 };
    const none = await call('POST', '/v1/scans', cookieA, body);
    expect(none.statusCode).toBe(400);
    expect(JSON.parse(none.body).error).toBe('missing_idempotency_key');
    const bad = await call('POST', '/v1/scans', cookieA, body, { 'idempotency-key': 'nope' });
    expect(JSON.parse(bad.body).error).toBe('invalid_idempotency_key');
  });

  it('approval below the quote is refused; the approval is persisted', async () => {
    const low = await create({ approved: 900 + FRAMES - 1 });
    expect(low.statusCode).toBe(400);
    expect(JSON.parse(low.body).error).toBe('approval_below_quote');

    const id = await createId({ approved: 2000 });
    const row = (await schema.pool.query('SELECT approved_max_credits FROM worlds WHERE id = $1', [id])).rows[0];
    expect(row.approved_max_credits).toBe(2000);
  });

  it('presign allowlists paths and sets content types', async () => {
    const id = await createId();
    const presign = (files: unknown) => call('POST', `/v1/scans/${id}/uploads`, cookieA, { files });
    for (const path of ['../x', 'frames/1.jpg', `frames/${pad6(FRAMES + 1)}.jpg`, 'frames/000000.jpg', 'other.json']) {
      const r = await presign([{ path, bytes: 10 }]);
      expect(r.statusCode, path).toBe(400);
      expect(JSON.parse(r.body).error).toBe('invalid_path');
    }
    const many = Array.from({ length: 201 }, () => ({ path: 'frames.jsonl', bytes: 10 }));
    expect((await presign(many)).statusCode).toBe(400);

    const ok = await presign([
      { path: 'frames/000001.jpg', bytes: 1234 },
      { path: 'frames.jsonl', bytes: 99 },
      { path: 'session.json', bytes: 50 },
    ]);
    expect(ok.statusCode).toBe(200);
    const ups = JSON.parse(ok.body).uploads as { path: string; url: string; method: string; headers: Record<string, string> }[];
    expect(ups.map((u) => u.path)).toEqual(['frames/000001.jpg', 'frames.jsonl', 'session.json']);
    expect(ups[0]!.headers['content-type']).toBe('image/jpeg');
    expect(ups[0]!.headers['content-length']).toBe('1234');
    expect(ups[1]!.headers['content-type']).toBe('application/json');
    expect(ups.every((u) => u.method === 'PUT')).toBe(true);
  });

  it('uploads:missing reports exactly what storage lacks', async () => {
    const id = await createId();
    const files = await fixture();
    const missing = async () => JSON.parse((await call('GET', `/v1/scans/${id}/uploads:missing`, cookieA)).body);

    let m = await missing();
    expect(m.missingFrames).toHaveLength(FRAMES);
    expect(m).toMatchObject({ manifestPresent: false, uploadedFrames: 0, totalFrames: FRAMES });
    expect(m.world.id).toBe(id);

    await put(id, files, (rel) => rel.startsWith('frames/') && Number(rel.slice(7, 13)) % 2 === 1);
    await put(id, files, (rel) => rel === 'frames.jsonl');
    m = await missing();
    expect(m.missingFrames).toEqual(Array.from({ length: 15 }, (_, k) => `frames/${pad6(2 * (k + 1))}.jpg`));
    expect(m.uploadedFrames).toBe(15);
    expect(m.manifestPresent).toBe(false);

    await put(id, files);
    m = await missing();
    expect(m).toMatchObject({ missingFrames: [], manifestPresent: true, uploadedFrames: FRAMES });
  });

  it(':complete routes the bare uuid; anything else after the colon is 404', async () => {
    const id = await createId();
    const r = await complete(id);
    expect(r.statusCode).toBe(409);
    const body = JSON.parse(r.body);
    expect(body.error).toBe('upload_incomplete');
    expect(body.missingFrames).toHaveLength(FRAMES);
    expect(body.manifestPresent).toBe(false);
    expect((await call('POST', `/v1/scans/${id}:completeX`, cookieA)).statusCode).toBe(404);
    expect((await call('POST', `/v1/scans/not-a-uuid/uploads`, cookieA, { files: [{ path: 'session.json', bytes: 1 }] })).statusCode).toBe(404);
  });

  it("owner B gets 404 on every :id route for A's scan", async () => {
    const id = await createId();
    expect((await call('POST', `/v1/scans/${id}/uploads`, cookieB, { files: [{ path: 'session.json', bytes: 1 }] })).statusCode).toBe(404);
    expect((await call('GET', `/v1/scans/${id}/uploads:missing`, cookieB)).statusCode).toBe(404);
    expect((await complete(id, cookieB)).statusCode).toBe(404);
  });

  it('complete on a full good upload flips to packing once; replay returns the same state', async () => {
    const id = await createId();
    await put(id, await fixture());
    const r1 = await complete(id);
    expect(r1.statusCode).toBe(200);
    expect(JSON.parse(r1.body).world.status).toBe('packing');
    const r2 = await complete(id);
    expect(r2.statusCode).toBe(200);
    expect(JSON.parse(r2.body).world.status).toBe('packing');
    expect(await count(`SELECT count(*) AS n FROM jobs WHERE world_id = $1 AND kind = 'pack'`, id)).toBe(1);
    // Presign after completion is refused: the upload window is closed.
    const late = await call('POST', `/v1/scans/${id}/uploads`, cookieA, { files: [{ path: 'session.json', bytes: 1 }] });
    expect(late.statusCode).toBe(409);
    expect(JSON.parse(late.body).error).toBe('not_uploading');
  });

  const broken: [string, number, Parameters<typeof fixture>[0], string][] = [
    ['pose jump', FRAMES, { mutate: (ls) => ls.slice(14).forEach((l) => (l.T_arkit[12]! += 0.6)) }, 'CAMERA_JUMP'],
    ['too few frames', 8, { keep: 8 }, 'FRAME_COUNT_OUT_OF_RANGE'],
    ['tracking gap', FRAMES, { mutate: (ls) => ls.slice(9, 17).forEach((l) => (l.tracking = 'limited')) }, 'TRACKING_GAP'],
  ];

  it.each(broken)('%s: fails at validate for free', async (_name, frames, o, code) => {
    const id = await createId({ frames });
    await put(id, await fixture(o));
    const r = await complete(id);
    expect(r.statusCode).toBe(200);
    const body = JSON.parse(r.body);
    expect(body.world).toMatchObject({ status: 'failed', failure_stage: 'validate', charged: false });
    expect(body.issues).toContain(code);
    expect(await count('SELECT count(*) AS n FROM credit_events WHERE world_id = $1', id)).toBe(0);
    expect(await count(`SELECT count(*) AS n FROM jobs WHERE world_id = $1 AND kind IN ('pack', 'submit')`, id)).toBe(0);
  });
});
