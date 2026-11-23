import { randomUUID } from 'node:crypto';
import { and, desc, eq, inArray, isNull } from 'drizzle-orm';
import { BudgetExceededError, releaseCredits, reserveCredits } from './budget.js';
import { BundleInvalidError, packCapture } from './bundle/pack.js';
import type { Db } from './db/client.js';
import { captures, worlds, type FailureStage, type Job, type World, type WorldStatus } from './db/schema.js';
import { ProviderError } from './provider/index.js';
import { completeJob, enqueue, heartbeatJob, parkJobDead } from './queue.js';
import { LeaseLostError, NonRetryableJobError, RetryLaterError, type WorkerDeps } from './worker.js';

// Pipeline job handlers (D-16): pack → submit → track (poll + import). Provider
// agnostic: everything goes through ReconProvider, so Phase 6 only adds echo3.ts.
// Logs carry world/job ids and storage keys only — never presigned URLs or the
// submit body (T-02-25).

/** Submit attempts before a transient error becomes terminal (D-17). */
export const SUBMIT_MAX_ATTEMPTS = 4;
const SUBMIT_MAX_DELAY_S = 900;
const PREFLIGHT_TIMEOUT_MS = 30_000;

/** Fail a world from one of `from`. Messages are built from codes; URLs are scrubbed anyway. */
export async function failWorld(
  db: Db,
  worldId: string,
  from: WorldStatus[],
  stage: FailureStage,
  code: string,
  message: string,
): Promise<boolean> {
  const rows = await db
    .update(worlds)
    .set({
      status: 'failed',
      failureStage: stage,
      failureCode: code,
      failureMessage: message.replace(/https?:\/\/\S+/g, '[url]').slice(0, 500),
      progress: null,
      updatedAt: new Date(),
    })
    .where(and(eq(worlds.id, worldId), inArray(worlds.status, from)))
    .returning({ id: worlds.id });
  return rows.length > 0;
}

async function getWorld(db: Db, id: string): Promise<World | undefined> {
  const [w] = await db.select().from(worlds).where(eq(worlds.id, id));
  return w;
}

async function latestCapture(db: Db, worldId: string) {
  const [c] = await db
    .select()
    .from(captures)
    .where(eq(captures.worldId, worldId))
    .orderBy(desc(captures.createdAt))
    .limit(1);
  return c;
}

/** Lease heartbeat; throws LeaseLostError once another worker owns the job (§10 R6). */
function heartbeat(deps: WorkerDeps, job: Job) {
  return async () => {
    if (!(await heartbeatJob(deps.db, job.id, deps.workerId))) {
      throw new LeaseLostError(`lease lost on job ${job.id}`);
    }
  };
}

// --- pack ---------------------------------------------------------------------

export async function handlePack(deps: WorkerDeps, job: Job): Promise<void> {
  const { db, storage, provider } = deps;
  const w = await getWorld(db, job.worldId);
  const cap = await latestCapture(db, job.worldId);
  if (w?.status !== 'packing') return completeJob(db, job.id);
  if (!cap) {
    await failWorld(db, w.id, ['packing'], 'validate', 'CAPTURE_MISSING', 'no capture row');
    return completeJob(db, job.id);
  }

  const limits = await provider.limits();
  let res;
  try {
    res = await packCapture(storage, cap.id, { ...limits, onProgress: heartbeat(deps, job) });
  } catch (err) {
    if (!(err instanceof BundleInvalidError)) throw err; // retryable
    const codes = err.issues.map((i) => i.code);
    await failWorld(db, w.id, ['packing'], 'validate', codes[0] ?? 'BUNDLE_INVALID', codes.join(', '));
    return completeJob(db, job.id);
  }

  await db.transaction(async (tx) => {
    await tx
      .update(captures)
      .set({
        bundleKey: res.bundleKey,
        bundleBytes: res.bundleBytes,
        manifestKey: res.manifestKey,
        frameCount: res.frameCount,
        imageW: res.imageW,
        imageH: res.imageH,
      })
      .where(eq(captures.id, cap.id));
    const flipped = await tx
      .update(worlds)
      .set({ status: 'submitting', progress: null, updatedAt: new Date() })
      .where(and(eq(worlds.id, w.id), eq(worlds.status, 'packing')))
      .returning({ id: worlds.id });
    if (flipped.length > 0) await enqueue(tx, 'submit', w.id);
  });
  await completeJob(db, job.id);
}

// --- submit (the only credit-spending step) ------------------------------------

export async function handleSubmit(deps: WorkerDeps, job: Job): Promise<void> {
  const { db, storage, provider, config } = deps;
  let w = await getWorld(db, job.worldId);
  if (w?.status !== 'submitting') return completeJob(db, job.id);
  const worldId = w.id;
  const refuse = async (code: string, message: string) => {
    await failWorld(db, worldId, ['submitting'], 'submit', code, message);
    await completeJob(db, job.id);
  };

  if (w.approvedMaxCredits == null) return refuse('NOT_APPROVED', 'no approved credit ceiling');
  const cap = await latestCapture(db, worldId);
  if (!cap?.bundleKey) return refuse('BUNDLE_MISSING', 'capture has no packed bundle');

  const quote = await provider.quote(cap.frameCount);
  if (quote.credits > w.approvedMaxCredits) {
    return refuse('QUOTE_ABOVE_APPROVAL', `quote ${quote.credits} > approved ${w.approvedMaxCredits}`);
  }
  await db.update(worlds).set({ quotedCredits: quote.credits }).where(eq(worlds.id, worldId));

  // Persist-before-spend (D-17): the key is minted once, ever; a retry reuses it.
  await db
    .update(worlds)
    .set({ submissionKey: randomUUID() })
    .where(and(eq(worlds.id, worldId), isNull(worlds.submissionKey)));

  if (w.submitBody == null) {
    const zipUrl = await storage.presignDownload(cap.bundleKey, config.BUNDLE_URL_TTL_SECONDS);
    const pre = await fetch(zipUrl, {
      headers: { Range: 'bytes=0-15' },
      signal: AbortSignal.timeout(PREFLIGHT_TIMEOUT_MS),
    });
    const head = Buffer.from(await pre.arrayBuffer());
    if (pre.status !== 206 || head.length < 4 || head.readUInt32LE(0) !== 0x04034b50) {
      return refuse('BUNDLE_NOT_RANGEABLE', `Range preflight returned ${pre.status}`);
    }
    const body = {
      model: 'echo-3',
      title: w.title ?? 'Virtumetry scan',
      output_format: 'spz',
      input: { type: 'capture_bundle', zip: { type: 'url', zip_url: zipUrl } },
      // Echo-3 rejects non-https / private webhook URLs; polling covers the rest.
      ...(config.PUBLIC_BASE_URL.startsWith('https://')
        ? { webhook: { url: `${config.PUBLIC_BASE_URL.replace(/\/$/, '')}/v1/webhooks/spaitial` } }
        : {}),
    };
    await db
      .update(worlds)
      .set({ submitBody: body })
      .where(and(eq(worlds.id, worldId), isNull(worlds.submitBody)));
  }
  // Always send what the DB holds (RESEARCH Pattern 1), including the first send.
  w = (await getWorld(db, worldId))!;
  const key = w.submissionKey!;
  const quoted = w.quotedCredits!;

  try {
    await reserveCredits(db, {
      key,
      amount: quoted,
      mode: provider.mode,
      worldId,
      daily: config.DAILY_CREDIT_BUDGET,
      monthly: config.MONTHLY_CREDIT_BUDGET,
    });
  } catch (err) {
    if (err instanceof BudgetExceededError) {
      return refuse('BUDGET_EXCEEDED', `${err.window} credit budget exceeded`);
    }
    throw err;
  }

  let requestId: string;
  try {
    ({ requestId } = await provider.submit(JSON.stringify(w.submitBody), key));
  } catch (err) {
    const status = err instanceof ProviderError ? err.status : undefined;
    const backoff = Math.min(30 * 2 ** job.attempts, SUBMIT_MAX_DELAY_S);
    if (status === 400 || status === 402 || status === 403) {
      // Known not charged.
      await releaseCredits(db, key);
      return refuse((err as ProviderError).code ?? `HTTP_${status}`, `provider refused submit (${status})`);
    }
    if (status === 409) {
      // Never mint a new key; the reservation stays (it may be billed).
      console.error(`[pipeline] IDEMPOTENCY_KEY_REUSED on world ${worldId}; parking submit job ${job.id}`);
      await failWorld(db, worldId, ['submitting'], 'submit', 'IDEMPOTENCY_KEY_REUSED', 'provider returned 409');
      return parkJobDead(db, job.id, 'IDEMPOTENCY_KEY_REUSED');
    }
    if (status === 429 || status === 503) {
      if (job.attempts < SUBMIT_MAX_ATTEMPTS) {
        const delay = Math.min((err as ProviderError).retryAfterS ?? backoff, SUBMIT_MAX_DELAY_S);
        throw new RetryLaterError(`submit ${status}, retrying with the same key`, delay + Math.round(Math.random()));
      }
      await releaseCredits(db, key); // never accepted
      return refuse(status === 429 ? 'RATE_LIMITED' : 'PROVIDER_UNAVAILABLE', `submit ${status} after ${job.attempts} attempts`);
    }
    // 5xx / timeout / network: the request may exist and be billed — keep the reservation.
    if (job.attempts < SUBMIT_MAX_ATTEMPTS) {
      throw new RetryLaterError(`submit outcome uncertain (${status ?? 'network'}), retrying with the same key`, backoff);
    }
    await failWorld(db, worldId, ['submitting'], 'submit', 'SUBMIT_UNCERTAIN', `submit outcome uncertain after ${job.attempts} attempts`);
    return parkJobDead(db, job.id, 'SUBMIT_UNCERTAIN');
  }

  await db.transaction(async (tx) => {
    await tx.update(worlds).set({ providerRequestId: requestId }).where(eq(worlds.id, worldId));
    const flipped = await tx
      .update(worlds)
      .set({ status: 'processing', progress: null, updatedAt: new Date() })
      .where(and(eq(worlds.id, worldId), eq(worlds.status, 'submitting')))
      .returning({ id: worlds.id });
    if (flipped.length > 0) await enqueue(tx, 'track', worldId);
  });
  await completeJob(db, job.id);
}

// --- track + import (Task 3) -------------------------------------------------

export async function handleTrack(_deps: WorkerDeps, job: Job): Promise<void> {
  throw new NonRetryableJobError(`track not implemented yet (job ${job.id})`);
}
