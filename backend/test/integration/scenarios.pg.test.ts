import { readFileSync } from 'node:fs';
import { describe, it, expect, afterEach } from 'vitest';
import type { MockScenario } from '../../src/provider/mock.js';
import { startPipeline, type Pipeline } from '../helpers/pipeline.js';
import { failWorldForDeadJob, runOneJob } from '../../src/worker.js';
import { ProviderError } from '../../src/provider/index.js';
import { MAX_ATTEMPTS } from '../../src/queue.js';

// PROC-10 scenario matrix (ROADMAP SC4) + concurrent over-budget refusal (SC5,
// PROC-08). Every scripted failure must end in its documented state with no
// extra submit. One pipeline (fresh schema + mock) per scenario.
// Run: `node --env-file=.env scripts/test-pg.mjs test/integration/scenarios.pg.test.ts`.

const url = process.env.TEST_DATABASE_URL;

describe.skipIf(!url)('provider failure scenarios (mock, real Postgres)', () => {
  let p: Pipeline | undefined;
  afterEach(async () => {
    await p?.close();
    p = undefined;
  });

  const start = async (scenario: MockScenario, extra: { daily?: number } = {}) =>
    (p = await startPipeline({ scenario, retryAfterS: 0, trackPollSeconds: 0, ...extra }));

  const ledger = async (key: string) =>
    (
      await p!.pool.query(
        'SELECT amount, kind, created_at FROM credit_events WHERE submission_key = $1 ORDER BY kind DESC',
        [key],
      )
    ).rows as { amount: number; kind: string; created_at: Date }[];

  /** Run one scenario; assert every submit used the world's single key. */
  const run = async (scenario: MockScenario) => {
    const pl = await start(scenario);
    const { worldId, frameCount } = await pl.seedScan();
    const w = await pl.drain({ worldId });
    const submits = pl.provider.calls.submit;
    expect(w.submissionKey).toBeTruthy();
    for (const s of submits) expect(s.key).toBe(w.submissionKey);
    return { w, submits, quote: 900 + frameCount, rows: await ledger(w.submissionKey!) };
  };

  it("'failed': provider FAILED → failed/processing, not charged, reservation released", async () => {
    const { w, submits, quote, rows } = await run('failed');
    expect(w.status).toBe('failed');
    expect(w.failureStage).toBe('processing');
    expect(w.failureCode).toBe('WORLD_GENERATION_FAILED');
    expect(w.charged).toBe(false);
    expect(submits).toHaveLength(1);
    expect(rows.map((r) => [r.kind, r.amount])).toEqual([
      ['reserve', quote],
      ['release', -quote],
    ]);
    expect(rows[1]!.created_at.getTime()).toBe(rows[0]!.created_at.getTime());
  }, 120_000);

  it("'402': insufficient credits → failed/submit, reservation released", async () => {
    const { w, submits, quote, rows } = await run('402');
    expect(w.status).toBe('failed');
    expect(w.failureStage).toBe('submit');
    expect(w.failureCode).toBe('INSUFFICIENT_CREDITS');
    expect(w.charged).toBe(false);
    expect(submits).toHaveLength(1);
    expect(rows.map((r) => [r.kind, r.amount])).toEqual([
      ['reserve', quote],
      ['release', -quote],
    ]);
  }, 120_000);

  it("'409': key reused → failed/submit, job dead, reservation kept, key unchanged", async () => {
    const { w, submits, quote, rows } = await run('409');
    expect(w.status).toBe('failed');
    expect(w.failureStage).toBe('submit');
    expect(w.failureCode).toBe('IDEMPOTENCY_KEY_REUSED');
    expect(w.charged).toBe(false);
    expect(submits).toHaveLength(1);
    expect(submits[0]!.key).toBe(w.submissionKey);
    expect(rows.map((r) => [r.kind, r.amount])).toEqual([['reserve', quote]]);
    const jobs = (
      await p!.pool.query("SELECT phase FROM jobs WHERE world_id = $1 AND kind = 'submit'", [w.id])
    ).rows as { phase: string }[];
    expect(jobs).toEqual([{ phase: 'dead' }]);
  }, 120_000);

  for (const scenario of ['429', '503'] as const) {
    it(`'${scenario}': retried once with the same key and byte-identical body → ready`, async () => {
      const { w, submits, quote, rows } = await run(scenario);
      expect(w.status).toBe('ready');
      expect(w.charged).toBe(true);
      expect(submits).toHaveLength(2);
      expect(submits[1]!.body).toBe(submits[0]!.body);
      expect(rows.map((r) => [r.kind, r.amount])).toEqual([['reserve', quote]]);
    }, 120_000);
  }

  it('concurrent scans over the daily cap: one reservation, the other BUDGET_EXCEEDED with 0 submits', async () => {
    const frameCount = readFileSync(new URL('../fixtures/tiny-session/frames.jsonl', import.meta.url), 'utf8')
      .split('\n')
      .filter((l) => l.trim()).length;
    const quote = 900 + frameCount; // mock quote
    p = await start('happy', { daily: Math.floor(quote * 1.5) });

    const a = await p.seedScan();
    const b = await p.seedScan();
    const past = (s: string) => s === 'processing' || s === 'importing' || s === 'ready';
    const until = (w: { status: string }) => past(w.status);
    const [wa, wb] = await Promise.all([
      p.drain({ worldId: a.worldId, until, deps: { ...p.deps, workerId: 'it-worker-a' } }),
      p.drain({ worldId: b.worldId, until, deps: { ...p.deps, workerId: 'it-worker-b' } }),
    ]);

    const ok = [wa, wb].filter((w) => past(w.status));
    const refused = [wa, wb].filter((w) => w.status === 'failed');
    expect(ok).toHaveLength(1);
    expect(refused).toHaveLength(1);
    expect(refused[0]!.failureStage).toBe('submit');
    expect(refused[0]!.failureCode).toBe('BUDGET_EXCEEDED');

    const reserves = (await p.pool.query("SELECT world_id FROM credit_events WHERE kind = 'reserve'")).rows as {
      world_id: string;
    }[];
    expect(reserves).toEqual([{ world_id: ok[0]!.id }]);
    expect(p.provider.calls.submit).toHaveLength(1);
    expect(p.provider.calls.submit[0]!.key).toBe(ok[0]!.submissionKey);
  }, 180_000);

  it('CR-01: more transient track errors than MAX_ATTEMPTS never fail a paid world', async () => {
    const pl = await start('happy');
    const { worldId } = await pl.seedScan();
    const status = pl.provider.status.bind(pl.provider);
    const open = pl.provider.open.bind(pl.provider);
    let statusErrs = 0;
    let openErrs = 0;
    pl.provider.status = async (rid) => {
      if (statusErrs++ < 4) throw new ProviderError('mock: 503 on status', { status: 503 });
      return status(rid);
    };
    pl.provider.open = async (a) => {
      if (openErrs++ < 3) throw new Error('mock: storage blip');
      return open(a);
    };
    const w = await pl.drain({ worldId });
    expect(w.status).toBe('ready');
    expect(w.charged).toBe(true);
    expect(statusErrs + openErrs).toBeGreaterThan(MAX_ATTEMPTS); // 7 errors, none consumed an attempt
    const { rows } = await pl.pool.query("SELECT phase, attempts, payload FROM jobs WHERE world_id = $1 AND kind = 'track'", [worldId]);
    expect(rows).toEqual([{ phase: 'done', attempts: expect.any(Number), payload: null }]);
    expect(rows[0].attempts).toBeLessThanOrEqual(1);
  }, 120_000);

  /** Like drain, but skips every backoff gate (the uncertain path backs off 60 s+). */
  const drainNow = async (pl: Pipeline, worldId: string) => {
    for (let i = 0; i < 500; i++) {
      const w = await pl.getWorld(worldId);
      if (w.status === 'ready' || w.status === 'failed' || w.status === 'cancelled') return w;
      await pl.pool.query("UPDATE jobs SET run_after = now() WHERE world_id = $1 AND phase = 'queued'", [worldId]);
      if (!(await runOneJob(pl.deps))) await new Promise((r) => setTimeout(r, 50));
    }
    throw new Error(`drainNow: world ${worldId} not terminal`);
  };

  it('CR-02: 500 then 503 x3 keeps the reservation (the first attempt may be billed)', async () => {
    const pl = await start('happy');
    const { worldId, frameCount } = await pl.seedScan();
    let n = 0;
    pl.provider.submit = async (body, key) => {
      pl.provider.calls.submit.push({ key, body });
      throw n++ === 0
        ? new ProviderError('mock: 500', { status: 500 })
        : new ProviderError('mock: 503', { status: 503, retryAfterS: 0 });
    };
    const w = await drainNow(pl, worldId);
    expect(pl.provider.calls.submit).toHaveLength(4);
    expect(w.status).toBe('failed');
    expect(w.failureCode).toBe('SUBMIT_UNCERTAIN');
    expect((await ledger(w.submissionKey!)).map((r) => [r.kind, r.amount])).toEqual([['reserve', 900 + frameCount]]);
  }, 120_000);

  it('CR-02: a crash mid-send (sending marker left) then 402 keeps the reservation', async () => {
    const pl = await start('402');
    const { worldId, frameCount } = await pl.seedScan();
    await pl.drain({ worldId, until: (w) => w.status === 'submitting' });
    await pl.pool.query(`UPDATE jobs SET payload = '{"sending":true}' WHERE world_id = $1 AND kind = 'submit'`, [worldId]);
    const w = await pl.drain({ worldId });
    expect(w.status).toBe('failed');
    expect(w.failureCode).toBe('INSUFFICIENT_CREDITS');
    expect((await ledger(w.submissionKey!)).map((r) => [r.kind, r.amount])).toEqual([['reserve', 900 + frameCount]]);
  }, 120_000);

  it('WR-01: a resumed submit is not re-quoted, so a changed quote cannot orphan the request', async () => {
    const pl = await start('503');
    const { worldId, frameCount } = await pl.seedScan();
    const quote = pl.provider.quote.bind(pl.provider);
    let quotes = 0;
    pl.provider.quote = async (n) => (quotes++ === 0 ? quote(n) : { credits: 999_999, available: Infinity });
    const w = await pl.drain({ worldId });
    expect(w.status).toBe('ready');
    expect(quotes).toBe(1);
    expect(w.quotedCredits).toBe(900 + frameCount);
    expect(w.creditsSpent).toBe(900 + frameCount);
    expect(pl.provider.calls.submit).toHaveLength(2);
  }, 120_000);

  it('WR-02: a world failed mid-submit is still tracked once the request is confirmed', async () => {
    const pl = await start('happy');
    const { worldId } = await pl.seedScan();
    const submit = pl.provider.submit.bind(pl.provider);
    pl.provider.submit = async (body, key) => {
      await failWorldForDeadJob(pl.db, { kind: 'submit', worldId }); // the reaper wins the race
      return submit(body, key);
    };
    const revived = await pl.drain({ worldId, until: (w) => w.providerRequestId != null });
    expect(revived.status).toBe('processing');
    const w = await pl.drain({ worldId });
    expect(w.status).toBe('ready');
    expect(w.failureCode).toBeNull();
    expect(w.charged).toBe(true);
  }, 120_000);

  it('a pipeline job that goes DEAD fails its world (no stuck in-progress status)', async () => {
    const pl = await start('happy');
    const { worldId } = await pl.seedScan(); // world is 'packing'
    await failWorldForDeadJob(pl.db, { kind: 'submit', worldId }); // wrong stage: no-op
    expect((await pl.drain({ worldId, until: () => true })).status).toBe('packing');
    await failWorldForDeadJob(pl.db, { kind: 'pack', worldId });
    const { rows } = await pl.pool.query('SELECT status, failure_stage, failure_code FROM worlds WHERE id = $1', [worldId]);
    expect(rows[0]).toEqual({ status: 'failed', failure_stage: 'pack', failure_code: 'JOB_EXHAUSTED' });
  }, 120_000);
});
