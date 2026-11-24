import { randomUUID } from 'node:crypto';
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';

let currentDb: unknown;
vi.mock('../../src/db/client.js', () => ({ getDb: () => currentDb, closeDb: async () => {} }));

import { startPipeline, readFixture, type Pipeline } from '../helpers/pipeline.js';
import { scansRoutes } from '../../src/routes/scans.js';
import { users } from '../../src/db/schema.js';

// D-23 / SC4 backend half: create → presign → PUT every fixture file through
// its presigned URL (local driver over real HTTP) → missing=[] → complete →
// worker drain → ready, via the mock provider and dev capture thresholds.

const url = process.env.TEST_DATABASE_URL;

describe.skipIf(!url)('scan create-to-ready e2e (mock provider, real Postgres)', () => {
  let p: Pipeline;
  let api: FastifyInstance;
  const userId = randomUUID();

  beforeAll(async () => {
    p = await startPipeline();
    currentDb = p.db;
    await p.db.insert(users).values({ id: userId, appleSub: `sub-${userId}` });
    api = Fastify({ logger: false });
    api.addHook('onRequest', async (req) => {
      req.userId = userId;
    });
    scansRoutes(api, { config: p.config, storage: p.storage, provider: p.provider });
    await api.ready();
  }, 60_000);

  afterAll(async () => {
    await api?.close();
    await p?.close();
  });

  const json = (r: { body: string }) => JSON.parse(r.body);

  it('reaches ready with the approval persisted and one mock reserve row', async () => {
    const files = await readFixture();
    const frameCount = [...files.keys()].filter((k) => k.startsWith('frames/')).length;
    expect(frameCount).toBe(30);

    const created = await api.inject({
      method: 'POST',
      url: '/v1/scans',
      headers: { 'idempotency-key': randomUUID() },
      payload: { title: 'E2E room', frame_count: frameCount, image_w: 640, image_h: 480, approved_max_credits: 930 },
    });
    expect(created.statusCode).toBe(201);
    const id = json(created).world.id as string;

    // session.json last: the app uploads the manifest after the frames.
    const order = [...files.keys()].filter((k) => k !== 'session.json').concat('session.json');
    const presigned = await api.inject({
      method: 'POST',
      url: `/v1/scans/${id}/uploads`,
      payload: { files: order.map((path) => ({ path, bytes: files.get(path)!.length })) },
    });
    expect(presigned.statusCode).toBe(200);
    const uploads = json(presigned).uploads as { path: string; url: string; headers: Record<string, string> }[];
    expect(uploads).toHaveLength(32);
    for (const u of uploads) {
      const res = await fetch(u.url, { method: 'PUT', headers: u.headers, body: files.get(u.path)! });
      expect(res.status, u.path).toBe(200);
    }

    const missing = json(await api.inject({ method: 'GET', url: `/v1/scans/${id}/uploads:missing` }));
    expect(missing).toMatchObject({ missingFrames: [], manifestPresent: true, uploadedFrames: 30, totalFrames: 30 });

    const done = await api.inject({ method: 'POST', url: `/v1/scans/${id}:complete` });
    expect(done.statusCode).toBe(200);
    expect(json(done).world.status).toBe('packing');

    const w = await p.drain({ worldId: id });
    expect(w.status).toBe('ready');
    expect(w.approvedMaxCredits).toBe(930);
    const ledger = (
      await p.pool.query('SELECT amount, kind, provider_mode FROM credit_events WHERE world_id = $1', [id])
    ).rows;
    expect(ledger).toEqual([{ amount: 930, kind: 'reserve', provider_mode: 'mock' }]);
  }, 90_000);
});
