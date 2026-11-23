import { sql } from 'drizzle-orm';
import type { Db } from './db/client.js';

// Daily scan quota (spec §7 / task requirement 6). The pure logic below is the
// readable specification of the window (and backs GET /v1/me/quota); the
// money-adjacent *charge* is a single conditional UPDATE (chargeScanQuota) so
// concurrent creates cannot both slip past the limit (spec §10 R9).

const DAY_MS = 24 * 60 * 60 * 1000;

export interface QuotaState {
  dailyScanCount: number;
  quotaResetAt: Date | null;
}

export interface QuotaDecision {
  allowed: boolean;
  /** New counter value to persist (only meaningful when allowed). */
  newCount: number;
  /** New reset timestamp to persist. */
  newResetAt: Date;
  /** When denied, when the window frees up. */
  retryAt?: Date;
}

/** Read-only view of a user's remaining quota (GET /v1/me/quota contract). */
export interface QuotaStatus {
  scansRemaining: number;
  /** When the current window frees up; null when no window is active. */
  quotaResetsAt: Date | null;
  dailyQuota: number;
}

/**
 * True when the reset window is absent or has already elapsed — i.e. the next
 * scan starts a fresh 24h window. Shared by evaluateQuota and quotaStatus so
 * both agree on exactly when a window is "spent".
 */
function windowExpired(resetAt: Date | null, now: Date): boolean {
  return resetAt === null || resetAt.getTime() <= now.getTime();
}

/**
 * Decide whether a scan is allowed and compute the counter to persist.
 * The window resets 24h after it first opened; a passed/absent reset time
 * starts a fresh window at count 1.
 */
export function evaluateQuota(
  state: QuotaState,
  max: number,
  now: Date = new Date(),
): QuotaDecision {
  const resetAt = state.quotaResetAt;
  if (windowExpired(resetAt, now)) {
    // Window absent or expired → start a fresh 24h window at count 1.
    return { allowed: true, newCount: 1, newResetAt: new Date(now.getTime() + DAY_MS) };
  }
  // windowExpired === false guarantees a live window (resetAt is non-null).
  const activeResetAt = resetAt as Date;

  if (state.dailyScanCount >= max) {
    return {
      allowed: false,
      newCount: state.dailyScanCount,
      newResetAt: activeResetAt,
      retryAt: activeResetAt,
    };
  }

  return { allowed: true, newCount: state.dailyScanCount + 1, newResetAt: activeResetAt };
}

/** Outcome of an atomic quota charge. */
export interface QuotaChargeResult {
  /** False when no such user row exists (the caller answers 401). */
  userFound: boolean;
  /** True when this request consumed a scan. */
  allowed: boolean;
  /** The persisted counter after the charge (null when denied). */
  newCount: number | null;
  /** The active window's reset time — `retry_at` for a denied request. */
  resetAt: Date | null;
}

/**
 * Atomically check-and-increment the daily scan quota (spec §10 R9).
 *
 * The previous SELECT-then-UPDATE let two concurrent creates both read
 * `count = max - 1` and both write `max`, handing out one scan too many at the
 * limit — the exact boundary where the quota is protecting real generation
 * spend. This is one statement: the UPDATE's own WHERE clause is the limit test,
 * so Postgres serializes the two writers on the row lock and the loser matches
 * no row.
 *
 * Rolling-window semantics are preserved verbatim from evaluateQuota: an absent
 * or elapsed `quota_reset_at` opens a fresh 24 h window at count 1; otherwise the
 * window's reset time stands and the counter increments.
 *
 * The outer SELECT is joined so one round trip answers all three cases — user
 * missing, charged, or refused (with the window's reset for `retry_at`).
 */
export async function chargeScanQuota(
  db: Pick<Db, 'execute'>, // a transaction handle works too (worlds:retry)
  userId: string,
  max: number,
): Promise<QuotaChargeResult> {
  const windowExpiredSql = sql`(quota_reset_at IS NULL OR quota_reset_at <= now())`;
  const result = await db.execute<{
    user_id: string;
    new_count: number | string | null;
    reset_at: Date | string | null;
  }>(sql`
    WITH charged AS (
      UPDATE users
      SET daily_scan_count = CASE WHEN ${windowExpiredSql} THEN 1 ELSE daily_scan_count + 1 END,
          quota_reset_at = CASE WHEN ${windowExpiredSql}
                                THEN now() + interval '24 hours'
                                ELSE quota_reset_at END
      WHERE id = ${userId}
        AND (${windowExpiredSql} OR daily_scan_count < ${max})
      RETURNING id, daily_scan_count, quota_reset_at
    )
    SELECT u.id AS user_id,
           c.daily_scan_count AS new_count,
           COALESCE(c.quota_reset_at, u.quota_reset_at) AS reset_at
    FROM users u
    LEFT JOIN charged c ON c.id = u.id
    WHERE u.id = ${userId}
  `);
  const rows = (result as unknown as { rows: Record<string, unknown>[] }).rows;
  const row = rows[0];
  if (!row) return { userFound: false, allowed: false, newCount: null, resetAt: null };

  const rawCount = row['new_count'];
  const rawReset = row['reset_at'];
  const resetAt =
    rawReset == null ? null : rawReset instanceof Date ? rawReset : new Date(String(rawReset));
  if (rawCount == null) {
    return { userFound: true, allowed: false, newCount: null, resetAt };
  }
  return { userFound: true, allowed: true, newCount: Number(rawCount), resetAt };
}

/**
 * Give back one charged scan (spec §10 R4). Used when a create is charged and
 * then loses the `Idempotency-Key` insert race: the winner's world is returned,
 * so the loser's charge bought nothing and must not count against the user.
 *
 * Only ever decrements inside a LIVE window (a new window would have reset the
 * counter anyway) and never below zero, so a duplicated refund cannot mint
 * quota out of thin air.
 */
export async function releaseScanQuota(db: Db, userId: string): Promise<void> {
  await db.execute(sql`
    UPDATE users
    SET daily_scan_count = GREATEST(daily_scan_count - 1, 0)
    WHERE id = ${userId}
      AND quota_reset_at IS NOT NULL
      AND quota_reset_at > now()
  `);
}

/**
 * Read-only quota snapshot for GET /v1/me/quota — the same window logic as
 * evaluateQuota, without persisting anything. If the reset window has passed (or
 * never opened) the user is back to a full allowance and there is no active
 * reset time; otherwise remaining = max − count and the window's reset stands.
 */
export function quotaStatus(
  state: QuotaState,
  max: number,
  now: Date = new Date(),
): QuotaStatus {
  const resetAt = state.quotaResetAt;
  if (windowExpired(resetAt, now)) {
    return { scansRemaining: max, quotaResetsAt: null, dailyQuota: max };
  }
  return {
    scansRemaining: Math.max(0, max - state.dailyScanCount),
    quotaResetsAt: resetAt as Date,
    dailyQuota: max,
  };
}
