import { describe, it, expect, afterEach } from 'vitest';
import { createEcho3Provider } from '../../src/provider/echo3.js';
import { handleSubmit } from '../../src/pipeline.js';
import { claimNextJob } from '../../src/queue.js';
import { runOneJob } from '../../src/worker.js';
import { startFakeEcho3, type Step } from '../helpers/fake-echo3.js';
import { startPipeline, TEST_WEBHOOK_SECRET, type Pipeline } from '../helpers/pipeline.js';

// PROC-05 / SC1 (D-06): the exactly-once money proof on the code path a paid run
// uses — the real handleSubmit + echo3.ts against the hermetic fake Echo-3
// server (127.0.0.1). `fake.state.billed` counts distinct worlds the fake created.
// Run: `npm run test:pg -- test/integration/echo3-contract.pg.test.ts`.

const url = process.env.TEST_DATABASE_URL;
const LOCAL = new Set(['127.0.0.1', 'localhost']);

describe.skipIf(!url)('Echo-3 live client contract (fake server, real Postgres)', () => {
  let p: Pipeline | undefined;
  let fake: Awaited<ReturnType<typeof startFakeEcho3>> | undefined;
  let hosts: string[] = [];
  afterEach(async () => {
    await p?.close();
    await fake?.close();
    p = fake = undefined;
    hosts = [];
  });

  /** Every provider request goes through here so a test can prove it stayed local. */
  const recFetch: typeof fetch = (input, init) => {
    const href = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    hosts.push(new URL(href).hostname);
    return fetch(input, init);
  };

  const start = async (fakeOpts: Parameters<typeof startFakeEcho3>[0] = {}) => {
    const f = (fake = await startFakeEcho3({ retryAfter: '0', ...fakeOpts }));
    p = await startPipeline({
      trackPollSeconds: 0,
      provider: () =>
        createEcho3Provider({
          apiKey: 'spt_live_test',
          baseUrl: f.baseUrl,
          webhookSecret: TEST_WEBHOOK_SECRET,
          fetch: recFetch,
          timeouts: { submit: 300, call: 5000, download: 10000 },
        }),
    });
    return { p, fake: f };
  };

  const ledger = async (key: string) =>
    (
      await p!.pool.query('SELECT kind FROM credit_events WHERE submission_key = $1 ORDER BY kind DESC', [key])
    ).rows.map((r: { kind: string }) => r.kind);

  /** Like drain, but skips every backoff gate (uncertain submits back off 60 s+). */
  const drainNow = async (worldId: string) => {
    for (let i = 0; i < 500; i++) {
      const w = await p!.getWorld(worldId);
      if (w.status === 'ready' || w.status === 'failed' || w.status === 'cancelled') return w;
      await p!.pool.query("UPDATE jobs SET run_after = now() WHERE world_id = $1 AND phase = 'queued'", [worldId]);
      if (!(await runOneJob(p!.deps))) await new Promise((r) => setTimeout(r, 50));
    }
    throw new Error(`drainNow: world ${worldId} not terminal`);
  };

  /** One key, one byte-identical body, the fake only. */
  const assertOneKeyOneBody = (key: string) => {
    const submits = fake!.state.submits;
    expect(submits.length).toBeGreaterThan(0);
    for (const s of submits) {
      expect(s.key).toBe(key);
      expect(s.body).toBe(submits[0]!.body);
    }
    expect(hosts.length).toBeGreaterThan(0);
    for (const h of hosts) expect(LOCAL.has(h)).toBe(true);
  };

  /** The happy-ending exactly-once assertions shared by every recovering scenario. */
  const assertBilledOnce = async (w: Awaited<ReturnType<Pipeline['getWorld']>>, submits: number) => {
    expect(w.status).toBe('ready');
    expect(w.charged).toBe(true);
    expect(fake!.state.billed).toBe(1);
    expect(fake!.state.submits).toHaveLength(submits);
    assertOneKeyOneBody(w.submissionKey!);
    expect(w.providerRequestId).toMatch(/^req_/);
    expect(await ledger(w.submissionKey!)).toEqual(['reserve']); // never released
    const { rows } = await p!.pool.query("SELECT count(*)::int AS n FROM jobs WHERE world_id = $1 AND kind = 'track'", [w.id]);
    expect(rows[0].n).toBe(1);
  };

  it('happy path: one submit, billed 1', async () => {
    const { p } = await start();
    const { worldId } = await p.seedScan();
    await assertBilledOnce(await drainNow(worldId), 1);
  }, 120_000);

  it('V2 kill mid-submit: accepted but request id not saved → resume with same key + body, billed 1', async () => {
    const { p, fake } = await start();
    const { worldId } = await p.seedScan();
    const real = p.provider.submit.bind(p.provider);
    let first: string | undefined;
    // A thrown LeaseLostError (src/worker.ts) would NOT simulate a crash here: handleSubmit's catch
    // around provider.submit turns any non-ProviderError into an ordinary
    // "uncertain" retry (job unlocked + requeued). A real kill leaves the job
    // locked/running with the `sending` marker, so the "crashed" run instead
    // never settles once the provider has accepted — the process is gone.
    p.provider.submit = async (body, key) => {
      const r = await real(body, key);
      if (first) return r;
      first = r.requestId;
      return new Promise<never>(() => undefined);
    };
    await p.drain({ worldId, until: (w) => w.status === 'submitting' });
    const job = await claimNextJob(p.db, ['submit'], 'it-worker-killed');
    void handleSubmit({ ...p.deps, workerId: 'it-worker-killed' }, job!);
    for (let i = 0; !first && i < 600; i++) await new Promise((r) => setTimeout(r, 50));
    expect(first).toMatch(/^req_/);
    expect((await p.getWorld(worldId)).providerRequestId).toBeNull();
    const { rows } = await p.pool.query("SELECT phase, locked_by, payload FROM jobs WHERE world_id = $1 AND kind = 'submit'", [worldId]);
    expect(rows).toEqual([{ phase: 'running', locked_by: 'it-worker-killed', payload: { uncertain: false, sending: true } }]);
    // The dead worker's lease expires; another worker claims the job and resumes.
    await p.pool.query("UPDATE jobs SET locked_at = now() - interval '1 hour' WHERE world_id = $1 AND kind = 'submit'", [
      worldId,
    ]);
    const w = await drainNow(worldId);
    await assertBilledOnce(w, 2);
    expect(w.providerRequestId).toBe(first);
    expect(fake.state.billed).toBe(1);
  }, 120_000);

  it('V3 concurrent: two workers run the same submit job in parallel → billed 1, one reserve, one request id', async () => {
    const { p, fake } = await start();
    const { worldId } = await p.seedScan();
    await p.drain({ worldId, until: (w) => w.status === 'submitting' });
    const job = await claimNextJob(p.db, ['submit'], 'it-worker-a');
    expect(job?.worldId).toBe(worldId);
    const results = await Promise.allSettled([
      handleSubmit({ ...p.deps, workerId: 'it-worker-a' }, job!),
      handleSubmit({ ...p.deps, workerId: 'it-worker-b' }, { ...job! }),
    ]);
    expect(results.map((r) => r.status)).toEqual(['fulfilled', 'fulfilled']);
    expect(fake.state.billed).toBe(1);
    const w = await drainNow(worldId);
    await assertBilledOnce(w, 2);
    const reserves = (await p.pool.query("SELECT count(*)::int AS n FROM credit_events WHERE world_id = $1 AND kind = 'reserve'", [worldId]))
      .rows[0].n;
    expect(reserves).toBe(1);
  }, 120_000);

  const recovering: { name: string; script: Step[]; submits: number }[] = [
    { name: 'V4 drop-after-accept (socket dies after the world was created)', script: ['drop-after-accept'], submits: 2 },
    { name: 'V4 timeout (accepted, response never arrives within timeouts.submit)', script: ['timeout'], submits: 2 },
    { name: 'V4 429 then 503 then accept', script: ['429', '503'], submits: 3 },
  ];
  for (const c of recovering) {
    it(`${c.name} → billed 1, same key + body, reservation kept`, async () => {
      const { p } = await start({ submitScript: c.script });
      const { worldId } = await p.seedScan();
      await assertBilledOnce(await drainNow(worldId), c.submits);
    }, 120_000);
  }

  it('V4 409 IDEMPOTENCY_KEY_REUSED parks the world, keeps the key and the reservation, bills nothing new', async () => {
    const { p, fake } = await start();
    const { worldId } = await p.seedScan();
    const real = p.provider.submit.bind(p.provider);
    let seenKey: string | undefined;
    p.provider.submit = async (body, key) => {
      if (!seenKey) {
        seenKey = key;
        await real(`${body} `, key); // the key was already used with different bytes
      }
      return real(body, key);
    };
    const w = await drainNow(worldId);
    expect(w.status).toBe('failed');
    expect(w.failureStage).toBe('submit');
    expect(w.failureCode).toBe('IDEMPOTENCY_KEY_REUSED');
    expect(w.submissionKey).toBe(seenKey);
    expect(w.providerRequestId).toBeNull();
    expect(fake.state.billed).toBe(1); // only the pre-existing world; the 409 billed nothing
    expect(fake.state.submits).toHaveLength(2);
    for (const s of fake.state.submits) expect(s.key).toBe(seenKey);
    expect(await ledger(seenKey!)).toEqual(['reserve']);
    const jobs = (await p.pool.query("SELECT phase FROM jobs WHERE world_id = $1 AND kind = 'submit'", [worldId])).rows;
    expect(jobs).toEqual([{ phase: 'dead' }]);
    for (const h of hosts) expect(LOCAL.has(h)).toBe(true);
  }, 120_000);

  it('V4 401 → PROVIDER_AUTH after one call, reservation released, billed 0', async () => {
    const { p, fake } = await start({ submitScript: ['401'] });
    const { worldId } = await p.seedScan();
    const w = await drainNow(worldId);
    expect(w.status).toBe('failed');
    expect(w.failureStage).toBe('submit');
    expect(w.failureCode).toBe('PROVIDER_AUTH');
    expect(fake.state.billed).toBe(0);
    expect(fake.state.submits).toHaveLength(1);
    assertOneKeyOneBody(w.submissionKey!);
    expect(await ledger(w.submissionKey!)).toEqual(['reserve', 'release']);
  }, 120_000);
});
