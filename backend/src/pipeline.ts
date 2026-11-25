import { randomUUID } from 'node:crypto';
import { pipeline, Transform, type Readable } from 'node:stream';
import { and, desc, eq, inArray, isNull, or, sql, type SQL } from 'drizzle-orm';
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

/**
 * Fail a world from one of `from`. Messages are built from codes; URLs are scrubbed anyway.
 * `extra` narrows the match further (e.g. to one submit attempt).
 */
export async function failWorld(
  db: Pick<Db, 'update'>,
  worldId: string,
  from: WorldStatus[],
  stage: FailureStage,
  code: string,
  message: string,
  extra?: SQL,
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
    .where(and(eq(worlds.id, worldId), inArray(worlds.status, from), extra))
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

/**
 * WR-04: beat the lease at most every `everyMs` while an artifact streams; the
 * download timeout (15 min) outlives LEASE_SECONDS (10 min). A lost lease
 * errors the stream, so the upload aborts instead of racing the new owner.
 */
export function withHeartbeat(src: Readable, beat: () => Promise<void>, everyMs = 60_000): Readable {
  let last = Date.now();
  const out = new Transform({
    transform(chunk, _enc, cb) {
      if (Date.now() - last < everyMs) return cb(null, chunk);
      last = Date.now();
      beat().then(() => cb(null, chunk), cb);
    },
  });
  pipeline(src, out, () => undefined); // src errors destroy `out` with the same error
  return out;
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
    // CR-01: the job carries its attempt so a stale run can't send a later attempt's key.
    if (flipped.length > 0) await enqueue(tx, 'submit', w.id, { submitAttempt: w.submitAttempt });
  });
  await completeJob(db, job.id, job.lockedBy);
}

// --- submit (the only credit-spending step) ------------------------------------

export async function handleSubmit(deps: WorkerDeps, job: Job): Promise<void> {
  const { db, storage, provider, config } = deps;
  // CR-01: a job enqueued for an earlier attempt (payload.submitAttempt) must
  // never run against a key a retry minted later. Legacy payloads skip the check.
  const jobAttempt = (job.payload as { submitAttempt?: number } | null)?.submitAttempt;
  const stale = (x: World | undefined) =>
    x?.status !== 'submitting' || !!x.deletedAt || (jobAttempt !== undefined && jobAttempt !== x.submitAttempt);
  let w = await getWorld(db, job.worldId);
  if (stale(w)) return completeJob(db, job.id, job.lockedBy);
  w = w!;
  const worldId = w.id;
  // iter2 WR-02: every world write below is scoped to the attempt read here, so
  // a run that stalled across a retry can't fail, re-quote or re-body the new attempt.
  const thisAttempt = eq(worlds.submitAttempt, w.submitAttempt);
  // One tx (CR-01): a crash between the two used to leave a retryable failed
  // world with a live submit job that a retry would then race. iter2 WR-04: a
  // known-not-charged release commits with the failure, never before it (a crash
  // between them left a released key that the resume would re-send).
  const refuse = (code: string, message: string, release?: string) =>
    db.transaction(async (tx) => {
      if (release) await releaseCredits(tx, release);
      await failWorld(tx, worldId, ['submitting'], 'submit', code, message, thisAttempt);
      await completeJob(tx as unknown as Db, job.id, job.lockedBy);
    });

  if (w.approvedMaxCredits == null) return refuse('NOT_APPROVED', 'no approved credit ceiling');
  const cap = await latestCapture(db, worldId);
  if (!cap?.bundleKey) return refuse('BUNDLE_MISSING', 'capture has no packed bundle');

  // Quote + approval only until the body is persisted (WR-01): after that a send
  // may have happened, so a resume goes straight to reserve/submit and the
  // quote that the reservation was made for is never rewritten.
  if (w.submitBody == null) {
    const quote = await provider.quote(cap.frameCount);
    // WR-05: a racing run of this job may have persisted the body (and reserved
    // the old quote) since we read the world: then neither rewrite nor refuse.
    const [quoted] = await db
      .update(worlds)
      .set({ quotedCredits: quote.credits })
      .where(and(eq(worlds.id, worldId), thisAttempt, isNull(worlds.submitBody)))
      .returning({ id: worlds.id });
    if (quoted && quote.credits > w.approvedMaxCredits) {
      return refuse('QUOTE_ABOVE_APPROVAL', `quote ${quote.credits} > approved ${w.approvedMaxCredits}`);
    }
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
      .where(and(eq(worlds.id, worldId), thisAttempt, isNull(worlds.submitBody)));
  }
  // Always send what the DB holds (RESEARCH Pattern 1), including the first send.
  w = (await getWorld(db, worldId))!;
  if (stale(w)) return completeJob(db, job.id, job.lockedBy);
  const key = w.submissionKey!;
  const quoted = w.quotedCredits!;
  // iter2 WR-01: the attempt check above is a read. A run that stalled past its
  // lease (and was retired by a retry) must stop before it spends: a retired or
  // re-claimed job fails the heartbeat → LeaseLostError, nothing reserved or sent.
  const beat = heartbeat(deps, job);
  await beat();

  try {
    await reserveCredits(db, {
      key,
      amount: quoted,
      mode: provider.mode,
      worldId,
      daily: config.DAILY_CREDIT_BUDGET,
      monthly: config.MONTHLY_CREDIT_BUDGET,
      // D-12: budget.ts records the alert once per window in the reserve tx and
      // calls this after commit. The push is never awaited (WR-07): a slow or
      // hung APNs call must not hold the paid send (and its lease) behind it.
      // Each window's push fails on its own, logged. No keys/URLs logged.
      share: config.BUDGET_ALERT_SHARE,
      onAlert: (alerts) => {
        for (const a of alerts) {
          console.warn('[budget-alert]', JSON.stringify({ mode: provider.mode, window: a.window, spent: a.spent, budget: a.budget, share: a.share, worldId }));
          const pct = Math.round((a.spent / a.budget) * 100);
          const span = a.window === 'daily' ? "today's" : "this month's";
          void Promise.resolve()
            .then(() => deps.push(w!.ownerId, 'Processing budget', `You've used ${pct}% of ${span} processing budget`))
            .catch((err: unknown) =>
              console.warn(`[budget-alert] ${a.window} push failed on world ${worldId}: ${err instanceof Error ? err.name : 'unknown'}`),
            );
        }
      },
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
  // Job-scoped marker, per key only because a retry (D-09) retires every other
  // pipeline job in its tx and a stale job's attempt check stops it (CR-01).
  const prev = (job.payload ?? {}) as { uncertain?: boolean; sending?: boolean; submitAttempt?: number };
  const uncertain = prev.uncertain === true || prev.sending === true;
  const mark = (p: { uncertain: boolean; sending?: boolean }) =>
    db.update(jobs).set({ payload: { ...(jobAttempt !== undefined ? { submitAttempt: jobAttempt } : {}), ...p } }).where(eq(jobs.id, job.id));
  await mark({ uncertain, sending: true });

  await beat(); // iter2 WR-01: last ownership check before the paid send
  let requestId: string;
  try {
    ({ requestId } = await provider.submit(JSON.stringify(w.submitBody), key));
  } catch (err) {
    const status = err instanceof ProviderError ? err.status : undefined;
    const backoff = Math.min(30 * 2 ** job.attempts, SUBMIT_MAX_DELAY_S);
    // A-02 / Pitfall 3: every definitive 4xx except 408/409/429 is a refusal
    // (401/404/413/422 included), not 4 attempts of SUBMIT_UNCERTAIN.
    const refusal = status !== undefined && status >= 400 && status < 500 && status !== 408 && status !== 409 && status !== 429;
    const definitive = refusal || status === 429 || status === 503;
    await mark({ uncertain: uncertain || !definitive });
    if (refusal) {
      const code = (err as ProviderError).code;
      if (uncertain) {
        // Pitfall 7: an earlier attempt may have been billed. Keep the
        // reservation and use a non-retryable code so the world isn't retried.
        return refuse('SUBMIT_UNCERTAIN', `provider refused submit (${status} ${code ?? ''}) after an uncertain attempt`);
      }
      // known not charged
      return refuse(status === 401 ? 'PROVIDER_AUTH' : (code ?? `HTTP_${status}`), `provider refused submit (${status})`, key);
    }
    if (status === 409) {
      // Never mint a new key; the reservation stays (it may be billed).
      console.error(`[pipeline] IDEMPOTENCY_KEY_REUSED on world ${worldId}; parking submit job ${job.id}`);
      await failWorld(db, worldId, ['submitting'], 'submit', 'IDEMPOTENCY_KEY_REUSED', 'provider returned 409', thisAttempt);
      return parkJobDead(db, job.id, 'IDEMPOTENCY_KEY_REUSED', job.lockedBy);
    }
    if (status === 429 || status === 503) {
      if (job.attempts < SUBMIT_MAX_ATTEMPTS) {
        const delay = Math.min((err as ProviderError).retryAfterS ?? backoff, SUBMIT_MAX_DELAY_S);
        throw new RetryLaterError(`submit ${status}, retrying with the same key`, delay + Math.round(Math.random()));
      }
      if (!uncertain) {
        // never accepted
        return refuse(status === 429 ? 'RATE_LIMITED' : 'PROVIDER_UNAVAILABLE', `submit ${status} after ${job.attempts} attempts`, key);
      }
    }
    // 5xx / timeout / network: the request may exist and be billed — keep the reservation.
    if (job.attempts < SUBMIT_MAX_ATTEMPTS) {
      throw new RetryLaterError(`submit outcome uncertain (${status ?? 'network'}), retrying with the same key`, backoff);
    }
    await failWorld(db, worldId, ['submitting'], 'submit', 'SUBMIT_UNCERTAIN', `submit outcome uncertain after ${job.attempts} attempts`, thisAttempt);
    return parkJobDead(db, job.id, 'SUBMIT_UNCERTAIN', job.lockedBy);
  }

  const cur = await getWorld(db, worldId);
  const recorded = await db.transaction(async (tx) => {
    // iter2 WR-01: never record a request id for a key the world no longer holds.
    const [own] = await tx
      .update(worlds)
      .set({ providerRequestId: requestId })
      .where(and(eq(worlds.id, worldId), eq(worlds.submissionKey, key)))
      .returning({ id: worlds.id });
    if (!own) return false;
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
    return true;
  });
  if (!recorded) {
    console.error(`[pipeline] RECONCILE: request ${requestId} for key ${key} on world ${worldId} was accepted but the world no longer holds that key; not recorded`);
  } else if (cur?.status === 'failed') {
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
      // One tx (WR-01): a crash between the flip and the release would hold a
      // 0-credit reserve forever and keep the world non-retryable.
      await db.transaction(async (tx) => {
        await releaseCredits(tx, w.submissionKey!); // FAILED = 0 credits
        await failWorld(tx, w.id, ['processing'], 'processing', s.error?.code ?? codes[0] ?? 'FAILED', codes.join(', ') || (s.error?.code ?? 'FAILED'));
      });
      return completeJob(db, job.id, job.lockedBy);
    }
    if (s.status === 'CANCELLED') {
      await db.transaction(async (tx) => {
        await releaseCredits(tx, w.submissionKey!);
        await tx
          .update(worlds)
          .set({ status: 'cancelled', progress: null, updatedAt: new Date() })
          .where(and(eq(worlds.id, w.id), eq(worlds.status, 'processing')));
      });
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
    if (!exists) {
      try {
        await storage.putStream(key, withHeartbeat(await provider.open(a), beat), a.contentType).done;
      } catch (err) {
        // A-05 / Pitfall 11: the thumbnail is optional — retried by the normal
        // snooze for 3 passes, then skipped so it can't wedge a paid import.
        // IN-11: a lost lease is never "optional" — the new owner finalizes.
        if (err instanceof LeaseLostError || a.kind !== 'thumbnail' || trackErrs(job) < 2) throw err;
        console.warn(`[pipeline] skipping thumbnail on world ${w.id} after 3 failed passes: ${err instanceof Error ? err.name : 'unknown'}`);
        continue;
      }
    }
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
