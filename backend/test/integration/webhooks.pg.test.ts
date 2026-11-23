import { describe, it, expect, afterEach, vi } from 'vitest';
import Fastify from 'fastify';
import { signWebhook } from '../../src/provider/types.js';
import { webhookRoutes } from '../../src/routes/webhooks.js';
import { runOneJob } from '../../src/worker.js';
import { startPipeline, TEST_WEBHOOK_SECRET } from '../helpers/pipeline.js';

// ROADMAP SC3 / D-20..22 / PROC-06 / PROC-10: HMAC-verified, deduplicated,
// nudge-only webhooks; polling alone still reaches ready when they are dropped.
// Run via `node --env-file=.env scripts/test-pg.mjs test/integration/webhooks.pg.test.ts`.

const url = process.env.TEST_DATABASE_URL;

type Res = { statusCode: number; body: string };

async function start(opts: Parameters<typeof startPipeline>[0]) {
  const p = await startPipeline(opts);
  const app = Fastify({ logger: false });
  await webhookRoutes(app, { config: p.config, storage: p.storage, db: p.db });
  const responses: Res[] = [];
  const send = async (raw: Buffer, headers: Record<string, string>) => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/webhooks/spaitial',
      payload: raw,
      headers: { 'content-type': 'application/json', ...headers },
    });
    responses.push(res);
    return res;
  };
  p.onWebhook = send;
  return Object.assign(p, { responses, send, closeAll: async () => (await app.close(), await p.close()) });
}

describe.skipIf(!url)('webhooks (mock provider, real Postgres)', () => {
  let p: Awaited<ReturnType<typeof start>> | undefined;

  afterEach(async () => {
    await p?.closeAll();
    p = undefined;
  });

  const rows = async (requestId: string) =>
    Number((await p!.pool.query('SELECT count(*) AS n FROM webhook_deliveries WHERE request_id = $1', [requestId])).rows[0].n);

  it('(a) valid → stored; same delivery id → duplicate; invalid signature → 401, no row', async () => {
    p = await start({});
    const raw = Buffer.from('{"event":"world.completed","request_id":"req_unknown"}');
    const headers = {
      'X-Spaitial-Event': 'world.completed',
      'X-Spaitial-Request-ID': 'req_unknown',
      'X-Spaitial-Delivery-ID': 'wd_direct',
      'X-Spaitial-Signature': signWebhook(TEST_WEBHOOK_SECRET, raw),
    };

    const first = await p.send(raw, headers);
    expect(first.statusCode).toBe(200);
    expect(JSON.parse(first.body)).toEqual({ ok: true });
    expect(await rows('req_unknown')).toBe(1);

    const again = await p.send(raw, headers);
    expect(again.statusCode).toBe(200);
    expect(JSON.parse(again.body)).toEqual({ ok: true, duplicate: true });
    expect(await rows('req_unknown')).toBe(1);

    const forged = await p.send(raw, { ...headers, 'X-Spaitial-Delivery-ID': 'wd_forged', 'X-Spaitial-Signature': signWebhook('wrong', raw) });
    expect(forged.statusCode).toBe(401);
    const n = (await p.pool.query("SELECT count(*) AS n FROM webhook_deliveries WHERE delivery_id = 'wd_forged'")).rows[0].n;
    expect(Number(n)).toBe(0);
  }, 60_000);

  // Track polls every hour here, so leaving 'processing' proves the webhook nudge.
  // The mock's mesh export is 'pending' on its first poll, which re-snoozes track
  // for TRACK_POLL_SECONDS in 'importing' (no webhook for that); we stand in for
  // that next poll by pulling the job forward, then drain to ready.
  async function nudgeToReady(worldId: string) {
    // Run jobs until track has polled once and snoozed for the hour.
    const sql = "SELECT 1 FROM jobs WHERE world_id = $1 AND kind = 'track' AND phase = 'queued' AND run_after > now() + interval '30 minutes'";
    const deadline = Date.now() + 60_000;
    while (!(await p!.pool.query(sql, [worldId])).rowCount) {
      if (Date.now() > deadline) throw new Error('track never snoozed');
      if (!(await runOneJob(p!.deps))) await new Promise((r) => setTimeout(r, 50));
    }
    expect((await p!.getWorld(worldId)).status).toBe('processing');
    const nudged = await p!.drain({ worldId, until: (w) => w.status !== 'processing', timeoutMs: 30_000 });
    expect(nudged.status).toBe('importing');
    await p!.pool.query("UPDATE jobs SET run_after = now() WHERE world_id = $1 AND kind = 'track' AND phase = 'queued'", [worldId]);
    return p!.drain({ worldId, timeoutMs: 60_000 });
  }

  it('(b) nudge: with polling at an hour, the signed webhook pulls track forward', async () => {
    // processingSeconds 3 (not 1) so the webhook lands after track has snoozed.
    p = await start({ scenario: 'happy', processingSeconds: 3, trackPollSeconds: 3600 });
    const { worldId } = await p.seedScan();
    const w = await nudgeToReady(worldId);
    expect(w.status).toBe('ready');
    expect(await rows(w.providerRequestId!)).toBe(1);
    expect(p.provider.calls.submit).toHaveLength(1);
  }, 180_000);

  it('(c) duplicate_webhooks: second delivery is a no-op duplicate', async () => {
    p = await start({ scenario: 'duplicate_webhooks', processingSeconds: 3, trackPollSeconds: 3600 });
    const { worldId } = await p.seedScan();
    const w = await nudgeToReady(worldId);
    expect(w.status).toBe('ready');
    await vi.waitFor(() => expect(p!.responses).toHaveLength(2), { timeout: 10_000 });
    expect(p.responses.map((r) => JSON.parse(r.body))).toEqual([{ ok: true }, { ok: true, duplicate: true }]);
    expect(await rows(w.providerRequestId!)).toBe(1);
    expect(p.provider.calls.submit).toHaveLength(1);
  }, 180_000);

  it('(d) webhook_dropped: short polling alone reaches ready', async () => {
    p = await start({ scenario: 'webhook_dropped', processingSeconds: 1, trackPollSeconds: 1 });
    const { worldId } = await p.seedScan();
    const w = await p.drain({ worldId, timeoutMs: 60_000 });
    expect(w.status).toBe('ready');
    expect(p.responses).toHaveLength(0);
    expect(await rows(w.providerRequestId!)).toBe(0);
  }, 90_000);
});
