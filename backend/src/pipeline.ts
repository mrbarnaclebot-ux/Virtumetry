import { randomUUID } from 'node:crypto';
import { and, desc, eq, inArray, isNull, or, sql } from 'drizzle-orm';
import { BudgetExceededError, releaseCredits, reserveCredits } from './budget.js';
import { BundleInvalidError, packCapture } from './bundle/pack.js';
import { captureConfig } from './capture-config.js';
import type { Db } from './db/client.js';
import { captures, jobs, worlds, type FailureStage, type Job, type World, type WorldStatus } from './db/schema.js';
import { ProviderError, type ArtifactKind, type ExportKind } from './provider/index.js';
import { completeJob, enqueue, heartbeatJob, parkJobDead, snoozeJob } from './queue.js';
import { worldAssetKey } from './storage/index.js';
import { LeaseLostError, purgePrefix, RetryLaterError, type WorkerDeps } from './worker.js';

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
  // Soft-deleted (CR-03): stop; purge owns the world's objects now.
  if (w?.status !== 'packing' || w.deletedAt) return completeJob(db, job.id, job.lockedBy);
  if (!cap) {
    await failWorld(db, w.id, ['packing'], 'validate', 'CAPTURE_MISSING', 'no capture row');
    return completeJob(db, job.id, job.lockedBy);
  }

  const cc = captureConfig(deps.config);
  const limits = await provider.limits();
  let res;
  try {
    res = await packCapture(storage, cap.id, {
      minFrames: Math.max(cc.precheck.minFrames, limits.minFrames),
      maxFrames: limits.maxFrames,
      rules: cc.precheck, // D-17: same rules as `:complete` and the device precheck
      onProgress: heartbeat(deps, job),
    });
  } catch (err) {
    if (!(err instanceof BundleInvalidError)) throw err; // retryable
    const codes = err.issues.map((i) => i.code);
    await failWorld(db, w.id, ['packing'], 'validate', codes[0] ?? 'BUNDLE_INVALID', codes.join(', '));
    return completeJob(db, job.id, job.lockedBy);
  }
  // Deleted while we packed: purge may already have listed bundles/, so the
  // bundle we just wrote is ours to remove (deleted_at commits before purge runs).
  // A missing row means purge already hard-deleted it (D-17): same cleanup.
  const after = await getWorld(db, w.id);
  if (!after || after.deletedAt) {
    await storage.deleteObject(res.bundleKey);
    return completeJob(db, job.id, job.lockedBy);
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
  await completeJob(db, job.id, job.lockedBy);
}

// --- submit (the only credit-spending step) ------------------------------------

export async function handleSubmit(deps: WorkerDeps, job: Job): Promise<void> {
  const { db, storage, provider, config } = deps;
  let w = await getWorld(db, job.worldId);
  if (w?.status !== 'submitting' || w.deletedAt) return completeJob(db, job.id, job.lockedBy);
  const worldId = w.id;
  const refuse = async (code: string, message: string) => {
    await failWorld(db, worldId, ['submitting'], 'submit', code, message);
    await completeJob(db, job.id, job.lockedBy);
  };

  if (w.approvedMaxCredits == null) return refuse('NOT_APPROVED', 'no approved credit ceiling');
  const cap = await latestCapture(db, worldId);
  if (!cap?.bundleKey) return refuse('BUNDLE_MISSING', 'capture has no packed bundle');

  // Quote + approval only until the body is persisted (WR-01): after that a send
  // may have happened, so a resume goes straight to reserve/submit and the
  // quote that the reservation was made for is never rewritten.
  if (w.submitBody == null) {
    const quote = await provider.quote(cap.frameCount);
    if (quote.credits > w.approvedMaxCredits) {
      return refuse('QUOTE_ABOVE_APPROVAL', `quote ${quote.credits} > approved ${w.approvedMaxCredits}`);
    }
    await db.update(worlds).set({ quotedCredits: quote.credits }).where(eq(worlds.id, worldId));
  }

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

  // Sticky (CR-02): once any earlier attempt's outcome was unknown (an error that
  // was not a definitive refusal, or a crash mid-send that left `sending` set), a
  // later 4xx/429/503 proves nothing about it, so the reservation is never released.
  // ponytail: job-scoped marker; there is one submit job per world today.
  const prev = (job.payload ?? {}) as { uncertain?: boolean; sending?: boolean };
  const uncertain = prev.uncertain === true || prev.sending === true;
  const mark = (p: { uncertain: boolean; sending?: boolean }) =>
    db.update(jobs).set({ payload: p }).where(eq(jobs.id, job.id));
  await mark({ uncertain, sending: true });

  let requestId: string;
  try {
    ({ requestId } = await provider.submit(JSON.stringify(w.submitBody), key));
  } catch (err) {
    const status = err instanceof ProviderError ? err.status : undefined;
    const backoff = Math.min(30 * 2 ** job.attempts, SUBMIT_MAX_DELAY_S);
    const definitive = status === 400 || status === 402 || status === 403 || status === 429 || status === 503;
    await mark({ uncertain: uncertain || !definitive });
    if (status === 400 || status === 402 || status === 403) {
      // Known not charged (unless an earlier attempt may have been).
      if (!uncertain) await releaseCredits(db, key);
      return refuse((err as ProviderError).code ?? `HTTP_${status}`, `provider refused submit (${status})`);
    }
    if (status === 409) {
      // Never mint a new key; the reservation stays (it may be billed).
      console.error(`[pipeline] IDEMPOTENCY_KEY_REUSED on world ${worldId}; parking submit job ${job.id}`);
      await failWorld(db, worldId, ['submitting'], 'submit', 'IDEMPOTENCY_KEY_REUSED', 'provider returned 409');
      return parkJobDead(db, job.id, 'IDEMPOTENCY_KEY_REUSED', job.lockedBy);
    }
    if (status === 429 || status === 503) {
      if (job.attempts < SUBMIT_MAX_ATTEMPTS) {
        const delay = Math.min((err as ProviderError).retryAfterS ?? backoff, SUBMIT_MAX_DELAY_S);
        throw new RetryLaterError(`submit ${status}, retrying with the same key`, delay + Math.round(Math.random()));
      }
      if (!uncertain) {
        await releaseCredits(db, key); // never accepted
        return refuse(status === 429 ? 'RATE_LIMITED' : 'PROVIDER_UNAVAILABLE', `submit ${status} after ${job.attempts} attempts`);
      }
    }
    // 5xx / timeout / network: the request may exist and be billed — keep the reservation.
    if (job.attempts < SUBMIT_MAX_ATTEMPTS) {
      throw new RetryLaterError(`submit outcome uncertain (${status ?? 'network'}), retrying with the same key`, backoff);
    }
    await failWorld(db, worldId, ['submitting'], 'submit', 'SUBMIT_UNCERTAIN', `submit outcome uncertain after ${job.attempts} attempts`);
    return parkJobDead(db, job.id, 'SUBMIT_UNCERTAIN', job.lockedBy);
  }

  const cur = await getWorld(db, worldId);
  await db.transaction(async (tx) => {
    await tx.update(worlds).set({ providerRequestId: requestId }).where(eq(worlds.id, worldId));
    // A confirmed (paid) request beats a stale submit-stage failure (WR-02): if
    // the world was failed under us (e.g. reaper after a lease expiry), revive
    // it so the request is tracked instead of silently orphaned.
    const [flipped] = await tx
      .update(worlds)
      .set({ status: 'processing', progress: null, failureStage: null, failureCode: null, failureMessage: null, updatedAt: new Date() })
      .where(
        and(
          eq(worlds.id, worldId),
          or(eq(worlds.status, 'submitting'), and(eq(worlds.status, 'failed'), eq(worlds.failureStage, 'submit'))),
        ),
      )
      .returning({ id: worlds.id });
    if (flipped) await enqueue(tx, 'track', worldId);
  });
  if (cur?.status === 'failed') {
    console.error(`[pipeline] world ${worldId} was failed mid-submit but request ${requestId} exists; tracking it`);
  }
  await completeJob(db, job.id, job.lockedBy);
}

// --- track + import -------------------------------------------------------------

const KEY_COLUMN: Partial<Record<ArtifactKind, 'splatKey' | 'colliderKey' | 'floorplanKey' | 'camerasKey' | 'thumbnailKey'>> = {
  splat: 'splatKey',
  collider: 'colliderKey',
  floorplan: 'floorplanKey',
  cameras: 'camerasKey',
  thumbnail: 'thumbnailKey',
};
const EXPORTS: ExportKind[] = ['mesh-simplified', 'floorplan'];
const loggedUnknown = new Set<string>();

const TRACK_MAX_DELAY_S = 900;
const trackErrs = (job: Job) => (job.payload as { errs?: number } | null)?.errs ?? 0;

/**
 * Once provider_request_id exists the request is paid: an error while polling or
 * importing (provider 429/5xx, storage, DB blip) must never burn the job's
 * attempts and fail the world. Errors snooze with backoff on a consecutive-error
 * count in the payload, reset by the next clean pass (CR-01).
 * ponytail: never gives up; a permanently broken request polls every 15 min
 * until a human looks (the log says so). Add a TRACK_STALLED park if that hurts.
 */
export async function handleTrack(deps: WorkerDeps, job: Job): Promise<void> {
  const { db, config } = deps;
  try {
    await trackOnce(deps, job);
  } catch (err) {
    if (err instanceof LeaseLostError) throw err; // another worker owns it now
    const errs = trackErrs(job) + 1;
    const delay = Math.min(config.TRACK_POLL_SECONDS * 2 ** errs, TRACK_MAX_DELAY_S);
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[pipeline] track job ${job.id} error #${errs} on world ${job.worldId}, snoozing ${delay}s: ${msg}`);
    await db.update(jobs).set({ payload: { errs }, lastError: msg.slice(0, 500) }).where(eq(jobs.id, job.id));
    return snoozeJob(db, job.id, delay, job.lockedBy);
  }
  if (trackErrs(job) > 0) await db.update(jobs).set({ payload: null }).where(eq(jobs.id, job.id));
}

async function trackOnce(deps: WorkerDeps, job: Job): Promise<void> {
  const { db, storage, provider, config } = deps;
  const w = await getWorld(db, job.worldId);
  if (!w?.providerRequestId || (w.status !== 'processing' && w.status !== 'importing')) {
    return completeJob(db, job.id, job.lockedBy);
  }
  const rid = w.providerRequestId;
  if (w.deletedAt) {
    // Deleted mid-run (CR-03): stop the provider work, import nothing. The
    // reservation stays: a cancel late in processing may still be billed.
    if (w.status === 'processing') {
      await provider.cancel(rid).catch((e) => console.warn(`[pipeline] cancel ${rid} for deleted world ${w.id} failed: ${String(e)}`));
    }
    return completeJob(db, job.id, job.lockedBy);
  }
  const snooze = () => snoozeJob(db, job.id, config.TRACK_POLL_SECONDS, job.lockedBy);

  if (w.status === 'processing') {
    const s = await provider.status(rid);
    if (s.status === 'FAILED') {
      const codes = (s.issues ?? []).map((i) => i.code);
      await failWorld(db, w.id, ['processing'], 'processing', s.error?.code ?? codes[0] ?? 'FAILED', codes.join(', ') || (s.error?.code ?? 'FAILED'));
      await releaseCredits(db, w.submissionKey!); // FAILED = 0 credits
      return completeJob(db, job.id, job.lockedBy);
    }
    if (s.status === 'CANCELLED') {
      await db
        .update(worlds)
        .set({ status: 'cancelled', progress: null, updatedAt: new Date() })
        .where(and(eq(worlds.id, w.id), eq(worlds.status, 'processing')));
      await releaseCredits(db, w.submissionKey!);
      return completeJob(db, job.id, job.lockedBy);
    }
    if (s.status !== 'COMPLETED') {
      // PENDING / PROCESSING / anything unknown (open enum) → keep polling.
      if (s.status !== 'PENDING' && s.status !== 'PROCESSING' && !loggedUnknown.has(s.status)) {
        loggedUnknown.add(s.status);
        console.warn(`[pipeline] unknown provider status '${s.status}' on world ${w.id}; polling on`);
      }
      if (s.progress != null) {
        const pct = Math.max(0, Math.min(100, Math.round(s.progress * 100)));
        await db.update(worlds).set({ progress: pct, updatedAt: new Date() }).where(eq(worlds.id, w.id));
      }
      return snooze();
    }
    // Zero rows here means someone else moved it; the re-read below decides.
    await db
      .update(worlds)
      .set({ status: 'importing', progress: null, updatedAt: new Date() })
      .where(and(eq(worlds.id, w.id), eq(worlds.status, 'processing')));
    if ((await getWorld(db, w.id))?.status !== 'importing') return completeJob(db, job.id, job.lockedBy);
  }

  for (const kind of EXPORTS) {
    const r = await provider.ensureExport(rid, kind);
    if (r === 'pending') return snoozeJob(db, job.id, Math.min(config.TRACK_POLL_SECONDS, 5), job.lockedBy); // exports finish in seconds
    if (r === 'failed') {
      // Credits were spent: keep the reservation.
      await failWorld(db, w.id, ['importing'], 'import', 'EXPORT_FAILED', `${kind} export failed`);
      return completeJob(db, job.id, job.lockedBy);
    }
  }

  // Re-host every output (D-19), resumable artifact by artifact.
  // ponytail: "object exists" = done; fine for S3 multipart (atomic on complete),
  // the local driver could leave a partial file on a crash mid-stream (dev only).
  const beat = heartbeat(deps, job);
  const keys: Partial<Record<'splatKey' | 'colliderKey' | 'floorplanKey' | 'camerasKey' | 'thumbnailKey', string>> = {};
  let metaKey: string | undefined;
  for (const a of await provider.artifacts(rid)) {
    const key = worldAssetKey(w.id, w.assetVersion, a.name);
    const exists = await storage.objectSize(key).then(() => true, () => false);
    if (!exists) await storage.putStream(key, await provider.open(a), a.contentType).done;
    await beat();
    const col = KEY_COLUMN[a.kind];
    if (col) keys[col] = key;
    if (a.kind === 'floorplan_meta') metaKey = key;
  }
  if (!keys.splatKey) {
    // Nothing to view (WR-04). Credits were spent: keep the reservation.
    await failWorld(db, w.id, ['importing'], 'import', 'ARTIFACT_MISSING', 'provider returned no splat');
    return completeJob(db, job.id, job.lockedBy);
  }
  const floorplanMeta = metaKey ?(JSON.parse((await storage.getObject(metaKey)).toString('utf8')) as unknown) : null;

  const done = await db
    .update(worlds)
    .set({
      ...keys,
      floorplanMeta,
      status: 'ready',
      charged: true,
      creditsSpent: sql`COALESCE(${worlds.quotedCredits}, 0)`,
      progress: null,
      updatedAt: new Date(),
    })
    .where(and(eq(worlds.id, w.id), eq(worlds.status, 'importing'), isNull(worlds.deletedAt)))
    .returning({ id: worlds.id });
  // Deleted while importing: purge may have run before our writes landed.
  // A missing row means purge already hard-deleted it (D-17).
  if (done.length === 0) {
    const after = await getWorld(db, w.id);
    if (!after || after.deletedAt) await purgePrefix(storage, `worlds/${w.id}/`);
  }
  await completeJob(db, job.id, job.lockedBy);
}
