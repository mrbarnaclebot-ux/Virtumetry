import { randomUUID } from 'node:crypto';
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';

let currentDb: unknown;
vi.mock('../../src/db/client.js', () => ({ getDb: () => currentDb, closeDb: async () => {} }));
// WR-11: lets a test make the route's provider.quote throw.
let quoteFail: Error | undefined;
vi.mock('../../src/provider/index.js', async (orig) => {
  const m = await orig<typeof import('../../src/provider/index.js')>();
  return {
    ...m,
    createProvider: (c: Parameters<typeof m.createProvider>[0]) => {
      const p = m.createProvider(c);
      const quote = p.quote.bind(p);
      p.quote = async (n) => {
        if (quoteFail) throw quoteFail;
        return quote(n);
      };
      return p;
    },
  };
});

import { eq } from 'drizzle-orm';
import { createTestSchema } from '../helpers/pg-schema.js';
import { buildSessionApp, seedOwner, signIn } from '../helpers/auth-app.js';
import { startPipeline, TEST_WEBHOOK_SECRET, type Pipeline } from '../helpers/pipeline.js';
import { captures, creditEvents, worlds, type World } from '../../src/db/schema.js';
import { applyRetry } from '../../src/retry.js';
import { createMockProvider } from '../../src/provider/mock.js';
import { ProviderError, ProviderTimeoutError } from '../../src/provider/types.js';
import { failWorld, handleSubmit } from '../../src/pipeline.js';
import { claimNextJob, enqueue, mapJobRow } from '../../src/queue.js';
import { LeaseLostError, type WorkerDeps } from '../../src/worker.js';

// D-09 retry contract + its money guards (A-02 ledger, A-04 quota, idempotent
// replay, concurrent one-wins) and the payload fields the app renders
// (retryable / submit_attempt / frame_count / budgetAlert). Mock provider only.
// Run: `npm run test:pg -- test/integration/retry.pg.test.ts`.

const url = process.env.TEST_DATABASE_URL;
const FRAMES = 30;
const QUOTE = 900 + FRAMES; // mock: 900 + 1/frame
const DAILY = 10_000;

describe.skipIf(!url)('POST /v1/worlds/:id/retry (real Postgres)', () => {
  let schema: Awaited<ReturnType<typeof createTestSchema>>;
  let app: FastifyInstance;
  let cookieA: string;
  let cookieB: string;
  let userA: string;

  const call = (method: 'GET' | 'POST', path: string, cookie?: string, body?: unknown, headers: Record<string, string> = {}) =>
    app.inject({
      method,
      url: path,
      remoteAddress: '10.9.9.7',
      headers: {
        ...(cookie ? { cookie } : {}),
        ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
        ...headers,
      },
      ...(body !== undefined ? { payload: JSON.stringify(body) } : {}),
    });

  const retry = (id: string, o: { key?: string | null; approved?: number; cookie?: string; body?: unknown } = {}) =>
    call(
      'POST',
      `/v1/worlds/${id}/retry`,
      o.cookie ?? cookieA,
      o.body ?? { approved_max_credits: o.approved ?? QUOTE },
      o.key === null ? {} : { 'idempotency-key': o.key ?? randomUUID() },
    );

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

  /** A world owned by A, seeded directly at its terminal state, plus its capture. */
  async function seed(o: Partial<World> & { bundle?: boolean } = {}) {
    const { bundle = true, ...cols } = o;
    const [w] = await schema.db
      .insert(worlds)
      .values({
        ownerId: userA,
        title: 'Room',
        status: 'failed',
        failureStage: 'processing',
        failureCode: 'WORLD_GENERATION_FAILED',
        failureMessage: 'boom',
        submissionKey: randomUUID(),
        providerRequestId: `req-${randomUUID()}`,
        quotedCredits: QUOTE,
        approvedMaxCredits: QUOTE,
        submitBody: { zip_url: 'redacted' },
        ...cols,
      })
      .returning();
    const captureId = randomUUID();
    await schema.db.insert(captures).values({
      id: captureId,
      worldId: w!.id,
      frameCount: FRAMES,
      r2FramesPrefix: `captures/${captureId}`,
      bundleKey: bundle ? `bundles/${captureId}/bundle.zip` : null,
    });
    return w!;
  }

  const ledger = async (key: string, kinds: ('reserve' | 'release')[]) => {
    for (const kind of kinds) {
      await schema.db.insert(creditEvents).values({
        amount: kind === 'reserve' ? QUOTE : -QUOTE,
        submissionKey: key,
        kind,
        providerMode: 'mock',
      });
    }
  };
  const n = async (sql: string, id: string) => Number((await schema.pool.query(sql, [id])).rows[0].n);
  const attempts = (id: string) => n('SELECT count(*) AS n FROM world_attempts WHERE world_id = $1', id);
  const jobs = (id: string) => n(`SELECT count(*) AS n FROM jobs WHERE world_id = $1`, id);
  const quota = () => n('SELECT daily_scan_count AS n FROM users WHERE id = $1', userA);
  const row = async (id: string) => (await schema.db.select().from(worlds).where(eq(worlds.id, id)))[0]!;
  const listItem = async (id: string) => {
    const body = (await call('GET', '/v1/worlds?limit=100', cookieA)).json();
    return { item: body.worlds.find((w: { id: string }) => w.id === id), body };
  };

  beforeAll(async () => {
    schema = await createTestSchema(url!, { max: 6 });
    currentDb = schema.db;
    const s = await buildSessionApp({
      db: schema.db,
      env: {
        AUTH_RATE_LIMIT: '0',
        RATE_LIMIT_CREATE_MAX: '100',
        DAILY_SCAN_QUOTA: '100',
        DAILY_CREDIT_BUDGET: String(DAILY),
        MONTHLY_CREDIT_BUDGET: '1000000',
        BUDGET_ALERT_SHARE: '0.8',
      },
    });
    app = s.app;
    const pwA = await seedOwner(s.auth, 'owner-a@example.com');
    const pwB = await seedOwner(s.auth, 'owner-b@example.com');
    ({ cookie: cookieA, userId: userA } = await owner('owner-a@example.com', pwA));
    ({ cookie: cookieB } = await owner('owner-b@example.com', pwB));
  }, 60_000);

  afterAll(async () => {
    await app?.close();
    await schema?.drop();
  });

  it('budgetAlert is null on the list while under share × budget', async () => {
    const { body } = await listItem(randomUUID());
    expect(body.budgetAlert).toBeNull();
  });

  it('404s for a non-owner and for an unknown id', async () => {
    const w = await seed();
    const b = await retry(w.id, { cookie: cookieB });
    expect(b.statusCode).toBe(404);
    expect(b.json().error).toBe('world_not_found');
    expect((await retry(randomUUID())).statusCode).toBe(404);
    expect(await attempts(w.id)).toBe(0);
  });

  it('400s on missing / non-UUID Idempotency-Key and a body with extra fields', async () => {
    const w = await seed();
    const missing = await retry(w.id, { key: null });
    expect([missing.statusCode, missing.json().error]).toEqual([400, 'missing_idempotency_key']);
    const bad = await retry(w.id, { key: 'not-a-uuid' });
    expect([bad.statusCode, bad.json().error]).toEqual([400, 'invalid_idempotency_key']);
    const extra = await retry(w.id, { body: { approved_max_credits: QUOTE, foo: 1 } });
    expect([extra.statusCode, extra.json().error]).toEqual([400, 'invalid_body']);
    expect(await attempts(w.id)).toBe(0);
  });

  it('409 not_retryable for ready, SUBMIT_UNCERTAIN and validation failures', async () => {
    const cases = [
      await seed({ status: 'ready', failureStage: null, failureCode: null }),
      await seed({ failureStage: 'submit', failureCode: 'SUBMIT_UNCERTAIN' }),
      await seed({ failureStage: 'validate', failureCode: 'TOO_FEW_FRAMES' }),
    ];
    for (const w of cases) {
      const res = await retry(w.id);
      expect([res.statusCode, res.json().error]).toEqual([409, 'not_retryable']);
      expect(await attempts(w.id)).toBe(0);
      expect(await jobs(w.id)).toBe(0);
    }
  });

  it('A-02 ledger guard: an unreleased reserve on the current key → 409, no job, no attempt; released → allowed', async () => {
    const held = await seed({ failureStage: 'submit', failureCode: 'INSUFFICIENT_CREDITS' });
    await ledger(held.submissionKey!, ['reserve']);
    const res = await retry(held.id);
    expect([res.statusCode, res.json().error]).toEqual([409, 'not_retryable']);
    expect(await attempts(held.id)).toBe(0);
    expect(await jobs(held.id)).toBe(0);
    // Payload agrees: the Retry button is hidden for a maybe-billed world.
    expect((await listItem(held.id)).item.retryable).toBe(false);
    const detail = (await call('GET', `/v1/worlds/${held.id}`, cookieA)).json();
    expect(detail.world.retryable).toBe(false);

    const released = await seed({ failureStage: 'submit', failureCode: 'INSUFFICIENT_CREDITS' });
    await ledger(released.submissionKey!, ['reserve', 'release']);
    expect((await retry(released.id)).statusCode).toBe(200);
  });

  it('400 approval_below_quote with quote_credits when approval is under the re-quote', async () => {
    const w = await seed();
    const res = await retry(w.id, { approved: QUOTE - 1 });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: 'approval_below_quote', quote_credits: QUOTE });
    expect(await attempts(w.id)).toBe(0);
  });

  it('payload: failed world carries retryable, submit_attempt and frame_count (list + detail)', async () => {
    const w = await seed();
    const { item } = await listItem(w.id);
    expect(item).toMatchObject({ retryable: true, submit_attempt: 1, frame_count: FRAMES });
    const detail = (await call('GET', `/v1/worlds/${w.id}`, cookieA)).json();
    expect(detail.world).toMatchObject({ retryable: true, submit_attempt: 1, frame_count: FRAMES });
  });

  it('success resets the world, archives the old attempt, enqueues submit, skips the scan quota; replay is idempotent', async () => {
    const w = await seed();
    await ledger(w.submissionKey!, ['reserve', 'release']);
    const before = await quota();
    const key = randomUUID();
    const res = await retry(w.id, { key, approved: QUOTE + 70 });
    expect(res.statusCode).toBe(200);
    expect(res.json().world).toMatchObject({
      id: w.id, status: 'submitting', submit_attempt: 2, retryable: false, frame_count: FRAMES,
      failure_stage: null, failure_code: null,
    });

    const after = await row(w.id);
    expect(after.submissionKey).toBeTruthy();
    expect(after.submissionKey).not.toBe(w.submissionKey);
    expect(after).toMatchObject({
      status: 'submitting', submitBody: null, providerRequestId: null, quotedCredits: null,
      failureStage: null, failureCode: null, failureMessage: null, progress: null,
      submitAttempt: 2, approvedMaxCredits: QUOTE + 70,
    });
    const arch = (await schema.pool.query('SELECT * FROM world_attempts WHERE world_id = $1', [w.id])).rows;
    expect(arch).toHaveLength(1);
    expect(arch[0]).toMatchObject({
      attempt: 1, submission_key: w.submissionKey, provider_request_id: w.providerRequestId,
      failure_stage: 'processing', failure_code: 'WORLD_GENERATION_FAILED', quoted_credits: QUOTE,
      client_request_id: key,
    });
    const js = (await schema.pool.query('SELECT kind FROM jobs WHERE world_id = $1', [w.id])).rows;
    expect(js.map((j) => j.kind)).toEqual(['submit']);
    expect(await quota()).toBe(before); // A-04
    // The old reservation is untouched (still reserve + release).
    expect(await n('SELECT count(*) AS n FROM credit_events WHERE submission_key = $1', w.submissionKey!)).toBe(2);

    const again = await retry(w.id, { key, approved: QUOTE + 70 });
    expect(again.statusCode).toBe(200);
    expect(again.json().world.submit_attempt).toBe(2);
    expect(await attempts(w.id)).toBe(1);
    expect((await row(w.id)).submissionKey).toBe(after.submissionKey);
    expect(await jobs(w.id)).toBe(1);
  });

  it('bundle gone → status packing with a pack job for the latest capture', async () => {
    const w = await seed({ bundle: false });
    const res = await retry(w.id);
    expect(res.statusCode).toBe(200);
    expect(res.json().world.status).toBe('packing');
    const js = (await schema.pool.query('SELECT kind, payload FROM jobs WHERE world_id = $1', [w.id])).rows;
    const cap = (await schema.pool.query('SELECT id FROM captures WHERE world_id = $1', [w.id])).rows[0];
    expect(js).toEqual([{ kind: 'pack', payload: { captureId: cap.id } }]);
  });

  it('two concurrent retries with different keys → exactly one 200, one 409, one attempt, one new key', async () => {
    const w = await seed();
    const [a, b] = await Promise.all([retry(w.id), retry(w.id)]);
    expect([a.statusCode, b.statusCode].sort()).toEqual([200, 409]);
    expect([a, b].find((r) => r.statusCode === 409)!.json().error).toBe('not_retryable');
    expect(await attempts(w.id)).toBe(1);
    expect(await jobs(w.id)).toBe(1);
    expect((await row(w.id)).submitAttempt).toBe(2);
  });

  it('WR-06: applyRetry re-checks retryability and the ledger inside its tx (stale pre-check loses)', async () => {
    const args = () => ({ approvedMaxCredits: QUOTE, clientRequestId: randomUUID(), bundlePresent: true, captureId: randomUUID() });
    // A reserve appeared on the key after the route's ledgerClear check.
    const held = await seed();
    await ledger(held.submissionKey!, ['reserve']);
    expect(await applyRetry(schema.db, held, args())).toBeNull();
    // Revived and failed again with a non-retryable code under the same submit_attempt.
    const moved = await seed();
    await schema.pool.query("UPDATE worlds SET failure_stage = 'submit', failure_code = 'SUBMIT_UNCERTAIN' WHERE id = $1", [moved.id]);
    expect(await applyRetry(schema.db, moved, args())).toBeNull();
    for (const w of [held, moved]) {
      expect(await attempts(w.id)).toBe(0);
      expect(await jobs(w.id)).toBe(0);
      expect((await row(w.id)).submissionKey).toBe(w.submissionKey);
    }
  });

  it('WR-11: a provider quote failure → 503 quote_unavailable (429/503/timeout) or 502, nothing written', async () => {
    const cases: [Error, number, Record<string, unknown>][] = [
      [new ProviderError('429', { status: 429, retryAfterS: 7, endpoint: 'quote' }), 503, { error: 'quote_unavailable', retry_after: 7 }],
      [new ProviderTimeoutError('quote timed out', 'quote'), 503, { error: 'quote_unavailable', retry_after: null }],
      [new ProviderError('quote: bad response shape', { endpoint: 'quote' }), 502, { error: 'quote_failed' }],
    ];
    try {
      for (const [err, code, body] of cases) {
        const w = await seed();
        quoteFail = err;
        const res = await retry(w.id);
        expect([res.statusCode, res.json()]).toEqual([code, body]);
        expect(await attempts(w.id)).toBe(0);
        expect(await jobs(w.id)).toBe(0);
      }
    } finally {
      quoteFail = undefined;
    }
  });

  it('WR-11: a replayed retry reports retryable=false while the world holds a reserve (matches GET detail)', async () => {
    const w = await seed();
    const key = randomUUID();
    expect((await retry(w.id, { key })).statusCode).toBe(200);
    // The new attempt reserved, then failed again with a retryable code.
    const cur = await row(w.id);
    await ledger(cur.submissionKey!, ['reserve']);
    await schema.pool.query("UPDATE worlds SET status = 'failed', failure_stage = 'submit', failure_code = 'RATE_LIMITED' WHERE id = $1", [w.id]);
    const again = await retry(w.id, { key });
    expect(again.statusCode).toBe(200);
    expect(again.json().world.retryable).toBe(false);
    expect((await call('GET', `/v1/worlds/${w.id}`, cookieA)).json().world.retryable).toBe(false);
  });

  it('budgetAlert names the daily window once spend reaches share × budget (list + quote)', async () => {
    await schema.db.insert(creditEvents).values({ amount: DAILY * 0.8, submissionKey: randomUUID(), providerMode: 'mock' });
    const { body } = await listItem(randomUUID());
    expect(body.budgetAlert).toMatchObject({ window: 'daily', share: 0.8, budget: DAILY });
    expect(body.budgetAlert.spent).toBeGreaterThanOrEqual(DAILY * 0.8);
    const q = (await call('GET', `/v1/quote?frames=${FRAMES}`, cookieA)).json();
    expect(q.budgetAlert).toMatchObject({ window: 'daily', budget: DAILY });
  });
});

describe.skipIf(!url)('retry end to end (mock pipeline, real Postgres)', () => {
  let p: Pipeline | undefined;
  afterAll(async () => {
    await p?.close();
  });

  it('first attempt provider FAILED → applyRetry → ready with two keys; first reserve released, second kept', async () => {
    p = await startPipeline({ scenario: 'failed', retryAfterS: 0, trackPollSeconds: 0 });
    const { worldId, captureId } = await p.seedScan();
    const failed = await p.drain({ worldId });
    expect([failed.status, failed.failureStage]).toEqual(['failed', 'processing']);
    const firstKey = failed.submissionKey!;

    const [cap] = await p.db.select().from(captures).where(eq(captures.id, captureId));
    const next = await applyRetry(p.db, failed, {
      approvedMaxCredits: 5000,
      clientRequestId: randomUUID(),
      bundlePresent: !!cap!.bundleKey,
      captureId,
    });
    expect(next).not.toBeNull();
    expect(next!.submissionKey).not.toBe(firstKey);

    const happy = createMockProvider({
      processingSeconds: 1,
      retryAfterS: 0,
      webhookSecret: TEST_WEBHOOK_SECRET,
      deliver: () => Promise.resolve(),
    });
    const done = await p.drain({ worldId, deps: { ...p.deps, provider: happy } as WorkerDeps });
    expect(done.status).toBe('ready');
    expect(done.submitAttempt).toBe(2);

    const rows = (
      await p.pool.query('SELECT submission_key, kind FROM credit_events WHERE world_id = $1 OR submission_key = ANY($2)', [
        worldId,
        [firstKey, done.submissionKey],
      ])
    ).rows as { submission_key: string; kind: string }[];
    const kinds = (k: string) => rows.filter((r) => r.submission_key === k).map((r) => r.kind).sort();
    expect(new Set(rows.map((r) => r.submission_key))).toEqual(new Set([firstKey, done.submissionKey]));
    expect(kinds(firstKey)).toEqual(['release', 'reserve']);
    expect(kinds(done.submissionKey!)).toEqual(['reserve']);
  }, 180_000);
});

describe.skipIf(!url)('CR-01: retry vs a stale submit job (mock pipeline, real Postgres)', () => {
  let p: Pipeline | undefined;
  afterAll(async () => {
    await p?.close();
  });

  it('the retry retires the crashed attempt-1 submit job, and a stale job never sends the new key', async () => {
    p = await startPipeline({ scenario: '402', retryAfterS: 0, trackPollSeconds: 0 });
    const { worldId, captureId } = await p.seedScan();
    const failed = await p.drain({ worldId });
    expect([failed.failureStage, failed.failureCode]).toEqual(['submit', 'INSUFFICIENT_CREDITS']);
    // Crash between failWorld and completeJob: the submit job is left running.
    await p.pool.query(
      "UPDATE jobs SET phase = 'running', locked_by = 'dead-worker', locked_at = now() - interval '1 hour' WHERE world_id = $1 AND kind = 'submit'",
      [worldId],
    );
    const [cap] = await p.db.select().from(captures).where(eq(captures.id, captureId));
    const next = await applyRetry(p.db, failed, {
      approvedMaxCredits: 5000,
      clientRequestId: randomUUID(),
      bundlePresent: !!cap!.bundleKey,
      captureId,
    });
    expect(next!.submitAttempt).toBe(2);
    const js = (
      await p.pool.query("SELECT phase, payload FROM jobs WHERE world_id = $1 AND kind = 'submit' ORDER BY created_at", [worldId])
    ).rows as { phase: string; payload: { submitAttempt?: number } | null }[];
    expect(js.map((j) => j.phase)).toEqual(['done', 'queued']);
    expect(js[1]!.payload).toEqual({ submitAttempt: 2 });

    const happy = createMockProvider({ processingSeconds: 1, retryAfterS: 0, webhookSecret: TEST_WEBHOOK_SECRET, deliver: () => Promise.resolve() });
    const deps = { ...p.deps, provider: happy } as WorkerDeps;
    // A job for attempt 1 that somehow survived: it completes without sending.
    const staleId = await enqueue(p.db, 'submit', worldId, { submitAttempt: 1 });
    const staleRow = (await p.pool.query('SELECT * FROM jobs WHERE id = $1', [staleId])).rows[0];
    await handleSubmit(deps, mapJobRow(staleRow));
    expect(happy.calls.submit).toHaveLength(0);
    expect((await p.pool.query('SELECT phase FROM jobs WHERE id = $1', [staleId])).rows[0].phase).toBe('done');

    const done = await p.drain({ worldId, deps });
    expect(done.status).toBe('ready');
    expect(happy.calls.submit).toHaveLength(1);
    expect(happy.calls.submit[0]!.key).toBe(next!.submissionKey);
  }, 180_000);
});

describe.skipIf(!url)('iter2: a stalled submit run vs a retry (mock pipeline, real Postgres)', () => {
  let p: Pipeline | undefined;
  afterAll(async () => {
    await p?.close();
  });

  /** Claim the world's submit job as worker-a and run it; `midQuote` runs while the run is paused in quote(). */
  async function stalledRun(opts: { legacy: boolean; quote: number; midQuote: (worldId: string, captureId: string) => Promise<void> }) {
    p = await startPipeline({ scenario: 'happy', retryAfterS: 0, trackPollSeconds: 0 });
    const { worldId, captureId } = await p.seedScan();
    await p.drain({ worldId, until: (w) => w.status === 'submitting' });
    const job = (await claimNextJob(p.db, ['submit'], 'it-worker-a'))!;
    // A legacy payload (no submitAttempt) stands in for a run that already passed the attempt check.
    if (opts.legacy) job.payload = null;
    const happy = createMockProvider({ processingSeconds: 1, retryAfterS: 0, webhookSecret: TEST_WEBHOOK_SECRET, deliver: () => Promise.resolve() });
    let paused = false;
    happy.quote = async () => {
      if (!paused) {
        paused = true;
        await opts.midQuote(worldId, captureId);
      }
      return { credits: opts.quote, available: Number.POSITIVE_INFINITY };
    };
    const deps = { ...p.deps, provider: happy, workerId: 'it-worker-a' } as WorkerDeps;
    const run = await handleSubmit(deps, job).then(() => null, (e: unknown) => e);
    return { worldId, happy, run };
  }

  /** Another worker refused attempt 1 with a retryable code; the owner retried (attempt 2, new key, job retired). */
  async function refuseAndRetry(worldId: string, captureId: string, approvedMaxCredits: number) {
    await failWorld(p!.db, worldId, ['submitting'], 'submit', 'BUDGET_EXCEEDED', 'daily credit budget exceeded');
    const failed = await p!.getWorld(worldId);
    const next = await applyRetry(p!.db, failed, { approvedMaxCredits, clientRequestId: randomUUID(), bundlePresent: true, captureId });
    expect(next!.submitAttempt).toBe(2);
  }

  it('WR-01: a run retired by a retry while stalled stops on the lease check: nothing reserved, nothing sent', async () => {
    const { worldId, happy, run } = await stalledRun({ legacy: true, quote: QUOTE, midQuote: (w, c) => refuseAndRetry(w, c, 5000) });
    expect(run).toBeInstanceOf(LeaseLostError);
    expect(happy.calls.submit).toHaveLength(0);
    const w = await p!.getWorld(worldId);
    expect([w.status, w.submitAttempt, w.providerRequestId]).toEqual(['submitting', 2, null]);
    const reserves = (await p!.pool.query("SELECT count(*)::int AS n FROM credit_events WHERE world_id = $1 AND kind = 'reserve'", [worldId])).rows[0].n;
    expect(reserves).toBe(0);
  }, 180_000);

  it('WR-02: a stalled run whose quote exceeds its stale approval neither re-quotes nor fails the new attempt', async () => {
    // The run holds approval 5000 in memory; its quote (6000) lands after the retry (approval 7000).
    const { worldId, happy, run } = await stalledRun({ legacy: false, quote: 6000, midQuote: (w, c) => refuseAndRetry(w, c, 7000) });
    expect(run).toBeNull();
    expect(happy.calls.submit).toHaveLength(0);
    const w = await p!.getWorld(worldId);
    expect([w.status, w.submitAttempt, w.quotedCredits, w.submitBody, w.failureCode]).toEqual(['submitting', 2, null, null, null]);
  }, 180_000);
});
