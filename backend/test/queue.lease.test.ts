import { describe, it, expect } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';
import {
  LEASE_SECONDS,
  MAX_ATTEMPTS,
  claimNextJob,
  isJobClaimable,
  mapJobRow,
  parkExhaustedJobs,
} from '../src/queue.js';
import type { Db } from '../src/db/client.js';

// Lease-expiry claim logic (QA defect fix). isJobClaimable is the pure mirror
// of the claimNextJob WHERE clause; the SQL must stay in sync with it.

const now = new Date('2026-07-12T12:00:00Z');

function job(overrides: {
  phase: string;
  lockedAt: Date | null;
  runAfter?: Date;
  attempts?: number;
}) {
  return {
    phase: overrides.phase,
    lockedAt: overrides.lockedAt,
    runAfter: overrides.runAfter ?? new Date(now.getTime() - 1000),
    attempts: overrides.attempts ?? 0,
  };
}

describe('LEASE_SECONDS', () => {
  it('is 600 (10 minutes)', () => {
    expect(LEASE_SECONDS).toBe(600);
  });
});

describe('isJobClaimable', () => {
  it('claims an unlocked queued job whose backoff has passed', () => {
    expect(isJobClaimable(job({ phase: 'queued', lockedAt: null }), now)).toBe(true);
  });

  it('does not claim a job still inside its backoff window', () => {
    const runAfter = new Date(now.getTime() + 60_000);
    expect(isJobClaimable(job({ phase: 'queued', lockedAt: null, runAfter }), now)).toBe(false);
  });

  it('does not claim a freshly-leased (running) job', () => {
    const lockedAt = new Date(now.getTime() - 60_000); // 1 min ago, lease valid.
    expect(isJobClaimable(job({ phase: 'running', lockedAt }), now)).toBe(false);
  });

  it('RE-claims a running job whose lease has expired (crashed worker)', () => {
    const lockedAt = new Date(now.getTime() - (LEASE_SECONDS + 1) * 1000);
    expect(isJobClaimable(job({ phase: 'running', lockedAt }), now)).toBe(true);
  });

  it('treats the lease boundary as not-yet-expired (must be strictly older)', () => {
    const lockedAt = new Date(now.getTime() - LEASE_SECONDS * 1000);
    expect(isJobClaimable(job({ phase: 'running', lockedAt }), now)).toBe(false);
  });

  it('never re-claims a job that already used every attempt (§10 R27)', () => {
    // A run that kills the process never reaches failJob; its lease expires
    // with attempts at the cap. It used to be re-claimed forever.
    const lockedAt = new Date(now.getTime() - (LEASE_SECONDS + 1) * 1000);
    expect(isJobClaimable(job({ phase: 'running', lockedAt, attempts: MAX_ATTEMPTS }), now)).toBe(false);
    expect(isJobClaimable(job({ phase: 'running', lockedAt, attempts: MAX_ATTEMPTS - 1 }), now)).toBe(true);
  });

  it('never claims done or dead jobs', () => {
    expect(isJobClaimable(job({ phase: 'done', lockedAt: null }), now)).toBe(false);
    expect(isJobClaimable(job({ phase: 'dead', lockedAt: null }), now)).toBe(false);
  });
});

// --- Real generated SQL text (QA regression) ---------------------------------
// The deployed worker failed every claim because `kind = ANY(${kinds})` made
// Drizzle expand the JS array into a tuple → `ANY(($2,$3,$4,$5))`, which
// Postgres rejects. Render the exact SQL claimNextJob executes and assert the
// kinds filter is a bound IN list (and never a tuple-inside-ANY).
describe('claimNextJob generated SQL', () => {
  const dialect = new PgDialect();

  async function renderClaimSql(kinds: string[]): Promise<{ sql: string; params: unknown[] }> {
    let captured: SQL | undefined;
    const fakeDb = {
      execute: async (query: SQL) => {
        captured = query;
        return { rows: [] };
      },
    } as unknown as Db;
    await claimNextJob(fakeDb, kinds as never[], 'worker-1');
    if (!captured) throw new Error('claimNextJob did not execute a query');
    return dialect.sqlToQuery(captured);
  }

  it('binds kinds as an IN list of parameters, not ANY(tuple)', async () => {
    const { sql: text, params } = await renderClaimSql([
      'stitch',
      'generate_draft',
      'generate_hq',
      'purge',
    ]);
    expect(text).not.toMatch(/ANY\s*\(\(/i); // the exact production failure.
    expect(text).toMatch(/kind IN \(\$\d+, \$\d+, \$\d+, \$\d+\)/);
    // Values are bound parameters (workerId, kinds, LEASE_SECONDS, MAX_ATTEMPTS)
    // — never interpolated.
    expect(params).toEqual([
      'worker-1',
      'stitch',
      'generate_draft',
      'generate_hq',
      'purge',
      LEASE_SECONDS,
      MAX_ATTEMPTS,
    ]);
    expect(text).not.toContain("'stitch'");
    // Lease expiry + backoff conditions present.
    expect(text).toContain('locked_at IS NULL OR locked_at <');
    expect(text).toContain('run_after <= now()');
    expect(text).toContain('FOR UPDATE SKIP LOCKED');
    // §10 R27: a job that already used every attempt is never claimed again.
    expect(text).toMatch(/attempts < \$\d+/);
  });

  it('single kind still renders a valid IN list', async () => {
    const { sql: text, params } = await renderClaimSql(['purge']);
    expect(text).toMatch(/kind IN \(\$\d+\)/);
    expect(params).toContain('purge');
  });

  it('returns null for an empty kinds list without executing SQL', async () => {
    const fakeDb = {
      execute: async () => {
        throw new Error('should not execute');
      },
    } as unknown as Db;
    expect(await claimNextJob(fakeDb, [], 'w')).toBeNull();
  });
});

describe('mapJobRow', () => {
  it('maps snake_case raw claim rows to the Job shape (worldId, providerOperationId)', () => {
    const created = new Date('2026-07-12T11:00:00Z');
    const mapped = mapJobRow({
      id: 'j1',
      world_id: 'w1',
      kind: 'generate_draft',
      phase: 'running',
      attempts: 2,
      last_error: null,
      payload: null,
      provider_operation_id: 'op-77',
      run_after: created,
      locked_at: created,
      locked_by: 'worker-1',
      created_at: created,
      updated_at: created,
    });
    // These two drove the §14 resume check — undefined here meant re-billing.
    expect(mapped.worldId).toBe('w1');
    expect(mapped.providerOperationId).toBe('op-77');
    expect(mapped.attempts).toBe(2);
    expect(mapped.lockedBy).toBe('worker-1');
  });

  it('coerces string timestamps to Date (raw execute path, seen on real Neon)', () => {
    // Postgres text format for timestamptz, exactly as the driver returned it.
    const mapped = mapJobRow({
      id: 'j2',
      world_id: 'w2',
      kind: 'purge',
      phase: 'running',
      attempts: 1,
      last_error: null,
      payload: null,
      provider_operation_id: null,
      run_after: '2026-07-11 21:31:21.397825+00',
      locked_at: '2026-07-11 21:31:21.397825+00',
      locked_by: 'worker-1',
      created_at: '2026-07-11 21:00:00+00',
      updated_at: '2026-07-11 21:31:21.397825+00',
    });
    expect(mapped.runAfter).toBeInstanceOf(Date);
    expect(mapped.lockedAt).toBeInstanceOf(Date);
    expect(mapped.createdAt).toBeInstanceOf(Date);
    expect(mapped.updatedAt).toBeInstanceOf(Date);
    // Values parse correctly, not just typecheck (Date semantics matter for
    // isJobClaimable-style arithmetic downstream).
    expect(mapped.lockedAt!.getTime()).toBe(Date.parse('2026-07-11T21:31:21.397825+00:00'));
    expect(mapped.createdAt.getTime()).toBe(Date.parse('2026-07-11T21:00:00+00:00'));
    expect(Number.isNaN(mapped.runAfter.getTime())).toBe(false);
  });

  it('keeps nullable timestamp null and passes real Dates through unchanged', () => {
    const d = new Date('2026-07-12T11:00:00Z');
    const mapped = mapJobRow({
      id: 'j3',
      world_id: 'w3',
      kind: 'stitch',
      phase: 'queued',
      attempts: 0,
      last_error: null,
      payload: null,
      provider_operation_id: null,
      run_after: d,
      locked_at: null,
      locked_by: null,
      created_at: d,
      updated_at: d,
    });
    expect(mapped.lockedAt).toBeNull(); // exact null handling preserved.
    expect(mapped.runAfter).toBe(d); // same instance, no needless re-wrap.
    expect(mapped.createdAt).toBe(d);
  });
});

describe('parkExhaustedJobs (§10 R27)', () => {
  const dialect = new PgDialect();

  it('parks over-cap, unleased-or-expired jobs dead in one statement and maps the rows', async () => {
    let captured: SQL | undefined;
    const fakeDb = {
      execute: async (q: SQL) => {
        captured = q;
        return {
          rows: [
            {
              id: 'j1', world_id: 'w1', kind: 'stitch', phase: 'dead', attempts: 5,
              last_error: 'x', payload: null, provider_operation_id: null,
              run_after: now, locked_at: null, locked_by: null, created_at: now, updated_at: now,
            },
          ],
        };
      },
    } as unknown as Db;

    const parked = await parkExhaustedJobs(fakeDb, ['stitch', 'purge']);

    expect(parked.map((j) => [j.id, j.worldId, j.kind])).toEqual([['j1', 'w1', 'stitch']]);
    const { sql: text, params } = dialect.sqlToQuery(captured!);
    expect(text).toContain("SET phase = 'dead'");
    expect(text).toMatch(/kind IN \(\$\d+, \$\d+\)/);
    expect(text).toContain("phase IN ('queued', 'running')");
    expect(text).toMatch(/attempts >= \$\d+/);
    // Same lease test as claim: a live 5th attempt (fresh lease) is left alone.
    expect(text).toContain('locked_at IS NULL OR locked_at <');
    expect(text).toContain('RETURNING *');
    expect(params).toEqual(expect.arrayContaining(['stitch', 'purge', MAX_ATTEMPTS, LEASE_SECONDS]));
  });

  it('no kinds → no SQL', async () => {
    const fakeDb = {
      execute: async () => {
        throw new Error('should not execute');
      },
    } as unknown as Db;
    expect(await parkExhaustedJobs(fakeDb, [])).toEqual([]);
  });
});
