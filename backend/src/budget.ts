import { sql } from 'drizzle-orm';
import type { Db } from './db/client.js';
import { creditEvents } from './db/schema.js';

// Daily + monthly credit budget guard (D-18, PROC-08). A provider submit spends
// real money; we cap credits per UTC day and per UTC month, per provider mode
// (mock spend never counts against the live budget). A single counter column
// can't do this atomically under concurrency, so we use an append-only
// `credit_events` ledger and reserve inside a transaction, one reservation per
// submission_key (unique (submission_key, kind)).

export type BudgetWindow = 'daily' | 'monthly';

/** Thrown when a reservation would exceed a budget window. NOT retryable. */
export class BudgetExceededError extends Error {
  readonly window: BudgetWindow;
  readonly requested: number;
  readonly spent: number;
  readonly budget: number;
  constructor(window: BudgetWindow, requested: number, spent: number, budget: number) {
    super(
      `${window} credit budget exceeded: requested ${requested}, ` +
        `already spent ${spent} of ${budget}`,
    );
    this.name = 'BudgetExceededError';
    this.window = window;
    this.requested = requested;
    this.spent = spent;
    this.budget = budget;
  }
}

/**
 * Pure boundary check — reserving `amount` on top of `spent` is allowed only
 * while the running total stays at or under `budget`. Exported for tests.
 */
export function wouldExceedBudget(spent: number, amount: number, budget: number): boolean {
  return spent + amount > budget;
}

// Stable advisory-lock key so concurrent reservations serialize (the sum +
// insert must be atomic; an aggregate can't be row-locked). Arbitrary constant.
const BUDGET_LOCK_KEY = 0x7645_7370; // "VtSp"

function rowsOf<T>(res: unknown): T[] {
  return (res as { rows: T[] }).rows;
}

/**
 * Credits spent by `mode` in the current UTC day and UTC month. Shared by
 * reserveCredits (inside its advisory-locked tx) and the read-only /v1/quote.
 */
export async function spentCredits(
  db: Pick<Db, 'execute'>,
  mode: 'mock' | 'live',
): Promise<{ day: number; month: number }> {
  // The windows are pinned to UTC. `date_trunc('day', now())` follows the
  // session's TimeZone, so the budget would reset at whatever local midnight
  // the connection happened to inherit — and two connections with different
  // TimeZone settings would disagree about which day a charge belongs to.
  //
  // `AT TIME ZONE 'UTC'` twice is deliberate, not redundant: the first
  // converts timestamptz -> naive UTC wall time so date_trunc cuts on the UTC
  // day/month, the second converts that naive midnight back to a timestamptz.
  // Drop the second and Postgres would re-interpret midnight in the SESSION
  // zone, reintroducing exactly the bug this fixes.
  const [s] = rowsOf<{ day: string | number; month: string | number }>(
    await db.execute(sql`
      SELECT
        COALESCE(SUM(amount) FILTER (
          WHERE created_at >= (date_trunc('day', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC')
        ), 0) AS day,
        COALESCE(SUM(amount), 0) AS month
      FROM credit_events
      WHERE provider_mode = ${mode}
        AND created_at >= (date_trunc('month', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC')
    `),
  );
  return { day: Number(s?.day ?? 0), month: Number(s?.month ?? 0) };
}

/**
 * Atomically reserve `amount` credits for one submission. Returns 'already'
 * when this submission_key already holds a reservation (a resumed submit is
 * never re-checked and never double-reserves), else checks the UTC day then the
 * UTC month for `mode` and inserts the reserve row, or throws
 * BudgetExceededError naming the window. A transaction-scoped advisory lock
 * keeps parallel workers from both slipping past a cap.
 */
export async function reserveCredits(
  db: Db,
  a: {
    key: string;
    amount: number;
    mode: 'mock' | 'live';
    worldId: string;
    daily: number;
    monthly: number;
  },
): Promise<'reserved' | 'already'> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(${BUDGET_LOCK_KEY})`);
    const prior = rowsOf(
      await tx.execute(
        sql`SELECT 1 FROM credit_events WHERE submission_key = ${a.key} AND kind = 'reserve'`,
      ),
    );
    if (prior.length > 0) return 'already';

    const { day, month } = await spentCredits(tx, a.mode);
    if (wouldExceedBudget(day, a.amount, a.daily)) {
      throw new BudgetExceededError('daily', a.amount, day, a.daily);
    }
    if (wouldExceedBudget(month, a.amount, a.monthly)) {
      throw new BudgetExceededError('monthly', a.amount, month, a.monthly);
    }

    await tx
      .insert(creditEvents)
      .values({
        amount: a.amount,
        worldId: a.worldId,
        submissionKey: a.key,
        kind: 'reserve',
        providerMode: a.mode,
      })
      .onConflictDoNothing();
    return 'reserved';
  });
}

/**
 * Give back the reservation of a submission that provably bought nothing.
 *
 * Call ONLY on known-not-charged outcomes: 400/402/403, provider FAILED or
 * CANCELLED (0 credits), and 429/503 once retries are exhausted ("not
 * submitted"). NEVER on 409, 5xx or timeout: the job may exist and be billed,
 * so releasing would under-count real spend (Pitfall 7).
 *
 * The ledger is append-only, so a release is a compensating `-amount` row. It
 * copies the reservation's created_at so it nets out of the window that was
 * charged, never a later day/month (Pitfall 6), and unique (submission_key,
 * kind) makes a second release a no-op. Unknown key → no row. No advisory lock:
 * this only ever lowers a total, so it cannot race a reserver past a cap.
 */
export async function releaseCredits(db: Pick<Db, 'execute'>, key: string): Promise<void> {
  await db.execute(sql`
    INSERT INTO credit_events (amount, world_id, submission_key, kind, provider_mode, created_at)
    SELECT -amount, world_id, submission_key, 'release', provider_mode, created_at
    FROM credit_events
    WHERE submission_key = ${key} AND kind = 'reserve'
    ON CONFLICT DO NOTHING
  `);
}
