import { describe, it, expect, vi } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';
import { heartbeatJob } from '../src/queue.js';
import {
  handleJobError,
  reapExhaustedJobs,
  LeaseLostError,
  NonRetryableJobError,
} from '../src/worker.js';
import type { Db } from '../src/db/client.js';
import type { Job } from '../src/db/schema.js';

// spec §10 R6 — the job lease: heartbeats refresh it only for the holder, and a
// worker that LOST the lease must never touch the job row.

// --- heartbeatJob SQL --------------------------------------------------------

describe('heartbeatJob', () => {
  const dialect = new PgDialect();

  async function render(workerId?: string) {
    let captured: SQL | undefined;
    const db = {
      execute: async (q: SQL) => {
        captured = q;
        return { rows: [{ id: 'job-1' }] };
      },
    } as unknown as Db;
    const held = await heartbeatJob(db, 'job-1', workerId);
    return { held, ...dialect.sqlToQuery(captured!) };
  }

  it('refreshes locked_at only for a running job this worker still holds', async () => {
    const { held, sql: text, params } = await render('worker-A');
    expect(held).toBe(true);
    expect(text).toContain('locked_at = now()');
    expect(text).toContain("phase = 'running'");
    expect(text).toMatch(/locked_by = \$\d+/);
    expect(text).toContain('RETURNING id');
    expect(params).toContain('worker-A');
    expect(params).toContain('job-1');
  });

  it('omits the owner check when no worker id is supplied', async () => {
    const { sql: text, params } = await render();
    expect(text).not.toContain('locked_by =');
    expect(params).toEqual(['job-1']);
  });

  it('reports the lease LOST when the conditional update matches no row', async () => {
    const db = {
      execute: async () => ({ rows: [] }),
    } as unknown as Db;
    expect(await heartbeatJob(db, 'job-1', 'worker-A')).toBe(false);
  });
});

// --- shared fakes ------------------------------------------------------------

interface Sink {
  updates: { table: unknown; patch: Record<string, unknown> }[];
  executes: string[];
}

function newSink(): Sink {
  return { updates: [], executes: [] };
}

/** In-memory db double. `rows` decides what every raw `execute` returns. */
function makeDb(sink: Sink, rows: () => unknown[] = () => [{ id: 'job-1' }]): Db {
  return {
    update: (table: unknown) => ({
      set: (patch: Record<string, unknown>) => ({
        where: async () => {
          sink.updates.push({ table, patch });
        },
      }),
    }),
    execute: async (q: SQL) => {
      sink.executes.push(new PgDialect().sqlToQuery(q).sql);
      return { rows: rows() };
    },
  } as unknown as Db;
}

const purgeJob = { id: 'job-1', kind: 'purge', worldId: 'w-1', attempts: 1 } as unknown as Job;

// --- a lost lease must not touch the job row ---------------------------------

describe('handleJobError with a lost lease', () => {
  it('neither fails nor parks the job — the new owner holds it', async () => {
    const sink = newSink();
    await handleJobError(makeDb(sink), purgeJob, new LeaseLostError('lease lost'));
    expect(sink.executes).toEqual([]); // no failJob / parkJobDead UPDATE
    expect(sink.updates).toEqual([]);
  });

  it('still parks a genuinely non-retryable error', async () => {
    const sink = newSink();
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    await handleJobError(makeDb(sink), purgeJob, new NonRetryableJobError('boom'));
    expect(sink.executes.some((s) => s.includes("phase = 'dead'"))).toBe(true);
    expect(sink.updates).toEqual([]);
  });
});

describe('handleJobError on a retryable failure', () => {
  it('a retry left → job requeued, world untouched', async () => {
    const sink = newSink();
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    await handleJobError(makeDb(sink, () => [{ phase: 'queued' }]), purgeJob, new Error('disk hiccup'));
    expect(sink.executes.some((s) => s.includes('RETURNING phase'))).toBe(true);
    expect(sink.updates).toEqual([]);
  });

  it('5th failure → job dead, world untouched', async () => {
    const sink = newSink();
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    await handleJobError(
      makeDb(sink, () => [{ phase: 'dead' }]),
      { ...purgeJob, attempts: 5 } as Job,
      new Error('storage 503'),
    );
    expect(sink.executes).toHaveLength(1);
    expect(sink.updates).toEqual([]);
  });
});

// --- a job that killed the process on its last attempt (§10 R27) -------------

describe('reapExhaustedJobs', () => {
  it('parks every exhausted job and returns their ids', async () => {
    const sink = newSink();
    const db = makeDb(sink, () => [
      { id: 'j1', world_id: 'w-1', kind: 'purge', phase: 'dead', attempts: 5 },
      { id: 'j2', world_id: 'w-2', kind: 'purge', phase: 'dead', attempts: 5 },
    ]);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);

    expect(await reapExhaustedJobs(db)).toEqual(['j1', 'j2']);
    expect(sink.executes).toHaveLength(1);
    expect(sink.executes[0]).toContain("SET phase = 'dead'");
    expect(sink.updates).toEqual([]);
  });
});
