import { describe, it, expect, vi } from 'vitest';
import {
  wouldExceedBudget,
  releaseCredits,
  reserveCredits,
  BudgetExceededError,
} from '../src/budget.js';
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

// Budget boundary math. Reserving is allowed only while the running total stays
// AT OR UNDER the cap.
describe('wouldExceedBudget', () => {
  it('allows a reservation that lands exactly on the budget', () => {
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

// The windows must be the UTC calendar day / month, not whatever TimeZone the
// connection inherited. Real-Postgres behaviour lives in budget.pg.test.ts.
describe('reserveCredits windows', () => {
  /** Run reserveCredits against a fake tx and return every SQL it executed. */
  async function capturedSql(): Promise<string[]> {
    const executed: string[] = [];
    const tx = {
      execute: vi.fn(async (node: unknown) => {
        const text = sqlText(node);
        executed.push(text);
        return { rows: text.includes('SUM(') ? [{ day: 0, month: 0 }] : [] };
      }),
      insert: () => ({ values: () => ({ onConflictDoNothing: async () => undefined }) }),
    };
    const db = {
      transaction: async (fn: (t: unknown) => Promise<unknown>) => fn(tx),
    } as unknown as Db;
    const r = await reserveCredits(db, {
      key: 'k',
      amount: 150,
      mode: 'mock',
      worldId: 'w',
      daily: 500,
      monthly: 5000,
    });
    expect(r).toBe('reserved');
    return executed;
  }

  it('truncates day and month in UTC and compares in UTC', async () => {
    const sumQuery = (await capturedSql()).find((s) => s.includes('SUM('))!;
    expect(sumQuery).toContain("(date_trunc('day', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC')");
    expect(sumQuery).toContain("(date_trunc('month', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC')");
    expect(sumQuery).not.toMatch(/date_trunc\('(day|month)',\s*now\(\)\s*\)/);
    expect(sumQuery).toContain('provider_mode');
  });

  it('serializes reservations behind the advisory lock', async () => {
    const [lock] = await capturedSql();
    expect(lock).toContain('pg_advisory_xact_lock');
  });
});

describe('releaseCredits', () => {
  it('copies the reservation, dated at its created_at, idempotently', async () => {
    const executed: string[] = [];
    const db = {
      execute: async (node: unknown) => {
        executed.push(sqlText(node));
        return { rows: [] };
      },
    } as unknown as Db;
    await releaseCredits(db, 'k');
    expect(executed).toHaveLength(1);
    expect(executed[0]).toContain("'release'");
    expect(executed[0]).toContain('created_at');
    expect(executed[0]).toContain('ON CONFLICT DO NOTHING');
  });
});

describe('BudgetExceededError', () => {
  it('names the window and carries requested / spent / budget', () => {
    const err = new BudgetExceededError('monthly', 150, 400, 500);
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe('BudgetExceededError');
    expect(err.window).toBe('monthly');
    expect(err.requested).toBe(150);
    expect(err.spent).toBe(400);
    expect(err.budget).toBe(500);
    expect(err.message).toContain('monthly');
  });
});
