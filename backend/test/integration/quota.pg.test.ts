import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import type { Db } from '../../src/db/client.js';
import * as schema from '../../src/db/schema.js';
import { chargeScanQuota } from '../../src/quota.js';

// OPTIONAL integration test — runs ONLY when TEST_DATABASE_URL is set (same
// contract as queue.pg.test.ts), because the spec §10 R9 race can only be
// demonstrated against a real Postgres: the fix relies on the row lock the
// conditional UPDATE takes, which no in-memory double can model.
//
//   TEST_DATABASE_URL=postgres://user:pass@localhost:5432/postgres npm test
//
// Isolation: a throwaway schema on the search_path, dropped afterAll. Only the
// `users` table is created — chargeScanQuota touches nothing else.

const url = process.env.TEST_DATABASE_URL;

describe.skipIf(!url)('scan quota against real Postgres', () => {
  const schemaName = `virtspace_q_${randomUUID().replace(/-/g, '').slice(0, 12)}`;
  let pool: pg.Pool;
  let db: Db;
  const userId = randomUUID();

  beforeAll(async () => {
    // A pool wide enough that the concurrent charges below really do overlap.
    pool = new pg.Pool({ connectionString: url, max: 10 });
    pool.on('connect', (client) => {
      client
        .query(`SET search_path TO "${schemaName}"`)
        .catch((err: unknown) =>
          console.error(`[quota.pg.test] SET search_path failed: ${String(err)}`),
        );
    });
    await pool.query(`CREATE SCHEMA "${schemaName}"`);
    // Mirror of the users DDL from drizzle/0000_*.sql.
    await pool.query(`
      CREATE TABLE "${schemaName}"."users" (
        "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
        "apple_sub" text NOT NULL UNIQUE,
        "display_name" text,
        "daily_scan_count" integer DEFAULT 0 NOT NULL,
        "quota_reset_at" timestamp with time zone,
        "created_at" timestamp with time zone DEFAULT now() NOT NULL,
        "deleted_at" timestamp with time zone
      )
    `);
    db = drizzle(pool, { schema }) as unknown as Db;
  });

  afterAll(async () => {
    if (pool) {
      await pool.query(`DROP SCHEMA IF EXISTS "${schemaName}" CASCADE`).catch(() => undefined);
      await pool.end();
    }
  });

  beforeEach(async () => {
    await pool.query('DELETE FROM users');
    await pool.query('INSERT INTO users (id, apple_sub) VALUES ($1, $2)', [
      userId,
      `sub-${randomUUID()}`,
    ]);
  });

  it('opens a fresh 24h window at count 1 and increments within it', async () => {
    const first = await chargeScanQuota(db, userId, 3);
    expect(first).toMatchObject({ userFound: true, allowed: true, newCount: 1 });
    expect(first.resetAt!.getTime()).toBeGreaterThan(Date.now());

    const second = await chargeScanQuota(db, userId, 3);
    expect(second.newCount).toBe(2);
    // The window's reset time does not move while it is live.
    expect(second.resetAt!.getTime()).toBe(first.resetAt!.getTime());
  });

  it('refuses past the limit and reports the window reset as retry_at', async () => {
    for (let i = 0; i < 3; i++) await chargeScanQuota(db, userId, 3);

    const denied = await chargeScanQuota(db, userId, 3);
    expect(denied.allowed).toBe(false);
    expect(denied.newCount).toBeNull();
    expect(denied.resetAt).toBeInstanceOf(Date);

    const row = await pool.query('SELECT daily_scan_count FROM users WHERE id = $1', [userId]);
    expect(row.rows[0].daily_scan_count).toBe(3); // the refusal did not increment
  });

  it('starts a new window once the old one elapses', async () => {
    await chargeScanQuota(db, userId, 1);
    expect((await chargeScanQuota(db, userId, 1)).allowed).toBe(false);

    await pool.query("UPDATE users SET quota_reset_at = now() - interval '1 second' WHERE id = $1", [
      userId,
    ]);
    const fresh = await chargeScanQuota(db, userId, 1);
    expect(fresh.allowed).toBe(true);
    expect(fresh.newCount).toBe(1);
  });

  it('CONCURRENT charges never exceed the limit (the R9 race)', async () => {
    const MAX = 5;
    const ATTEMPTS = 20;

    const results = await Promise.all(
      Array.from({ length: ATTEMPTS }, () => chargeScanQuota(db, userId, MAX)),
    );

    const allowed = results.filter((r) => r.allowed).length;
    expect(allowed).toBe(MAX);

    const row = await pool.query('SELECT daily_scan_count FROM users WHERE id = $1', [userId]);
    expect(row.rows[0].daily_scan_count).toBe(MAX);
    // Every granted scan got a distinct counter value — no lost update.
    const counts = results.filter((r) => r.allowed).map((r) => r.newCount).sort((a, b) => a! - b!);
    expect(counts).toEqual([1, 2, 3, 4, 5]);
  });

  it('reports a missing user instead of throwing', async () => {
    const res = await chargeScanQuota(db, randomUUID(), 3);
    expect(res).toEqual({ userFound: false, allowed: false, newCount: null, resetAt: null });
  });
});
