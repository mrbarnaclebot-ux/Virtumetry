import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { sql } from 'drizzle-orm';
import type { Db } from '../../src/db/client.js';
import * as schema from '../../src/db/schema.js';
import {
  LEASE_SECONDS,
  claimNextJob,
  completeJob,
  enqueue,
  failJob,
  heartbeatJob,
} from '../../src/queue.js';

// OPTIONAL integration test — runs ONLY when TEST_DATABASE_URL is set, so CI
// without a database stays green. It exercises the queue's raw SQL against a
// REAL Postgres, closing the gap that let `kind = ANY(<tuple>)` ship: unit
// tests rendered/mocked SQL but never executed it.
//
//   TEST_DATABASE_URL=postgres://user:pass@localhost:5432/postgres npm test
//
// Isolation: everything happens inside a throwaway schema (dropped afterAll)
// selected via search_path. Only the `jobs` table is created — the queue
// functions never touch worlds/users, so the world FK is intentionally omitted
// here (world ids are just uuids from the test's perspective).
//
// search_path is applied via a pool 'connect' hook (`SET search_path` runs as
// the FIRST query on every new connection), NOT via the `options` startup
// parameter — Neon's pooled endpoint (pgbouncer) rejects that with
// "unsupported startup parameter in options: search_path". The hook (option a)
// is required rather than schema-qualifying, because the queue functions under
// test reference unqualified `jobs`. Caveat: under a transaction-mode pooler a
// session-level SET is not guaranteed to stick if server connections are
// multiplexed between transactions; if you ever see cross-schema flakiness,
// point TEST_DATABASE_URL at the DIRECT (non-pooled) endpoint.

const url = process.env.TEST_DATABASE_URL;

describe.skipIf(!url)('queue against real Postgres', () => {
  const schemaName = `virtspace_it_${randomUUID().replace(/-/g, '').slice(0, 12)}`;
  let pool: pg.Pool;
  let db: Db;
  const worldId = randomUUID();

  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: url, max: 2 });
    // Route every unqualified table reference into the throwaway schema.
    // Per-connection SET (not a startup option — Neon's pooler rejects those).
    // node-postgres runs this enqueued query before any consumer query on the
    // same client, so it always wins the race. Setting search_path to a
    // not-yet-created schema is harmless (first connection, pre-CREATE).
    pool.on('connect', (client) => {
      client
        .query(`SET search_path TO "${schemaName}"`)
        .catch((err: unknown) =>
          // Surface loudly — a silent failure here would leak queries into public.
          console.error(`[queue.pg.test] SET search_path failed: ${String(err)}`),
        );
    });
    await pool.query(`CREATE SCHEMA "${schemaName}"`);
    // Mirror of the jobs DDL from drizzle/0000_*.sql, minus the worlds FK.
    await pool.query(`
      CREATE TABLE "${schemaName}"."jobs" (
        "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
        "world_id" uuid NOT NULL,
        "kind" text NOT NULL,
        "phase" text DEFAULT 'queued' NOT NULL,
        "attempts" integer DEFAULT 0 NOT NULL,
        "last_error" text,
        "payload" jsonb,
        "provider_operation_id" text,
        "run_after" timestamp with time zone DEFAULT now() NOT NULL,
        "locked_at" timestamp with time zone,
        "locked_by" text,
        "created_at" timestamp with time zone DEFAULT now() NOT NULL,
        "updated_at" timestamp with time zone DEFAULT now() NOT NULL
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

  it('enqueue → claim (multiple kinds) → complete round-trips', async () => {
    const stitchId = await enqueue(db, 'stitch', worldId);
    const draftId = await enqueue(db, 'generate_draft', worldId, { note: 'p' });
    expect(stitchId).toBeTruthy();

    // Multi-kind claim — this exact statement failed in prod with ANY(tuple).
    const first = await claimNextJob(
      db,
      ['stitch', 'generate_draft', 'generate_hq', 'purge'],
      'worker-A',
    );
    expect(first).not.toBeNull();
    expect(['stitch', 'generate_draft']).toContain(first!.kind);
    expect(first!.worldId).toBe(worldId); // snake_case → camelCase mapping.
    expect(first!.phase).toBe('running');
    expect(first!.attempts).toBe(1);
    expect(first!.lockedBy).toBe('worker-A');
    expect(first!.lockedAt).toBeInstanceOf(Date);

    // Second claim gets the other job; third finds an empty queue.
    const second = await claimNextJob(db, ['stitch', 'generate_draft'], 'worker-B');
    expect(second).not.toBeNull();
    expect(second!.id).not.toBe(first!.id);
    expect([first!.id, second!.id].sort()).toEqual([stitchId, draftId].sort());
    expect(await claimNextJob(db, ['stitch', 'generate_draft'], 'worker-C')).toBeNull();

    // Complete both: phase done, lease released, no longer claimable.
    await completeJob(db, first!.id);
    await completeJob(db, second!.id);
    const done = await pool.query('SELECT phase, locked_at, locked_by FROM jobs WHERE id = $1', [
      first!.id,
    ]);
    expect(done.rows[0]).toEqual({ phase: 'done', locked_at: null, locked_by: null });
    expect(await claimNextJob(db, ['stitch', 'generate_draft'], 'worker-D')).toBeNull();
  });

  it('failJob schedules a backoff retry that becomes claimable when run_after passes', async () => {
    const jobId = await enqueue(db, 'generate_hq', worldId);
    const claimed = await claimNextJob(db, ['generate_hq'], 'worker-A');
    expect(claimed!.id).toBe(jobId);

    await failJob(db, jobId, 'provider hiccup');
    const row = await pool.query(
      'SELECT phase, last_error, locked_at, run_after > now() AS deferred FROM jobs WHERE id = $1',
      [jobId],
    );
    expect(row.rows[0].phase).toBe('queued');
    expect(row.rows[0].last_error).toBe('provider hiccup');
    expect(row.rows[0].locked_at).toBeNull();
    expect(row.rows[0].deferred).toBe(true); // inside the backoff window…
    expect(await claimNextJob(db, ['generate_hq'], 'worker-A')).toBeNull();

    // …until run_after passes, then it is claimable again (attempts grows).
    await pool.query("UPDATE jobs SET run_after = now() - interval '1 second' WHERE id = $1", [
      jobId,
    ]);
    const reclaimed = await claimNextJob(db, ['generate_hq'], 'worker-B');
    expect(reclaimed!.id).toBe(jobId);
    expect(reclaimed!.attempts).toBe(2);
    await completeJob(db, jobId);
  });

  it('failJob reports dead once a job exhausts MAX_ATTEMPTS (5)', async () => {
    const jobId = await enqueue(db, 'stitch', worldId);
    await claimNextJob(db, ['stitch'], 'worker-A'); // attempts = 1
    expect(await failJob(db, jobId, 'first')).toBe('queued');

    // Jump to the 5th claim: attempts = 4 here, the claim makes it 5.
    await pool.query(
      "UPDATE jobs SET attempts = 4, run_after = now() - interval '1 second' WHERE id = $1",
      [jobId],
    );
    const fifth = await claimNextJob(db, ['stitch'], 'worker-A');
    expect(fifth!.attempts).toBe(5);
    expect(await failJob(db, jobId, 'fifth')).toBe('dead');
    expect(await claimNextJob(db, ['stitch'], 'worker-A')).toBeNull();
  });

  it('lease expiry: a crashed worker\'s job is re-claimable after LEASE_SECONDS', async () => {
    const jobId = await enqueue(db, 'purge', worldId);
    const claimed = await claimNextJob(db, ['purge'], 'worker-crash');
    expect(claimed!.id).toBe(jobId);

    // Lease held → not claimable.
    expect(await claimNextJob(db, ['purge'], 'worker-rescue')).toBeNull();

    // Simulate the crash: backdate the lease past LEASE_SECONDS.
    await pool.query(
      `UPDATE jobs SET locked_at = now() - ($1 + 1) * interval '1 second' WHERE id = $2`,
      [LEASE_SECONDS, jobId],
    );
    const rescued = await claimNextJob(db, ['purge'], 'worker-rescue');
    expect(rescued).not.toBeNull();
    expect(rescued!.id).toBe(jobId);
    expect(rescued!.lockedBy).toBe('worker-rescue');
    expect(rescued!.attempts).toBe(2);
    await completeJob(db, jobId);
  });

  // spec §10 R6 — a long phase must be able to hold its lease open, and a worker
  // that lost the lease must find out instead of finalizing behind the new owner.
  it('heartbeatJob keeps a live job un-claimable past LEASE_SECONDS', async () => {
    const jobId = await enqueue(db, 'generate_draft', worldId);
    const claimed = await claimNextJob(db, ['generate_draft'], 'worker-live');
    expect(claimed!.id).toBe(jobId);

    // Age the lease past expiry — without a heartbeat this job is up for grabs.
    await pool.query(
      `UPDATE jobs SET locked_at = now() - ($1 + 1) * interval '1 second' WHERE id = $2`,
      [LEASE_SECONDS, jobId],
    );
    expect(await heartbeatJob(db, jobId, 'worker-live')).toBe(true);

    // The refreshed lease blocks the re-claim the stale one would have allowed.
    expect(await claimNextJob(db, ['generate_draft'], 'worker-thief')).toBeNull();
    await completeJob(db, jobId);
  });

  it('heartbeatJob reports the lease LOST to a worker that no longer holds it', async () => {
    const jobId = await enqueue(db, 'generate_hq', worldId);
    await claimNextJob(db, ['generate_hq'], 'worker-old');

    // Someone else re-claims after the lease expires (crash recovery).
    await pool.query(
      `UPDATE jobs SET locked_at = now() - ($1 + 1) * interval '1 second' WHERE id = $2`,
      [LEASE_SECONDS, jobId],
    );
    const rescued = await claimNextJob(db, ['generate_hq'], 'worker-new');
    expect(rescued!.lockedBy).toBe('worker-new');

    expect(await heartbeatJob(db, jobId, 'worker-old')).toBe(false);
    expect(await heartbeatJob(db, jobId, 'worker-new')).toBe(true);

    // A finished/parked job cannot be heartbeated by anyone.
    await completeJob(db, jobId);
    expect(await heartbeatJob(db, jobId, 'worker-new')).toBe(false);
  });

  it('drizzle raw execute sanity: search_path isolation works', async () => {
    const res = await db.execute<{ n: string }>(sql`SELECT count(*) AS n FROM jobs`);
    const rows = (res as unknown as { rows: { n: string }[] }).rows;
    expect(Number(rows[0]!.n)).toBeGreaterThan(0);
  });
});
