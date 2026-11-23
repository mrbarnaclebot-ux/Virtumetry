import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import type { Db } from '../../src/db/client.js';
import { reserveCredits, releaseCredits, BudgetExceededError } from '../../src/budget.js';
import { createTestSchema } from '../helpers/pg-schema.js';

// PROC-08 / D-22: the reservation race can only be proven on real Postgres
// (advisory lock + unique (submission_key, kind)). Run via
// `node --env-file=.env scripts/test-pg.mjs test/integration/budget.pg.test.ts`.

const url = process.env.TEST_DATABASE_URL;

type ReserveArgs = Parameters<typeof reserveCredits>[1];

describe.skipIf(!url)('credit budget against real Postgres', () => {
  let t: Awaited<ReturnType<typeof createTestSchema>>;
  let pool: pg.Pool;
  let db: Db;
  const userId = randomUUID();
  const worldId = randomUUID();

  const reserve = (over: Partial<ReserveArgs> = {}) =>
    reserveCredits(db, {
      key: randomUUID(),
      amount: 1200,
      mode: 'mock',
      worldId,
      daily: 100_000,
      monthly: 100_000,
      ...over,
    });

  const rows = async (where = 'true') =>
    (await pool.query(`SELECT amount, kind, created_at FROM credit_events WHERE ${where}`)).rows as {
      amount: number;
      kind: string;
      created_at: Date;
    }[];

  const todaySum = async (mode = 'mock') =>
    Number(
      (
        await pool.query(
          `SELECT COALESCE(SUM(amount), 0) AS s FROM credit_events WHERE provider_mode = $1
             AND created_at >= (date_trunc('day', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC')`,
          [mode],
        )
      ).rows[0].s,
    );

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
  });

  it.each(['daily', 'monthly'] as const)(
    'two concurrent reservations over the %s cap yield exactly one',
    async (window) => {
      const caps =
        window === 'daily' ? { daily: 2000, monthly: 100_000 } : { daily: 100_000, monthly: 2000 };
      const results = await Promise.allSettled([reserve(caps), reserve(caps)]);
      const ok = results.filter((r) => r.status === 'fulfilled');
      const bad = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected');
      expect(ok).toHaveLength(1);
      expect((ok[0] as PromiseFulfilledResult<string>).value).toBe('reserved');
      expect(bad).toHaveLength(1);
      expect(bad[0]!.reason).toBeInstanceOf(BudgetExceededError);
      expect((bad[0]!.reason as BudgetExceededError).window).toBe(window);
      expect(await rows("kind = 'reserve'")).toHaveLength(1);
    },
  );

  it('the same key reserves once, sequentially and concurrently', async () => {
    const key = randomUUID();
    expect(await reserve({ key })).toBe('reserved');
    expect(await reserve({ key })).toBe('already');

    const key2 = randomUUID();
    const both = await Promise.all([reserve({ key: key2 }), reserve({ key: key2 })]);
    expect(both.sort()).toEqual(['already', 'reserved']);
    expect(await rows("kind = 'reserve'")).toHaveLength(2);
  });

  it('a resumed reservation is not re-checked against a now-full window', async () => {
    const key = randomUUID();
    await reserve({ key, daily: 2000 });
    await reserve({ amount: 800, daily: 2000 }); // day is now full
    expect(await reserve({ key, daily: 2000 })).toBe('already');
  });

  it('release is idempotent and dated at its reservation', async () => {
    const key = randomUUID();
    await reserve({ key, amount: 930 });
    await releaseCredits(db, key);
    await releaseCredits(db, key);
    const [res] = await rows("kind = 'reserve'");
    const rel = await rows("kind = 'release'");
    expect(rel).toHaveLength(1);
    expect(rel[0]!.amount).toBe(-930);
    expect(rel[0]!.created_at.getTime()).toBe(res!.created_at.getTime());
    expect(await todaySum()).toBe(0);
  });

  it("releasing yesterday's reservation today leaves today's sum unchanged (Pitfall 6)", async () => {
    const key = randomUUID();
    await pool.query(
      `INSERT INTO credit_events (amount, world_id, submission_key, kind, provider_mode, created_at)
       VALUES (1500, $1, $2, 'reserve', 'mock', now() - interval '1 day')`,
      [worldId, key],
    );
    await reserve({ amount: 400 });
    expect(await todaySum()).toBe(400);
    await releaseCredits(db, key);
    expect(await todaySum()).toBe(400);
  });

  it('live and mock ledgers never count against each other', async () => {
    await reserve({ mode: 'live', amount: 1500, daily: 2000 });
    // Fits only if live spend is ignored for the mock partition.
    expect(await reserve({ mode: 'mock', amount: 1500, daily: 2000 })).toBe('reserved');
    await expect(reserve({ mode: 'live', amount: 1500, daily: 2000 })).rejects.toBeInstanceOf(
      BudgetExceededError,
    );
  });

  it('releasing an unknown key is a no-op', async () => {
    await releaseCredits(db, randomUUID());
    expect(await rows()).toHaveLength(0);
  });
});
