import { describe, it, expect, vi } from 'vitest';
import {
  parseProgressLine,
  createProgressLineStream,
  createProgressThrottle,
  pseudoProgress,
  isWorldReapable,
  reapStaleUploads,
  REAPER_STALE_UPLOAD_MS,
  type WorkerDeps,
} from '../src/worker.js';
import { serializeWorld } from '../src/routes/worlds.js';
import { jobs, worlds, type World } from '../src/db/schema.js';

// Pipeline progress visibility + orphan-world reaper (pure pieces + mocked-db
// dispatch). No DB, no network, no Python.

// --- PROGRESS line parsing ----------------------------------------------------
describe('parseProgressLine', () => {
  it('parses machine-readable PROGRESS lines from reproject.py', () => {
    expect(parseProgressLine('PROGRESS 0')).toBe(0);
    expect(parseProgressLine('PROGRESS 42')).toBe(42);
    expect(parseProgressLine('PROGRESS 100')).toBe(100);
    expect(parseProgressLine('  PROGRESS 7  ')).toBe(7); // tolerant of whitespace
  });

  it('ignores human log lines and out-of-range values', () => {
    expect(parseProgressLine('frame 3: pose(lat=0) covered 1234 px')).toBeNull();
    expect(parseProgressLine('coverage 91.2% before inpaint')).toBeNull();
    expect(parseProgressLine('PROGRESS 101')).toBeNull();
    expect(parseProgressLine('PROGRESS -5')).toBeNull();
    expect(parseProgressLine('PROGRESS')).toBeNull();
    expect(parseProgressLine('PROGRESS abc')).toBeNull();
    expect(parseProgressLine('XPROGRESS 10')).toBeNull();
  });
});

describe('createProgressLineStream', () => {
  it('handles chunks that split lines arbitrarily', () => {
    const seen: number[] = [];
    const push = createProgressLineStream((p) => seen.push(p));
    push('reproject: mode=poses width=8192\nPROG');
    push('RESS 5\nframe 0: covered 10 px\nPROGRESS 1');
    push('0\n');
    expect(seen).toEqual([5, 10]);
  });

  it('does not fire for a trailing line without a newline', () => {
    const seen: number[] = [];
    const push = createProgressLineStream((p) => seen.push(p));
    push('PROGRESS 50'); // incomplete — no \n yet
    expect(seen).toEqual([]);
    push('\n');
    expect(seen).toEqual([50]);
  });
});

// --- write throttle -----------------------------------------------------------
describe('createProgressThrottle', () => {
  it('always writes the first value, then requires >=5 delta or >=5s', () => {
    let t = 0;
    const should = createProgressThrottle({ now: () => t });
    expect(should(0)).toBe(true); // first write
    expect(should(2)).toBe(false); // +2 points, 0s later → suppressed
    expect(should(5)).toBe(true); // +5 points → writes
    t = 4_000;
    expect(should(6)).toBe(false); // +1 point, 4s → suppressed
    t = 10_000;
    expect(should(6)).toBe(true); // same value but >=5s elapsed → heartbeat write
  });
});

// --- pseudo-progress math -------------------------------------------------------
describe('pseudoProgress', () => {
  it('is linear against the expected duration', () => {
    expect(pseudoProgress(0, 45_000)).toBe(0);
    expect(pseudoProgress(22_500, 45_000)).toBe(50);
    expect(pseudoProgress(40_500, 45_000)).toBe(90);
  });

  it('caps at 95 — never claims done before the status flips', () => {
    expect(pseudoProgress(45_000, 45_000)).toBe(95);
    expect(pseudoProgress(10 * 45_000, 45_000)).toBe(95);
  });

  it('handles degenerate inputs', () => {
    expect(pseudoProgress(-100, 45_000)).toBe(0);
    expect(pseudoProgress(1_000, 0)).toBe(95);
  });
});

// --- reaper predicate (pure SQL mirror, same pattern as isJobClaimable) --------
describe('isWorldReapable', () => {
  const now = new Date('2026-07-12T12:00:00Z');
  const hoursAgo = (h: number) => new Date(now.getTime() - h * 3_600_000);
  const w = (status: string, createdAt: Date) =>
    ({ status, createdAt }) as Pick<World, 'status' | 'createdAt'>;

  it('reaps only uploading worlds older than 24h', () => {
    expect(isWorldReapable(w('uploading', hoursAgo(25)), now)).toBe(true);
    expect(isWorldReapable(w('uploading', hoursAgo(23)), now)).toBe(false); // too young
    expect(isWorldReapable(w('stitching', hoursAgo(25)), now)).toBe(false); // wrong status
    expect(isWorldReapable(w('draft_ready', hoursAgo(48)), now)).toBe(false);
    expect(isWorldReapable(w('failed_upload', hoursAgo(48)), now)).toBe(false); // already reaped
  });

  it('threshold matches the exported constant (24h)', () => {
    expect(REAPER_STALE_UPLOAD_MS).toBe(24 * 60 * 60 * 1000);
    const justOver = new Date(now.getTime() - REAPER_STALE_UPLOAD_MS - 1);
    const justUnder = new Date(now.getTime() - REAPER_STALE_UPLOAD_MS + 1);
    expect(isWorldReapable(w('uploading', justOver), now)).toBe(true);
    expect(isWorldReapable(w('uploading', justUnder), now)).toBe(false);
  });
});

// --- reaper dispatch (mocked db) -----------------------------------------------
interface ReapSink {
  updates: { table: unknown; patch: Record<string, unknown> }[];
  inserts: { table: unknown; vals: Record<string, unknown> }[];
}

/** Mocked drizzle db: update().set().where().returning() yields `reapedIds`. */
function makeReaperDb(reapedIds: string[], sink: ReapSink) {
  const db = {
    transaction: async <T>(cb: (tx: unknown) => Promise<T>): Promise<T> => cb(db),
    update: (table: unknown) => ({
      set: (patch: Record<string, unknown>) => ({
        where: () => ({
          returning: async () => {
            sink.updates.push({ table, patch });
            return reapedIds.map((id) => ({ id }));
          },
        }),
      }),
    }),
    insert: (table: unknown) => ({
      values: (vals: Record<string, unknown>) => ({
        returning: async () => {
          sink.inserts.push({ table, vals });
          return [{ id: `job-${sink.inserts.length}` }];
        },
      }),
    }),
  };
  return db as unknown as WorkerDeps['db'];
}

describe('reapStaleUploads', () => {
  it('flips reaped worlds to failed_upload (progress cleared, row kept) and enqueues a frames-only purge each', async () => {
    const sink: ReapSink = { updates: [], inserts: [] };
    const db = makeReaperDb(['w-1', 'w-2'], sink);
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    const reaped = await reapStaleUploads(db);

    expect(reaped).toEqual(['w-1', 'w-2']);
    expect(sink.updates).toHaveLength(1);
    const patch = sink.updates[0]!.patch;
    expect(sink.updates[0]!.table).toBe(worlds);
    expect(patch['status']).toBe('failed_upload');
    expect(patch['progress']).toBeNull();
    expect(patch['updatedAt']).toBeDefined(); // heartbeat touched
    // Keep the row: never a soft delete from the reaper.
    expect(patch).not.toHaveProperty('deletedAt');

    // One frames-only purge per reaped world, against the jobs table.
    expect(sink.inserts).toHaveLength(2);
    for (const [i, worldId] of ['w-1', 'w-2'].entries()) {
      expect(sink.inserts[i]!.table).toBe(jobs);
      expect(sink.inserts[i]!.vals['kind']).toBe('purge');
      expect(sink.inserts[i]!.vals['worldId']).toBe(worldId);
      expect(sink.inserts[i]!.vals['payload']).toEqual({ framesOnly: true });
    }

    // Each reaped world id is logged.
    const logged = logSpy.mock.calls.map((c) => String(c[0]));
    expect(logged.some((l) => l.includes('w-1'))).toBe(true);
    expect(logged.some((l) => l.includes('w-2'))).toBe(true);
    logSpy.mockRestore();
  });

  it('no stale worlds → no purge jobs, no logs', async () => {
    const sink: ReapSink = { updates: [], inserts: [] };
    const db = makeReaperDb([], sink);

    const reaped = await reapStaleUploads(db);

    expect(reaped).toEqual([]);
    expect(sink.inserts).toHaveLength(0);
  });
});

// --- serializeWorld contract -----------------------------------------------------
describe('serializeWorld progress + heartbeat', () => {
  const base: World = {
    id: 'w-1', ownerId: 'u-1', title: 'T', caption: null, lat: null, lng: null,
    placeName: null, isPublic: false, status: 'stitching', phase: null,
    progress: 40, panoUrl: null, thumbnailUrl: null, spz100kUrl: null,
    spz500kUrl: null, spzFullUrl: null, colliderGlbUrl: null, assetVersion: 1,
    provider: null, draftWorldId: null, hqWorldId: null, draftModel: null,
    hqModel: null, creditsSpent: 0,
    createdAt: new Date('2026-07-12T10:00:00Z'),
    updatedAt: new Date('2026-07-12T10:05:00Z'),
    deletedAt: null,
  };

  it('includes progress and heartbeat_at (worlds.updated_at)', () => {
    const out = serializeWorld(base);
    expect(out['progress']).toBe(40);
    expect(out['heartbeat_at']).toEqual(new Date('2026-07-12T10:05:00Z'));
  });

  it('progress serializes as null between phases', () => {
    const out = serializeWorld({ ...base, progress: null, status: 'draft_ready' });
    expect(out['progress']).toBeNull();
    expect(out['heartbeat_at']).toBeInstanceOf(Date);
  });
});
