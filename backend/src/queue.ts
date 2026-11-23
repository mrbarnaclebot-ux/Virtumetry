import { sql } from 'drizzle-orm';
import type { Db } from './db/client.js';
import { jobs, type Job, type JobKind, type JobPhase } from './db/schema.js';

// Postgres-backed job queue (spec §7 / §14). No worker loop yet — Stage 2.
// Uses FOR UPDATE SKIP LOCKED so multiple workers can claim jobs concurrently
// without contention.

export const MAX_ATTEMPTS = 5;
const BASE_BACKOFF_SECONDS = 30;
const MAX_BACKOFF_SECONDS = 60 * 60; // 1 hour cap.

/**
 * Lease duration for a claimed job. A worker that crashes mid-job leaves
 * locked_at set forever; without expiry the job is stuck permanently (QA
 * defect). claimNextJob therefore treats a lease older than LEASE_SECONDS as
 * expired and re-claimable — a crashed job is safely resumed by another worker
 * (idempotent + provider_operation_id resume means no double-bill, spec §14).
 */
export const LEASE_SECONDS = 600; // 10 minutes.

/**
 * Pure mirror of the claimNextJob WHERE clause — a job is claimable when it is
 * queued/running, has attempts left, its backoff gate (run_after) has passed,
 * and it is either unlocked OR its lease has expired. The SQL in claimNextJob
 * MUST stay in sync with this predicate (it is the testable spec of the claim
 * condition).
 *
 * The attempts cap (spec §10 R27): failJob parks a job dead at MAX_ATTEMPTS, but
 * a job whose run KILLS the process never reaches failJob — its lease just
 * expires and it used to be re-claimed forever. parkExhaustedJobs parks those.
 */
export function isJobClaimable(
  job: Pick<Job, 'phase' | 'lockedAt' | 'runAfter' | 'attempts'>,
  now: Date = new Date(),
  leaseSeconds: number = LEASE_SECONDS,
): boolean {
  if (job.phase !== 'queued' && job.phase !== 'running') return false;
  if (job.attempts >= MAX_ATTEMPTS) return false;
  if (job.runAfter.getTime() > now.getTime()) return false;
  if (job.lockedAt === null) return true;
  return job.lockedAt.getTime() < now.getTime() - leaseSeconds * 1000;
}

/**
 * Exponential backoff in seconds for a given attempt count:
 * min(2^attempts * 30s, 1h). Pure — exported for testing.
 */
export function backoffSeconds(attempts: number): number {
  const raw = 2 ** attempts * BASE_BACKOFF_SECONDS;
  return Math.min(raw, MAX_BACKOFF_SECONDS);
}

/** Insert a job row. Returns the created job id. Takes only `insert` so a
 * caller can enqueue inside its own transaction (frames:done). */
export async function enqueue(
  db: Pick<Db, 'insert'>,
  kind: JobKind,
  worldId: string,
  payload?: unknown,
): Promise<string> {
  const [row] = await db
    .insert(jobs)
    .values({
      kind,
      worldId,
      payload: payload === undefined ? null : (payload as object),
    })
    .returning({ id: jobs.id });
  return row!.id;
}

/**
 * Raw `db.execute` rows come back with snake_case column names (drizzle only
 * remaps to camelCase for query-builder calls). Casting them straight to Job
 * left worldId/providerOperationId undefined at runtime — which would have
 * silently defeated the §14 resume check. Map explicitly instead.
 */
/**
 * Coerce a driver timestamp value to Date. Through drizzle's raw db.execute
 * path timestamptz columns can arrive as strings (observed against real Neon),
 * while node-postgres usually parses them to Date — the Job type promises
 * Date, so the mapper must make that true on every driver path.
 */
function toDate(v: unknown): Date | null {
  if (v == null) return null;
  return v instanceof Date ? v : new Date(v as string);
}

export function mapJobRow(raw: Record<string, unknown>): Job {
  return {
    id: raw['id'] as string,
    worldId: raw['world_id'] as string,
    kind: raw['kind'] as string,
    phase: raw['phase'] as string,
    attempts: raw['attempts'] as number,
    lastError: (raw['last_error'] as string | null) ?? null,
    payload: raw['payload'] ?? null,
    providerOperationId: (raw['provider_operation_id'] as string | null) ?? null,
    // NOT NULL columns in the schema — coerced, never null in practice.
    runAfter: toDate(raw['run_after'])!,
    lockedAt: toDate(raw['locked_at']),
    lockedBy: (raw['locked_by'] as string | null) ?? null,
    createdAt: toDate(raw['created_at'])!,
    updatedAt: toDate(raw['updated_at'])!,
  };
}

/**
 * Atomically claim the next runnable job of one of `kinds`. Uses
 * `UPDATE ... WHERE id = (SELECT ... FOR UPDATE SKIP LOCKED) RETURNING`,
 * increments attempts, and takes a lease (locked_at/locked_by). Returns the
 * claimed job or null when the queue is empty.
 */
export async function claimNextJob(
  db: Db,
  kinds: JobKind[],
  workerId: string,
): Promise<Job | null> {
  if (kinds.length === 0) return null;
  // NOTE: do NOT write `kind = ANY(${kinds})` — Drizzle expands a JS array in a
  // sql template into a parenthesized tuple `($1, $2, ...)`, so Postgres gets
  // `ANY(($1,$2,...))`, which is invalid (ANY needs an array expression, not a
  // row). Build a parameter-bound IN list instead — every kind is still a bound
  // parameter, never string-interpolated.
  const kindsIn = sql.join(
    kinds.map((k) => sql`${k}`),
    sql`, `,
  );
  const result = await db.execute<Record<string, unknown>>(sql`
    UPDATE jobs
    SET locked_at = now(),
        locked_by = ${workerId},
        attempts = attempts + 1,
        phase = 'running',
        updated_at = now()
    WHERE id = (
      SELECT id FROM jobs
      WHERE kind IN (${kindsIn})
        AND phase IN ('queued', 'running')
        -- Lease expiry (mirrors isJobClaimable): claimable when unlocked OR the
        -- lease is older than LEASE_SECONDS, so a crashed worker's job resumes.
        AND (locked_at IS NULL OR locked_at < now() - (${LEASE_SECONDS} * interval '1 second'))
        AND attempts < ${MAX_ATTEMPTS}
        AND run_after <= now()
      ORDER BY run_after ASC
      FOR UPDATE SKIP LOCKED
      LIMIT 1
    )
    RETURNING *
  `);
  const rows = (result as unknown as { rows: Record<string, unknown>[] }).rows;
  return rows[0] ? mapJobRow(rows[0]) : null;
}

/**
 * Park every job that claimNextJob will never pick up again because it already
 * used all MAX_ATTEMPTS (spec §10 R27): still queued/running, not leased (or the
 * lease expired), attempts at the cap. In practice that is a job whose run killed
 * the process (OOM, segfault) on its last attempt, so failJob never ran. Returns
 * the parked jobs so the worker can fail their worlds through the same path as
 * any other dead job — without that the world would sit in its in-progress
 * status forever (R22).
 */
export async function parkExhaustedJobs(db: Db, kinds: JobKind[]): Promise<Job[]> {
  if (kinds.length === 0) return [];
  const kindsIn = sql.join(
    kinds.map((k) => sql`${k}`),
    sql`, `,
  );
  const result = await db.execute<Record<string, unknown>>(sql`
    UPDATE jobs
    SET phase = 'dead',
        last_error = 'lease expired on the last attempt (' || attempts || ')'
                     || COALESCE('; previous error: ' || last_error, ''),
        locked_at = NULL,
        locked_by = NULL,
        updated_at = now()
    WHERE kind IN (${kindsIn})
      AND phase IN ('queued', 'running')
      AND attempts >= ${MAX_ATTEMPTS}
      AND (locked_at IS NULL OR locked_at < now() - (${LEASE_SECONDS} * interval '1 second'))
    RETURNING *
  `);
  const rows = (result as unknown as { rows: Record<string, unknown>[] }).rows;
  return rows.map(mapJobRow);
}

/** Mark a job done and release its lease. */
export async function completeJob(db: Db, jobId: string): Promise<void> {
  await db.execute(sql`
    UPDATE jobs
    SET phase = 'done', locked_at = NULL, locked_by = NULL, updated_at = now()
    WHERE id = ${jobId}
  `);
}

/**
 * Fail a job: record the error, release the lease, and schedule a retry with
 * exponential backoff. Once attempts reach MAX_ATTEMPTS the job is parked as
 * 'dead' (DLQ-equivalent, spec §14). Returns the resulting phase (null if the
 * row is gone) so the caller can fail the world when retries are exhausted.
 */
export async function failJob(
  db: Db,
  jobId: string,
  error: string,
): Promise<JobPhase | null> {
  const result = await db.execute<{ phase: JobPhase }>(sql`
    UPDATE jobs
    SET last_error = ${error},
        locked_at = NULL,
        locked_by = NULL,
        phase = CASE WHEN attempts >= ${MAX_ATTEMPTS} THEN 'dead' ELSE 'queued' END,
        run_after = now() + (LEAST(POWER(2, attempts) * ${BASE_BACKOFF_SECONDS}, ${MAX_BACKOFF_SECONDS}) * interval '1 second'),
        updated_at = now()
    WHERE id = ${jobId}
    RETURNING phase
  `);
  const rows = (result as unknown as { rows: { phase: JobPhase }[] }).rows;
  return rows[0]?.phase ?? null;
}

/**
 * Park a job as 'dead' immediately, bypassing retry/backoff. Used for
 * non-retryable failures (budget exceeded, un-implemented paths) where retrying
 * cannot succeed and would only waste attempts or, worse, re-touch the
 * money-path (spec §14).
 */
export async function parkJobDead(
  db: Db,
  jobId: string,
  error: string,
): Promise<void> {
  await db.execute(sql`
    UPDATE jobs
    SET last_error = ${error},
        locked_at = NULL,
        locked_by = NULL,
        phase = 'dead',
        updated_at = now()
    WHERE id = ${jobId}
  `);
}

/**
 * Refresh a claimed job's lease (spec §10 R6). LEASE_SECONDS (600) is shorter
 * than a generation's in-process ceiling (900 s) and nothing used to touch
 * `locked_at` while a job ran, so a second worker could re-claim a job that was
 * very much alive — two workers finalizing the same world, two pushes, and (for
 * a generate job without a persisted operation id) a second billable call.
 *
 * The UPDATE is conditional: it only bumps `locked_at` while the job is still
 * `running` AND still leased to `workerId` (when given). Returning `false` means
 * this worker NO LONGER OWNS the job — the caller must abort without finalizing
 * and must not touch the job row (the new owner's lease would be clobbered).
 */
export async function heartbeatJob(
  db: Db,
  jobId: string,
  workerId?: string,
): Promise<boolean> {
  const ownerClause = workerId ? sql` AND locked_by = ${workerId}` : sql``;
  const result = await db.execute<{ id: string }>(sql`
    UPDATE jobs
    SET locked_at = now(), updated_at = now()
    WHERE id = ${jobId}
      AND phase = 'running'
      AND locked_at IS NOT NULL${ownerClause}
    RETURNING id
  `);
  const rows = (result as unknown as { rows: { id: string }[] }).rows;
  return rows.length > 0;
}

/**
 * Clear a `pending:<jobId>` intent marker (spec §10 R1) after a failure that
 * happened strictly BEFORE `worlds:generate` — i.e. where no generation can
 * possibly have been submitted, so the next attempt should start cleanly instead
 * of reconciling and parking.
 *
 * Conditional on the stored value still being `expected`: if a concurrent worker
 * has since written a real operation id (or its own marker), this must not wipe
 * it. Returns whether the marker was actually cleared.
 */
export async function clearProviderOperationId(
  db: Db,
  jobId: string,
  expected: string,
): Promise<boolean> {
  const result = await db.execute<{ id: string }>(sql`
    UPDATE jobs
    SET provider_operation_id = NULL, updated_at = now()
    WHERE id = ${jobId}
      AND provider_operation_id = ${expected}
    RETURNING id
  `);
  const rows = (result as unknown as { rows: { id: string }[] }).rows;
  return rows.length > 0;
}

/**
 * Persist the provider operation id atomically (spec §14) so a resumed worker
 * never blind-resubmits a credit-spending worlds:generate call.
 */
export async function setProviderOperationId(
  db: Db,
  jobId: string,
  operationId: string,
): Promise<void> {
  await db.execute(sql`
    UPDATE jobs
    SET provider_operation_id = ${operationId}, updated_at = now()
    WHERE id = ${jobId}
  `);
}
