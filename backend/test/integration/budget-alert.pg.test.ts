import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import type { Db } from '../../src/db/client.js';
import { reserveCredits } from '../../src/budget.js';
import { createTestSchema } from '../helpers/pg-schema.js';

// D-12 / V9: the budget alert fires once per (provider_mode, window, window_start),
// recorded inside the advisory-locked reserve tx. Run via
// `npm run test:pg -- test/integration/budget-alert.pg.test.ts`.

const url = process.env.TEST_DATABASE_URL;

type ReserveArgs = Parameters<typeof reserveCredits>[1];

describe.skipIf(!url)('budget alerts against real Postgres', () => {
  let t: Awaited<ReturnType<typeof createTestSchema>>;
  let pool: pg.Pool;
  let db: Db;
  const userId = randomUUID();
  const worldId = randomUUID();

  const reserve = (over: Partial<ReserveArgs> = {}) =>
    reserveCredits(db, {
      key: randomUUID(),
      amount: 500,
      mode: 'mock',
      worldId,
      daily: 1000,
      monthly: 100_000,
      share: 0.8,
      ...over,
    });

  const alerts = async () =>
    (
      await pool.query(
        'SELECT provider_mode, budget_window, spent, budget, share FROM budget_alerts ORDER BY budget_window, provider_mode',
      )
    ).rows as { provider_mode: string; budget_window: string; spent: number; budget: number; share: number }[];

  beforeAll(async () => {
    t = await createTestSchema(url!, { max: 10 });
    pool = t.pool;
    db = t.db;
    await pool.query('INSERT INTO users (id, apple_sub) VALUES ($1, $2)', [userId, `sub-${randomUUID()}`]);
    await pool.query('INSERT INTO worlds (id, owner_id) VALUES ($1, $2)', [worldId, userId]);
  }, 60_000);

  afterAll(async () => {
    await t?.drop();
  });

  beforeEach(async () => {
    await pool.query('DELETE FROM credit_events');
    await pool.query('DELETE FROM budget_alerts');
  });

  it('crossing the daily share records one row and notifies once', async () => {
    const onAlert = vi.fn();
    expect(await reserve({ amount: 500, onAlert })).toBe('reserved');
    expect(await alerts()).toHaveLength(0);
    expect(onAlert).not.toHaveBeenCalled();

    expect(await reserve({ amount: 400, onAlert })).toBe('reserved');
    expect(await alerts()).toEqual([
      { provider_mode: 'mock', budget_window: 'daily', spent: 900, budget: 1000, share: 0.8 },
    ]);
    expect(onAlert).toHaveBeenCalledTimes(1);
    expect(onAlert).toHaveBeenCalledWith([{ window: 'daily', spent: 900, budget: 1000, share: 0.8 }]);

    expect(await reserve({ amount: 50, onAlert })).toBe('reserved');
    expect(await alerts()).toHaveLength(1);
    expect(onAlert).toHaveBeenCalledTimes(1);
  });

  it('one reservation can cross both windows', async () => {
    const onAlert = vi.fn();
    await reserve({ amount: 900, monthly: 1100, onAlert });
    const rows = await alerts();
    expect(rows.map((r) => r.budget_window)).toEqual(['daily', 'monthly']);
    expect(onAlert).toHaveBeenCalledTimes(1);
    expect(onAlert.mock.calls[0]![0]).toHaveLength(2);
  });

  it('mock and live alert independently', async () => {
    await reserve({ amount: 900, mode: 'mock' });
    await reserve({ amount: 900, mode: 'live' });
    expect((await alerts()).map((r) => r.provider_mode)).toEqual(['live', 'mock']);
  });

  it('a throwing onAlert never fails the reservation', async () => {
    const key = randomUUID();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      const r = await reserve({
        key,
        amount: 900,
        onAlert: () => {
          throw new Error('push down');
        },
      });
      expect(r).toBe('reserved');
    } finally {
      warn.mockRestore();
    }
    const res = await pool.query(
      "SELECT 1 FROM credit_events WHERE submission_key = $1 AND kind = 'reserve'",
      [key],
    );
    expect(res.rows).toHaveLength(1);
    expect(await alerts()).toHaveLength(1);
  });

  it('without share no alert is recorded', async () => {
    await reserve({ amount: 900, share: undefined });
    expect(await alerts()).toHaveLength(0);
  });
});
