import os from 'node:os';
import { pathToFileURL } from 'node:url';
import { and, eq, lt, sql } from 'drizzle-orm';
import { getConfig, type Config } from './config.js';
import { getDb, closeDb, type Db } from './db/client.js';
import { captures, worlds, type Job, type JobKind, type World } from './db/schema.js';
import {
  claimNextJob,
  completeJob,
  enqueue,
  failJob,
  parkExhaustedJobs,
  parkJobDead,
} from './queue.js';
import { createStorage, type StorageDriver } from './storage/index.js';
import { sendPush, type SendPush } from './push.js';

// Worker loop. Entrypoint: `npm run worker`. Claims `purge` jobs only and runs
// the two reapers (stale uploads, exhausted jobs). Reconstruction job kinds
// arrive with the real provider in a later phase.

const WORKER_KINDS: JobKind[] = ['purge'];

/** Errors that must NOT be retried — the job is parked dead immediately. */
export class NonRetryableJobError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NonRetryableJobError';
  }
}

/**
 * This worker no longer holds the job's lease (spec §10 R6) — another worker
 * re-claimed it and is running it now. The losing worker must abandon the job
 * WITHOUT finalizing anything and WITHOUT touching the job row: failing or
 * parking it would clobber the new owner's lease and its result.
 */
export class LeaseLostError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LeaseLostError';
  }
}

// --- Storage key layout ------------------------------------------------------
const assetKeyFor = (worldId: string, name: string) => `worlds/${worldId}/${name}`;
// Asset objects a world may own (used by purge).
const WORLD_ASSET_NAMES = [
  'splat_100k.spz',
  'splat_500k.spz',
  'splat_full.spz',
  'thumbnail.jpg',
  'collider.glb',
];

export interface WorkerClock {
  now(): number;
  sleep(ms: number): Promise<void>;
}

const realClock: WorkerClock = {
  now: () => Date.now(),
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
};

// =============================================================================
// DB-bound job handlers.
// =============================================================================

export interface WorkerDeps {
  db: Db;
  storage: StorageDriver;
  config: Config;
  push: SendPush;
  clock?: WorkerClock;
  /**
   * Identity of the worker processing the job (`hostname:pid`). Set by
   * startWorker; used to prove lease ownership on every heartbeat (§10 R6).
   */
  workerId?: string;
}


/**
 * purge — delete storage objects under the world + its captures' frame
 * prefixes. The DB row is KEPT (soft-deleted) so history/analytics survive.
 * A `{ framesOnly: true }` payload (reaper) skips the world-asset keys — a
 * reaped uploading world never produced any, and its row is NOT soft-deleted.
 */
async function handlePurge(deps: WorkerDeps, job: Job): Promise<void> {
  const { db, storage } = deps;
  const worldId = job.worldId;
  const framesOnly =
    typeof job.payload === 'object' &&
    job.payload !== null &&
    (job.payload as { framesOnly?: boolean }).framesOnly === true;

  if (!framesOnly) {
    for (const name of WORLD_ASSET_NAMES) {
      await storage.deleteObject(assetKeyFor(worldId, name)).catch(() => undefined);
    }
  }

  const caps = await db.select().from(captures).where(eq(captures.worldId, worldId));
  for (const cap of caps) {
    const prefix = cap.r2FramesPrefix ?? `captures/${cap.id}`;
    for (let i = 0; i < cap.frameCount; i++) {
      await storage.deleteObject(`${prefix}/frame_${i}.heic`).catch(() => undefined);
    }
  }

  // Purge the per-frame ARKit poses too (spec §13 data minimization / §10 R3).
  // poses_json is personal motion data used only for reconstruction; once
  // the frames it describes are gone it is dead weight that survived deletion.
  // Applies to the frames-only (reaper) path as well — same frames, same poses.
  if (caps.length > 0) {
    await db
      .update(captures)
      .set({ posesJson: null })
      .where(eq(captures.worldId, worldId));
  }

  await completeJob(db, job.id);
}

export async function processJob(deps: WorkerDeps, job: Job): Promise<void> {
  switch (job.kind as JobKind) {
    case 'purge':
      return handlePurge(deps, job);
    default:
      throw new NonRetryableJobError(`unknown job kind: ${job.kind}`);
  }
}

export async function handleJobError(db: Db, job: Job, err: unknown): Promise<void> {
  const message = err instanceof Error ? err.message : String(err);

  // Lost lease (§10 R6): another worker owns this job now. Touching the row —
  // failJob would clear locked_at/locked_by, parkJobDead would kill it outright
  // — would sabotage the owner mid-run. Log and walk away.
  if (err instanceof LeaseLostError) {
    console.warn(`[worker] job ${job.id} (${job.kind}) abandoned: ${message}`);
    return;
  }

  if (err instanceof NonRetryableJobError) {
    console.error(`[worker] job ${job.id} (${job.kind}) parked DEAD: ${message}`);
    await parkJobDead(db, job.id, message);
    return;
  }

  console.error(`[worker] job ${job.id} (${job.kind}) failed (retryable): ${message}`);
  if ((await failJob(db, job.id, message)) === 'dead') {
    console.error(`[worker] job ${job.id} (${job.kind}) exhausted its retries, now DEAD`);
  }
}

/**
 * Park jobs that used every attempt without ever reaching failJob — their run
 * killed the process, so the lease simply expired (spec §10 R27). claimNextJob
 * already skips them; this makes them dead. Runs on the reaper cadence.
 * Returns the parked job ids.
 */
export async function reapExhaustedJobs(db: Db): Promise<string[]> {
  const parked = await parkExhaustedJobs(db, WORKER_KINDS);
  for (const job of parked) {
    console.error(
      `[worker] job ${job.id} (${job.kind}) expired its lease on the last attempt, now DEAD`,
    );
  }
  return parked.map((j) => j.id);
}

// =============================================================================
// Reaper — orphaned uploading worlds (client died before frames:done).
// =============================================================================

/** How long a world may sit in `uploading` before the reaper fails it. */
export const REAPER_STALE_UPLOAD_MS = 24 * 60 * 60 * 1000;

/**
 * Pure mirror of the reapStaleUploads WHERE clause (same pattern as
 * queue.isJobClaimable): a world is reapable when it is still `uploading` and
 * was created more than `maxAgeMs` ago. The SQL MUST stay in sync with this.
 */
export function isWorldReapable(
  world: Pick<World, 'status' | 'createdAt'>,
  now: Date = new Date(),
  maxAgeMs: number = REAPER_STALE_UPLOAD_MS,
): boolean {
  return world.status === 'uploading' && world.createdAt.getTime() < now.getTime() - maxAgeMs;
}

/**
 * Sweep worlds stuck in `uploading` for >24 h → status 'failed' (stage upload, UPLOAD_STALE) and a
 * frames-only purge of the capture prefix. The row is kept and NOT
 * soft-deleted (it stays visible as failed in the Library); the client-side
 * abandon flow deletes its world eagerly — this is the server backstop.
 * Returns the reaped world ids (logged individually).
 */
export async function reapStaleUploads(db: Db): Promise<string[]> {
  // One transaction (spec §10 R27): a crash between the flip and the enqueues
  // would leave stale-failed worlds whose frames are never purged (§13) — the
  // flip takes them out of this sweep for good.
  return db.transaction(async (tx) => {
    const rows = await tx
      .update(worlds)
      .set({
        status: 'failed',
        failureStage: 'upload',
        failureCode: 'UPLOAD_STALE',
        progress: null,
        updatedAt: sql`now()`,
      })
      .where(
        and(
          eq(worlds.status, 'uploading'),
          lt(worlds.createdAt, sql`now() - interval '24 hours'`),
        ),
      )
      .returning({ id: worlds.id });

    for (const row of rows) {
      console.log(`[worker] reaped stale uploading world ${row.id} → failed (UPLOAD_STALE)`);
      await enqueue(tx, 'purge', row.id, { framesOnly: true });
    }
    return rows.map((r) => r.id);
  });
}

// =============================================================================
// Loop + entrypoint.
// =============================================================================

export function makeWorkerId(): string {
  return `${os.hostname()}:${process.pid}`;
}

export interface WorkerHandle {
  stop(): void;
  done: Promise<void>;
}

/**
 * Start the claim loop. Non-blocking: returns a handle with `stop()` and a
 * `done` promise. Claim errors (e.g. an unreachable dummy DB) are logged and
 * the loop backs off and stays alive (task requirement 10).
 */
export function startWorker(rawDeps: WorkerDeps): WorkerHandle {
  const workerId = rawDeps.workerId ?? makeWorkerId();
  // Every handler heartbeats with this identity, so the lease check can prove
  // ownership (§10 R6).
  const deps: WorkerDeps = { ...rawDeps, workerId };
  const pollMs = deps.config.WORKER_POLL_MS;
  const clock = deps.clock ?? realClock;
  const sleep = clock.sleep;
  let running = true;
  // Reaper cadence: sweep stale uploading worlds every REAPER_INTERVAL_MS
  // (first sweep runs immediately on start).
  let lastReapAt = -Infinity;

  const done = (async () => {
    console.log(`[worker] ${workerId} started; kinds=${WORKER_KINDS.join(',')} poll=${pollMs}ms`);
    while (running) {
      if (clock.now() - lastReapAt >= deps.config.REAPER_INTERVAL_MS) {
        lastReapAt = clock.now();
        try {
          await reapStaleUploads(deps.db);
          await reapExhaustedJobs(deps.db);
        } catch (err) {
          console.error(`[worker] reaper error (staying alive): ${String(err)}`);
        }
      }
      let job: Job | null = null;
      try {
        job = await claimNextJob(deps.db, WORKER_KINDS, workerId);
      } catch (err) {
        console.error(`[worker] claim error (staying alive): ${String(err)}`);
        await sleep(pollMs);
        continue;
      }
      if (!job) {
        await sleep(pollMs);
        continue;
      }
      try {
        await processJob(deps, job);
      } catch (err) {
        await handleJobError(deps.db, job, err).catch((e) =>
          console.error(`[worker] error-handler failed: ${String(e)}`),
        );
      }
    }
    console.log(`[worker] ${workerId} stopped`);
  })();

  return { stop: () => (running = false), done };
}

async function main(): Promise<void> {
  const config = getConfig();
  const deps: WorkerDeps = {
    db: getDb(),
    storage: createStorage(config),
    config,
    push: sendPush,
  };
  const handle = startWorker(deps);

  // Graceful drain (spec §10 R10): stop CLAIMING, let the in-flight job finish.
  //
  // Losing a job mid-flight is safe: the lease expires and another worker
  // re-claims and resumes it (§10 R6). Purge is idempotent.
  let stopping = false;
  const shutdown = (sig: string) => {
    if (stopping) return;
    stopping = true;
    console.log(
      `[worker] received ${sig}: no longer claiming jobs, ` +
        `finishing the in-flight one (grace ${config.SHUTDOWN_GRACE_MS}ms)`,
    );
    handle.stop();

    const hard = setTimeout(() => {
      console.warn(
        `[worker] grace deadline hit with a job still running; exiting. ` +
          'Its lease will expire and another worker will resume it (§10 R6).',
      );
      process.exit(0);
    }, config.SHUTDOWN_GRACE_MS);
    hard.unref();

    void handle.done
      .then(() => closeDb())
      .catch((err: unknown) => console.error(`[worker] drain error: ${String(err)}`))
      .finally(() => {
        clearTimeout(hard);
        process.exit(0);
      });
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  await handle.done;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  // Spec §10 R28: log and exit non-zero so Railway restarts a clean process.
  // A job caught mid-flight is safe: its lease expires and it resumes (§10 R6).
  process.on('unhandledRejection', (reason) => {
    console.error('[worker] unhandledRejection, exiting:', reason);
    process.exit(1);
  });
  process.on('uncaughtException', (err) => {
    console.error('[worker] uncaughtException, exiting:', err);
    process.exit(1);
  });
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
