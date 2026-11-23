import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import { sql } from 'drizzle-orm';
import type { Db } from '../../src/db/client.js';
import {
  LEASE_SECONDS,
  claimNextJob,
  completeJob,
  enqueue,
  failJob,
  heartbeatJob,
  snoozeJob,
} from '../../src/queue.js';
import { createTestSchema } from '../helpers/pg-schema.js';

// OPTIONAL integration test — runs ONLY when TEST_DATABASE_URL is set, so CI
// without a database stays green. It exercises the queue's raw SQL against a
// REAL Postgres, closing the gap that let `kind = ANY(<tuple>)` ship: unit
// tests rendered/mocked SQL but never executed it.
//
//   cd backend && node --env-file=.env scripts/test-pg.mjs
//
// Isolation: a throwaway schema built from the REAL committed migration SQL
// (test/helpers/pg-schema.ts), dropped afterAll. jobs.world_id has its FK, so
// one user + world row is seeded.

const url = process.env.TEST_DATABASE_URL;

describe.skipIf(!url)('queue against real Postgres', () => {
  let pool: pg.Pool;
  let db: Db;
  let drop: () => Promise<void>;
  const userId = randomUUID();
  const worldId = randomUUID();

  beforeAll(async () => {
    ({ pool, db, drop } = await createTestSchema(url!));
    await pool.query('INSERT INTO users (id, apple_sub) VALUES ($1, $2)', [userId, `it-${userId}`]);
    await pool.query('INSERT INTO worlds (id, owner_id) VALUES ($1, $2)', [worldId, userId]);
  }, 60_000); // remote Neon: schema build is several round trips

  afterAll(async () => {
    if (drop) await drop();
  }, 30_000);

  it('enqueue → claim (two jobs) → complete round-trips', async () => {
    const firstId = await enqueue(db, 'purge', worldId);
    const secondId = await enqueue(db, 'purge', worldId, { note: 'p' });
    expect(firstId).toBeTruthy();

    // IN-list claim — the ANY(tuple) form of this statement failed in prod.
    const first = await claimNextJob(db, ['purge'], 'worker-A');
    expect(first).not.toBeNull();
    expect(first!.kind).toBe('purge');
    expect(first!.worldId).toBe(worldId); // snake_case → camelCase mapping.
    expect(first!.phase).toBe('running');
    expect(first!.attempts).toBe(1);
    expect(first!.lockedBy).toBe('worker-A');
    expect(first!.lockedAt).toBeInstanceOf(Date);

    // Second claim gets the other job; third finds an empty queue.
    const second = await claimNextJob(db, ['purge'], 'worker-B');
    expect(second).not.toBeNull();
    expect(second!.id).not.toBe(first!.id);
    expect([first!.id, second!.id].sort()).toEqual([firstId, secondId].sort());
    expect(await claimNextJob(db, ['purge'], 'worker-C')).toBeNull();

    // Complete both: phase done, lease released, no longer claimable.
    await completeJob(db, first!.id);
    await completeJob(db, second!.id);
    const done = await pool.query('SELECT phase, locked_at, locked_by FROM jobs WHERE id = $1', [
      first!.id,
    ]);
    expect(done.rows[0]).toEqual({ phase: 'done', locked_at: null, locked_by: null });
    expect(await claimNextJob(db, ['purge'], 'worker-D')).toBeNull();
  });

  it('failJob schedules a backoff retry that becomes claimable when run_after passes', async () => {
    const jobId = await enqueue(db, 'purge', worldId);
    const claimed = await claimNextJob(db, ['purge'], 'worker-A');
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
    expect(await claimNextJob(db, ['purge'], 'worker-A')).toBeNull();

    // …until run_after passes, then it is claimable again (attempts grows).
    await pool.query("UPDATE jobs SET run_after = now() - interval '1 second' WHERE id = $1", [
      jobId,
    ]);
    const reclaimed = await claimNextJob(db, ['purge'], 'worker-B');
    expect(reclaimed!.id).toBe(jobId);
    expect(reclaimed!.attempts).toBe(2);
    await completeJob(db, jobId);
  });

  it('failJob reports dead once a job exhausts MAX_ATTEMPTS (5)', async () => {
    const jobId = await enqueue(db, 'purge', worldId);
    await claimNextJob(db, ['purge'], 'worker-A'); // attempts = 1
    expect(await failJob(db, jobId, 'first')).toBe('queued');

    // Jump to the 5th claim: attempts = 4 here, the claim makes it 5.
    await pool.query(
      "UPDATE jobs SET attempts = 4, run_after = now() - interval '1 second' WHERE id = $1",
      [jobId],
    );
    const fifth = await claimNextJob(db, ['purge'], 'worker-A');
    expect(fifth!.attempts).toBe(5);
    expect(await failJob(db, jobId, 'fifth')).toBe('dead');
    expect(await claimNextJob(db, ['purge'], 'worker-A')).toBeNull();
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
    const jobId = await enqueue(db, 'purge', worldId);
    const claimed = await claimNextJob(db, ['purge'], 'worker-live');
    expect(claimed!.id).toBe(jobId);

    // Age the lease past expiry — without a heartbeat this job is up for grabs.
    await pool.query(
      `UPDATE jobs SET locked_at = now() - ($1 + 1) * interval '1 second' WHERE id = $2`,
      [LEASE_SECONDS, jobId],
    );
    expect(await heartbeatJob(db, jobId, 'worker-live')).toBe(true);

    // The refreshed lease blocks the re-claim the stale one would have allowed.
    expect(await claimNextJob(db, ['purge'], 'worker-thief')).toBeNull();
    await completeJob(db, jobId);
  });

  it('heartbeatJob reports the lease LOST to a worker that no longer holds it', async () => {
    const jobId = await enqueue(db, 'purge', worldId);
    await claimNextJob(db, ['purge'], 'worker-old');

    // Someone else re-claims after the lease expires (crash recovery).
    await pool.query(
      `UPDATE jobs SET locked_at = now() - ($1 + 1) * interval '1 second' WHERE id = $2`,
      [LEASE_SECONDS, jobId],
    );
    const rescued = await claimNextJob(db, ['purge'], 'worker-new');
    expect(rescued!.lockedBy).toBe('worker-new');

    expect(await heartbeatJob(db, jobId, 'worker-old')).toBe(false);
    expect(await heartbeatJob(db, jobId, 'worker-new')).toBe(true);

    // A finished/parked job cannot be heartbeated by anyone.
    await completeJob(db, jobId);
    expect(await heartbeatJob(db, jobId, 'worker-new')).toBe(false);
  });

  it('snoozeJob requeues without consuming an attempt and respects run_after', async () => {
    const jobId = await enqueue(db, 'track', worldId);
    const claimed = await claimNextJob(db, ['track'], 'worker-A');
    expect(claimed!.id).toBe(jobId);
    expect(claimed!.attempts).toBe(1);

    await snoozeJob(db, jobId, 60);
    const row = await pool.query(
      'SELECT phase, attempts, locked_at, locked_by, run_after > now() AS deferred FROM jobs WHERE id = $1',
      [jobId],
    );
    expect(row.rows[0]).toEqual({
      phase: 'queued',
      attempts: 0,
      locked_at: null,
      locked_by: null,
      deferred: true,
    });
    expect(await claimNextJob(db, ['track'], 'worker-A')).toBeNull();

    await pool.query("UPDATE jobs SET run_after = now() - interval '1 second' WHERE id = $1", [
      jobId,
    ]);
    const again = await claimNextJob(db, ['track'], 'worker-B');
    expect(again!.id).toBe(jobId);
    expect(again!.attempts).toBe(1); // the snooze did not burn an attempt
    await completeJob(db, jobId);
  });

  it('failJob honours an explicit delaySeconds', async () => {
    const jobId = await enqueue(db, 'track', worldId);
    await claimNextJob(db, ['track'], 'worker-A');
    await failJob(db, jobId, '503', 3600);
    const row = await pool.query(
      "SELECT run_after > now() + interval '3500 seconds' AS long FROM jobs WHERE id = $1",
      [jobId],
    );
    expect(row.rows[0].long).toBe(true);
    await completeJob(db, jobId);
  });

  it('drizzle raw execute sanity: search_path isolation works', async () => {
    const res = await db.execute<{ n: string }>(sql`SELECT count(*) AS n FROM jobs`);
    const rows = (res as unknown as { rows: { n: string }[] }).rows;
    expect(Number(rows[0]!.n)).toBeGreaterThan(0);
  });
});
