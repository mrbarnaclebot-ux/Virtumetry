import { describe, it, expect, vi } from 'vitest';
import {
  wouldExceedBudget,
  releaseCredits,
  reserveCredits,
  BudgetExceededError,
} from '../src/budget.js';
import { creditEvents } from '../src/db/schema.js';
import type { Db } from '../src/db/client.js';

/** Flatten a drizzle SQL object back to its literal text for assertions. */
function sqlText(node: unknown): string {
  const chunks = (node as { queryChunks?: unknown[] })?.queryChunks ?? [];
  return chunks
    .map((c) => {
      const v = (c as { value?: unknown }).value;
      if (typeof v === 'string') return v;
      if (Array.isArray(v)) return v.join('');
      return '';
    })
    .join('');
}

// Budget boundary math (spec §14). Reserving is allowed only while the running
// total stays AT OR UNDER the cap.
describe('wouldExceedBudget', () => {
  it('allows a reservation that lands exactly on the budget', () => {
    // 350 already spent + 150 draft = 500 == budget → allowed.
    expect(wouldExceedBudget(350, 150, 500)).toBe(false);
  });

  it('rejects a reservation that overshoots by one', () => {
    expect(wouldExceedBudget(351, 150, 500)).toBe(true);
  });

  it('rejects when already at the cap and any amount is requested', () => {
    expect(wouldExceedBudget(500, 1, 500)).toBe(true);
  });

  it('allows the first spend of the day', () => {
    expect(wouldExceedBudget(0, 1500, 1500)).toBe(false);
    expect(wouldExceedBudget(0, 1501, 1500)).toBe(true);
  });
});

// The daily window must be a UTC calendar day (spec §10 R10 low item), not
// whatever TimeZone the connection inherited.
describe('reserveCredits day window', () => {
  /** Run reserveCredits against a fake tx and return every SQL it executed. */
  async function capturedSql(): Promise<string[]> {
    const executed: string[] = [];
    const tx = {
      execute: vi.fn(async (node: unknown) => {
        executed.push(sqlText(node));
        return { rows: [{ total: 0 }] };
      }),
      insert: () => ({ values: async () => undefined }),
    };
    const db = {
      transaction: async (fn: (t: unknown) => Promise<void>) => fn(tx),
    } as unknown as Db;
    await reserveCredits(db, 150, 500);
    return executed;
  }

  it('truncates the day in UTC and compares in UTC', async () => {
    const [, sumQuery] = await capturedSql();
    expect(sumQuery).toContain("date_trunc('day', now() AT TIME ZONE 'UTC')");
    // Both conversions are required: the inner one makes date_trunc cut on the
    // UTC day, the outer one turns that naive midnight back into a timestamptz.
    // Without the outer one Postgres re-reads midnight in the session zone.
    expect(sumQuery).toContain(
      "(date_trunc('day', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC')",
    );
  });

  it('never truncates a bare now() (the session-local bug)', async () => {
    const [, sumQuery] = await capturedSql();
    expect(sumQuery).not.toMatch(/date_trunc\('day',\s*now\(\)\s*\)/);
  });

  it('still serializes reservations behind the advisory lock', async () => {
    const [lock] = await capturedSql();
    expect(lock).toContain('pg_advisory_xact_lock');
  });
});

// Releasing a reservation that provably bought nothing (spec §10 R1). The ledger
// is append-only and the daily guard is a SUM, so a release is a COMPENSATING
// negative entry — never a delete or an update.
describe('releaseCredits', () => {
  function fakeDb() {
    const inserts: { table: unknown; values: Record<string, unknown> }[] = [];
    const db = {
      insert: (table: unknown) => ({
        values: vi.fn(async (values: Record<string, unknown>) => {
          inserts.push({ table, values });
        }),
      }),
    } as unknown as Db;
    return { db, inserts };
  }

  it('appends a negative event for the same world', async () => {
    const { db, inserts } = fakeDb();
    await releaseCredits(db, 150, 'w-1');

    expect(inserts).toHaveLength(1);
    expect(inserts[0]!.table).toBe(creditEvents);
    expect(inserts[0]!.values).toEqual({ amount: -150, worldId: 'w-1' });
  });

  it('nets the day back to zero against its reservation', async () => {
    const { db, inserts } = fakeDb();
    await releaseCredits(db, 1500);
    expect(1500 + (inserts[0]!.values['amount'] as number)).toBe(0);
    expect(inserts[0]!.values['worldId']).toBeNull();
  });

  it('is a no-op for a zero-cost (mock mode) reservation', async () => {
    const { db, inserts } = fakeDb();
    await releaseCredits(db, 0, 'w-1');
    expect(inserts).toHaveLength(0);
  });
});

describe('BudgetExceededError', () => {
  it('carries the requested / spent / budget context', () => {
    const err = new BudgetExceededError(150, 400, 500);
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe('BudgetExceededError');
    expect(err.requested).toBe(150);
    expect(err.spentToday).toBe(400);
    expect(err.budget).toBe(500);
  });
});
