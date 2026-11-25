import { randomUUID } from 'node:crypto';
import { and, eq, inArray, isNull, sql, type SQL } from 'drizzle-orm';
import type { Db } from './db/client.js';
import { jobs, worldAttempts, worlds, type World } from './db/schema.js';
import { enqueue } from './queue.js';

// Submit-stage codes D-08 marks retryable: the provider refused before billing.
const SUBMIT_RETRYABLE = new Set([
  'RATE_LIMITED',
  'PROVIDER_UNAVAILABLE',
  'BUDGET_EXCEEDED',
  'QUOTE_ABOVE_APPROVAL',
  'HTTP_402',
  'INSUFFICIENT_CREDITS',
]);

// Echo-3 validation families (D-08 + A-01): the capture itself is bad, so a
// retry would fail the same way.
const VALIDATION =
  /^(VALIDATION_FAILED|INVALID_INPUT|TOO_MANY_FRAMES|IMAGES?_|ZIP_|EXIF_|TRAJECTORY_|MATRIX_|ROTATION_|ORIENTATION_|SCANS_|CAMERA_FILE_|CAMERAS?_|CAPTURE_|PER_FRAME_INTRINSICS_|INTRINSICS_)|INTRINSICS/;

/**
 * Server-side source of truth for the Retry button (D-08). Unknown → false.
 * Processing failures cost 0 credits on Echo-3, so a non-validation provider
 * code is retryable (A-01); the ledger guard lives in the retry route (A-02).
 */
export function isRetryable(
  w: Pick<World, 'status' | 'deletedAt' | 'failureStage' | 'failureCode' | 'failureMessage'>,
): boolean {
  if (w.status !== 'failed' || w.deletedAt) return false;
  const code = w.failureCode ?? '';
  if (w.failureStage === 'submit') return SUBMIT_RETRYABLE.has(code);
  if (w.failureStage !== 'processing') return false;
  if (!code || code === 'FAILED') return false;
  const tokens = [code, ...(w.failureMessage ?? '').split(/[,\s]+/)].filter(Boolean);
  return !tokens.some((t) => VALIDATION.test(t));
}

/** WR-01 held reservation (same query as worker.ts): a reserve row for `key` with no release. */
export const heldReserveSql = (key: SQL | string) => sql`
  SELECT 1 FROM credit_events r WHERE r.submission_key = ${key} AND r.kind = 'reserve'
    AND NOT EXISTS (SELECT 1 FROM credit_events x WHERE x.submission_key = r.submission_key AND x.kind = 'release')`;

/**
 * A-02 ledger guard: true when `submissionKey` holds no unreleased reserve, so
 * the old request cannot still be billed. Null key (never reserved) → true.
 */
export async function ledgerClear(db: Pick<Db, 'execute'>, submissionKey: string | null): Promise<boolean> {
  if (!submissionKey) return true;
  const res = await db.execute(heldReserveSql(submissionKey));
  return (res as unknown as { rows: unknown[] }).rows.length === 0;
}

class RetryLost extends Error {}

/**
 * The only place a second submission key is minted (D-09). Does not touch
 * credit_events or the scan quota (A-04). One transaction: archive the current
 * attempt, conditionally reset the world (status='failed' AND submit_attempt =
 * N AND failure_* / key unchanged AND no held reserve, so concurrent retries
 * race to one winner), enqueue submit or pack. Null
 * when the world moved on; unique violations propagate to the caller.
 */
export async function applyRetry(
  db: Db,
  w: World,
  a: { approvedMaxCredits: number; clientRequestId: string; bundlePresent: boolean; captureId: string },
): Promise<World | null> {
  try {
    return await db.transaction(async (tx) => {
      await tx.insert(worldAttempts).values({
        worldId: w.id,
        attempt: w.submitAttempt,
        submissionKey: w.submissionKey,
        providerRequestId: w.providerRequestId,
        failureStage: w.failureStage,
        failureCode: w.failureCode,
        quotedCredits: w.quotedCredits,
        clientRequestId: a.clientRequestId,
      });
      const [row] = await tx
        .update(worlds)
        .set({
          submissionKey: randomUUID(),
          submitBody: null,
          providerRequestId: null,
          quotedCredits: null,
          failureStage: null,
          failureCode: null,
          failureMessage: null,
          progress: null,
          approvedMaxCredits: a.approvedMaxCredits,
          submitAttempt: w.submitAttempt + 1,
          status: a.bundlePresent ? 'submitting' : 'packing',
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(worlds.id, w.id),
            eq(worlds.status, 'failed'),
            isNull(worlds.deletedAt),
            eq(worlds.submitAttempt, w.submitAttempt),
            // WR-06 (D-09): the facts the route judged retryable are unchanged,
            // and the A-02 ledger guard holds inside this tx, not just before it.
            sql`${worlds.failureStage} IS NOT DISTINCT FROM ${w.failureStage}`,
            sql`${worlds.failureCode} IS NOT DISTINCT FROM ${w.failureCode}`,
            sql`${worlds.failureMessage} IS NOT DISTINCT FROM ${w.failureMessage}`,
            sql`${worlds.submissionKey} IS NOT DISTINCT FROM ${w.submissionKey}`,
            sql`NOT EXISTS (${heldReserveSql(sql`worlds.submission_key`)})`,
          ),
        )
        .returning();
      if (!row) throw new RetryLost();
      // CR-01: retire every live pipeline job of the old attempt (e.g. a submit
      // job left running by a crash) so only the job enqueued here can send the
      // new key. Their own completeJob later is a harmless no-op.
      await tx
        .update(jobs)
        .set({ phase: 'done', lockedAt: null, lockedBy: null, updatedAt: new Date() })
        .where(and(eq(jobs.worldId, w.id), inArray(jobs.kind, ['pack', 'submit', 'track']), inArray(jobs.phase, ['queued', 'running'])));
      await enqueue(
        tx,
        a.bundlePresent ? 'submit' : 'pack',
        w.id,
        a.bundlePresent ? { submitAttempt: row.submitAttempt } : { captureId: a.captureId },
      );
      return row;
    });
  } catch (err) {
    if (err instanceof RetryLost) return null;
    throw err;
  }
}
