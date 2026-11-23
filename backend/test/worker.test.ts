import { describe, it, expect, vi } from 'vitest';
import { readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import {
  stitchPlan,
  serializePoses,
  posesPresent,
  buildStitcherArgs,
  handleStitch,
  processJob,
  runGeneration,
  stitcherExitCode,
  classifyStitcherFailure,
  classifyStitcherTimeout,
  NonRetryableJobError,
  STITCHER_EXIT_INPUT_ERROR,
  STITCHER_EXIT_OOM_KILLED,
  STITCH_RESOURCE_MAX_ATTEMPTS,
  type GenerationIO,
  type GenerationClock,
  type WorkerDeps,
  type StitcherSpawner,
} from '../src/worker.js';
import { MODEL_CREDITS, type WorldGenProvider } from '../src/provider/index.js';
import { createMockProvider } from '../src/provider/mock.js';
import { worlds, captures, type World, type Capture, type Job } from '../src/db/schema.js';
import { loadConfig } from '../src/config.js';
import type { StorageDriver } from '../src/storage/index.js';

// --- stitch decision (pure) --------------------------------------------------
describe('stitchPlan', () => {
  it('single frame → passthrough (the frame IS the pano)', () => {
    expect(stitchPlan(1)).toEqual({ type: 'passthrough' });
  });

  it('multi-frame → stitch (production reprojection)', () => {
    expect(stitchPlan(16)).toEqual({ type: 'stitch', frameCount: 16 });
    expect(stitchPlan(2).type).toBe('stitch');
  });
});

// --- poses.json serialization from a captures row shape ----------------------
describe('serializePoses / posesPresent', () => {
  // Mirrors captures.poses_json: array of ARKit pose objects (spec §schema).
  const row = [
    {
      index: 0,
      timestamp: 0.0,
      transform: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1],
      intrinsics: [1600, 0, 960, 0, 1600, 720, 0, 0, 1],
      exposureLocked: true,
    },
    {
      index: 1,
      timestamp: 0.1,
      transform: [0, 0, 1, 0, 0, 1, 0, 0, -1, 0, 0, 0, 0, 0, 0, 1],
      intrinsics: [1600, 0, 960, 0, 1600, 720, 0, 0, 1],
      exposureLocked: true,
    },
  ];

  it('serializes the pose array verbatim (round-trips)', () => {
    const json = serializePoses(row);
    expect(JSON.parse(json)).toEqual(row);
  });

  it('posesPresent is true for a non-empty array, false otherwise', () => {
    expect(posesPresent(row)).toBe(true);
    expect(posesPresent(null)).toBe(false);
    expect(posesPresent([])).toBe(false);
    expect(posesPresent(undefined)).toBe(false);
  });

  it('serializePoses rejects a null / empty poses column', () => {
    expect(() => serializePoses(null)).toThrow();
    expect(() => serializePoses([])).toThrow();
  });
});

// --- stitcher argv construction ---------------------------------------------
describe('buildStitcherArgs', () => {
  const base = {
    scriptPath: '/app/stitcher/reproject.py',
    framesDir: '/tmp/w/frames',
    outPath: '/tmp/w/pano.jpg',
    width: 8192,
  };

  it('includes --poses when a poses path is provided', () => {
    const args = buildStitcherArgs({ ...base, posesPath: '/tmp/w/poses.json' });
    expect(args).toContain('--poses');
    expect(args[args.indexOf('--poses') + 1]).toBe('/tmp/w/poses.json');
    expect(args).toEqual(
      expect.arrayContaining(['--frames-dir', '/tmp/w/frames', '--out', '/tmp/w/pano.jpg', '--width', '8192']),
    );
  });

  it('omits --poses when no poses path (nominal fallback)', () => {
    const args = buildStitcherArgs({ ...base, posesPath: null });
    expect(args).not.toContain('--poses');
  });

  it('includes --depth-dir only when a depth dir is given', () => {
    const args = buildStitcherArgs({ ...base, depthDir: '/tmp/w/depth' });
    expect(args[args.indexOf('--depth-dir') + 1]).toBe('/tmp/w/depth');
    expect(buildStitcherArgs({ ...base, depthDir: null })).not.toContain('--depth-dir');
  });

  it('includes --preview-out only when a preview path is given', () => {
    expect(buildStitcherArgs({ ...base, previewPath: '/tmp/w/prev.jpg' })).toContain('--preview-out');
    expect(buildStitcherArgs({ ...base })).not.toContain('--preview-out');
  });
});

// --- credit-safe generation (spec §14) --------------------------------------
const instantClock: GenerationClock = { now: () => 0, sleep: async () => undefined };

function fakeProvider(overrides: Partial<WorldGenProvider> = {}): WorldGenProvider {
  return {
    mode: 'mock',
    creditsForModel: () => 150,
    uploadPano: vi.fn(async () => 'media-1'),
    generateWorld: vi.fn(async () => 'op-1'),
    getOperation: vi.fn(async () => ({ done: true, worldId: 'world-1' })),
    getWorld: vi.fn(async () => ({ spzUrls: { k500: 'u500' }, caption: 'cap' })),
    downloadAsset: vi.fn(async () => Buffer.from('bytes')),
    findWorldByDisplayName: vi.fn(async () => null),
    ...overrides,
  } as WorldGenProvider;
}

function fakeIO(): GenerationIO & { saved: string[]; reserved: number[] } {
  const saved: string[] = [];
  const reserved: number[] = [];
  return {
    saved,
    reserved,
    reserveCredits: vi.fn(async (amount: number) => {
      reserved.push(amount);
    }),
    getPanoBytes: vi.fn(async () => Buffer.from('pano')),
    releaseCredits: vi.fn(async () => undefined),
    clearPendingMarker: vi.fn(async () => undefined),
    saveOperationId: vi.fn(async (opId: string) => {
      saved.push(opId);
    }),
    storeAsset: vi.fn(async (name: string) => `worlds/world-1/${name}`),
  };
}

describe('runGeneration credit safety', () => {
  it('fresh job: reserves credits, uploads, generates once, persists op id', async () => {
    const provider = fakeProvider();
    const io = fakeIO();

    const result = await runGeneration(
      provider,
      io,
      { jobId: 'job-1', model: 'marble-1.0-draft', displayName: 'W', cost: 150, existingOperationId: null },
      instantClock,
    );

    expect(io.reserveCredits).toHaveBeenCalledWith(150);
    expect(provider.uploadPano).toHaveBeenCalledOnce();
    expect(provider.generateWorld).toHaveBeenCalledOnce();
    // Intent marker first, then the real operation id (spec §10 R1).
    expect(io.saved).toEqual(['pending:job-1', 'op-1']);
    expect(result.worldId).toBe('world-1');
    expect(result.assetKeys.spz500kUrl).toBe('worlds/world-1/splat_500k.spz');
    expect(result.caption).toBe('cap');
  });

  it('RESUME (op id already set): NEVER re-bills — no reserve, no generate', async () => {
    const provider = fakeProvider();
    const io = fakeIO();

    await runGeneration(
      provider,
      io,
      { jobId: 'job-1', model: 'marble-1.0-draft', displayName: 'W', cost: 150, existingOperationId: 'op-existing' },
      instantClock,
    );

    // The money path is entirely skipped on resume.
    expect(io.reserveCredits).not.toHaveBeenCalled();
    expect(provider.uploadPano).not.toHaveBeenCalled();
    expect(provider.generateWorld).not.toHaveBeenCalled();
    expect(io.saveOperationId).not.toHaveBeenCalled();
    // But it still polls the existing operation and fetches the world.
    expect(provider.getOperation).toHaveBeenCalledWith('op-existing');
    expect(provider.getWorld).toHaveBeenCalledWith('world-1');
  });

  it('polls until done, then fetches the world', async () => {
    const getOperation = vi
      .fn()
      .mockResolvedValueOnce({ done: false })
      .mockResolvedValueOnce({ done: true, worldId: 'world-1' });
    const provider = fakeProvider({ getOperation });
    const io = fakeIO();

    await runGeneration(
      provider,
      io,
      { jobId: 'job-1', model: 'marble-1.1', displayName: 'W', cost: 1500, existingOperationId: null },
      instantClock,
    );
    expect(getOperation).toHaveBeenCalledTimes(2);
  });

  it('throws ProviderTimeoutError if the operation never completes', async () => {
    const provider = fakeProvider({ getOperation: vi.fn(async () => ({ done: false })) });
    const io = fakeIO();
    // Clock advances past the deadline on the first check.
    let t = 0;
    const clock: GenerationClock = {
      now: () => (t += 1_000_000),
      sleep: async () => undefined,
    };

    await expect(
      runGeneration(
        provider,
        io,
        { jobId: 'job-1', model: 'marble-1.0-draft', displayName: 'W', cost: 150, existingOperationId: null },
        clock,
        { timeoutMs: 1 },
      ),
    ).rejects.toMatchObject({ name: 'ProviderTimeoutError' });
  });
});

// --- mock generations are FREE ------------------------------------------------
// PROVIDER_MODE=mock must not eat the daily budget or inflate spend metrics.
// The worker derives BOTH the reserveCredits amount and the world's
// credits_spent increment from provider.creditsForModel(model), so asserting
// the mock reports 0 (and that reserve is still called, with 0) covers both.
describe('mock provider billing', () => {
  it('creditsForModel returns 0 for every model (draft and hq)', () => {
    const provider = createMockProvider();
    expect(provider.creditsForModel('marble-1.0-draft')).toBe(0);
    expect(provider.creditsForModel('marble-1.1')).toBe(0);
  });

  it('mock generation still exercises the budget path: reserveCredits(0)', async () => {
    const provider = createMockProvider();
    const io = fakeIO();
    // Exactly how handleGenerate derives the cost it reserves AND increments
    // credits_spent by — 0 on the mock, so the world's spend stays 0.
    const cost = provider.creditsForModel('marble-1.0-draft');

    const result = await runGeneration(
      provider,
      io,
      { jobId: 'job-1', model: 'marble-1.0-draft', displayName: 'W', cost, existingOperationId: null },
      instantClock,
    );

    expect(io.reserveCredits).toHaveBeenCalledTimes(1);
    expect(io.reserveCredits).toHaveBeenCalledWith(0); // ledger row of amount 0.
    expect(cost).toBe(0); // → worlds.credits_spent += 0.
    // The pipeline itself still completes end to end offline.
    expect(result.worldId).toMatch(/^mock-world-/);
    expect(result.assetKeys.spz500kUrl).toBe('worlds/world-1/splat_500k.spz');
  });

  it('real provider costs are unchanged (draft 150 / hq 1500)', () => {
    // MODEL_CREDITS is what the live provider returns verbatim.
    expect(MODEL_CREDITS['marble-1.0-draft']).toBe(150);
    expect(MODEL_CREDITS['marble-1.1']).toBe(1500);
  });
});

// --- stitch dispatch (handleStitch) -----------------------------------------
// Exercises the branch decision + subprocess wiring with a MOCKED spawner and
// an in-memory db/storage. No Python, no DB, no network.
const stitchConfig = loadConfig({
  DATABASE_URL: 'postgres://u:p@localhost:5432/db',
  DEV_AUTH_TOKEN: 't',
  STITCHER_WIDTH: '4096',
} as NodeJS.ProcessEnv);

function fakeWorld(): World {
  return {
    id: 'w-1', ownerId: 'user-1', title: null, caption: null, lat: null, lng: null,
    placeName: null, isPublic: false, status: 'stitching', phase: null, progress: null,
    panoUrl: null,
    thumbnailUrl: null, spz100kUrl: null, spz500kUrl: null, spzFullUrl: null,
    colliderGlbUrl: null, assetVersion: 1, provider: null, draftWorldId: null,
    hqWorldId: null, draftModel: null, hqModel: null, creditsSpent: 0,
    createdAt: new Date('2026-07-12T10:00:00Z'),
    updatedAt: new Date('2026-07-12T10:00:00Z'), deletedAt: null,
  };
}

function fakeCapture(frameCount: number, posesJson: unknown): Capture {
  return {
    id: 'cap-1', worldId: 'w-1', frameCount, posesJson,
    r2FramesPrefix: 'captures/cap-1', createdAt: new Date('2026-07-12T10:00:00Z'),
  } as Capture;
}

interface Sink {
  updates: { table: unknown; patch: Record<string, unknown> }[];
  inserts: { table: unknown; vals: Record<string, unknown> }[];
  executes: number;
  /** Writes made on the transaction handle (status flips / job kinds). */
  txWrites?: string[];
}

function makeStitchDb(world: World, capture: Capture, sink: Sink) {
  const db = {
    // Finalize flips + enqueues in one transaction (§10 R27). The tx handle is
    // this db with its writes also recorded in sink.txWrites.
    transaction: async <T>(cb: (tx: unknown) => Promise<T>): Promise<T> =>
      cb({
        update: (table: unknown) => ({
          set: (patch: Record<string, unknown>) => {
            (sink.txWrites ??= []).push(`update:${String(patch['status'])}`);
            return db.update(table).set(patch);
          },
        }),
        insert: (table: unknown) => ({
          values: (vals: Record<string, unknown>) => {
            (sink.txWrites ??= []).push(`insert:${String(vals['kind'])}`);
            return db.insert(table).values(vals);
          },
        }),
      }),
    select: () => ({
      from: (table: unknown) => {
        const rows = table === worlds ? [world] : table === captures ? [capture] : [];
        const chain = { where: () => chain, orderBy: () => chain, limit: async () => rows };
        return chain;
      },
    }),
    update: (table: unknown) => ({
      set: (patch: Record<string, unknown>) => ({
        // `where()` is awaited directly by some call sites and chained with
        // `.returning()` by the conditional (idempotent) finalizes — support both.
        where: () => {
          sink.updates.push({ table, patch });
          const rows = [{ id: 'w-1' }];
          return Object.assign(Promise.resolve(rows), { returning: async () => rows });
        },
      }),
    }),
    insert: (table: unknown) => ({
      values: (vals: Record<string, unknown>) => ({
        returning: async () => { sink.inserts.push({ table, vals }); return [{ id: 'job-x' }]; },
      }),
    }),
    execute: async () => { sink.executes += 1; },
  };
  return db;
}

function fakeStorage() {
  const puts: string[] = [];
  const gets: string[] = [];
  const storage = {
    kind: 'local',
    presignUpload: vi.fn(),
    presignDownload: vi.fn(),
    putObject: vi.fn(async (key: string) => { puts.push(key); }),
    getObject: vi.fn(async (key: string) => { gets.push(key); return Buffer.from(`bytes:${key}`); }),
    deleteObject: vi.fn(),
    objectSize: vi.fn(async () => 1024),
  } as unknown as StorageDriver;
  return { storage, puts, gets };
}

/** Spawner mock that writes dummy pano/preview files so the handler can read them. */
function fakeSpawner(): StitcherSpawner & { calls: string[][] } {
  const calls: string[][] = [];
  const fn = (async (_bin: string, args: string[]) => {
    calls.push(args);
    const out = args[args.indexOf('--out') + 1]!;
    await writeFile(out, Buffer.from('PANOBYTES'));
    const pv = args.indexOf('--preview-out');
    if (pv >= 0) await writeFile(args[pv + 1]!, Buffer.from('PREVIEWBYTES'));
    return { code: 0, stdout: 'coverage 90%', stderr: '', timedOut: false };
  }) as StitcherSpawner & { calls: string[][] };
  fn.calls = calls;
  return fn;
}

const stitchJob = { id: 'job-1', kind: 'stitch', worldId: 'w-1' } as unknown as Job;

function deps(db: unknown, storage: StorageDriver, stitcher: StitcherSpawner): WorkerDeps {
  return {
    db: db as WorkerDeps['db'],
    storage,
    provider: {} as WorkerDeps['provider'],
    config: stitchConfig,
    push: (async () => undefined) as unknown as WorkerDeps['push'],
    stitcher,
  };
}

describe('handleStitch dispatch', () => {
  it('frame_count 1 → passthrough: copies the frame, never spawns Python', async () => {
    const sink: Sink = { updates: [], inserts: [], executes: 0 };
    const db = makeStitchDb(fakeWorld(), fakeCapture(1, null), sink);
    const { storage, puts, gets } = fakeStorage();
    const spawner = fakeSpawner();

    await handleStitch(deps(db, storage, spawner), stitchJob);

    expect(spawner.calls).toHaveLength(0); // no stitcher subprocess
    expect(gets).toEqual(['captures/cap-1/frame_0.heic']);
    expect(puts).toEqual(['worlds/w-1/pano.jpg']);
    // Advanced to generating_draft + enqueued generate_draft + completed.
    expect(sink.updates.some((u) => u.patch['status'] === 'generating_draft')).toBe(true);
    expect(sink.inserts.some((i) => i.vals['kind'] === 'generate_draft')).toBe(true);
    expect(sink.executes).toBe(1);
    // §10 R27: the flip and the draft job are written in ONE transaction, so a
    // crash between them cannot strand the world in generating_draft.
    expect(sink.txWrites).toEqual(['update:generating_draft', 'insert:generate_draft']);
  });

  it('multi-frame WITH poses → spawns with --poses, uploads pano + preview', async () => {
    const sink: Sink = { updates: [], inserts: [], executes: 0 };
    const poses = [
      { index: 0, transform: Array(16).fill(0), intrinsics: Array(9).fill(1) },
      { index: 1, transform: Array(16).fill(0), intrinsics: Array(9).fill(1) },
    ];
    const db = makeStitchDb(fakeWorld(), fakeCapture(3, poses), sink);
    const { storage, puts, gets } = fakeStorage();
    const spawner = fakeSpawner();

    await handleStitch(deps(db, storage, spawner), stitchJob);

    expect(spawner.calls).toHaveLength(1);
    const args = spawner.calls[0]!;
    expect(args).toContain('--poses');
    expect(args).toContain('--frames-dir');
    expect(args[args.indexOf('--width') + 1]).toBe('4096');
    // Downloaded all 3 frames.
    expect(gets).toEqual([
      'captures/cap-1/frame_0.heic',
      'captures/cap-1/frame_1.heic',
      'captures/cap-1/frame_2.heic',
    ]);
    // Uploaded pano and preview.
    expect(puts).toContain('worlds/w-1/pano.jpg');
    expect(puts).toContain('worlds/w-1/pano_preview.jpg');
    expect(sink.updates.some((u) => u.patch['status'] === 'generating_draft')).toBe(true);
    expect(sink.inserts.some((i) => i.vals['kind'] === 'generate_draft')).toBe(true);
  });

  it('multi-frame WITHOUT poses → spawns WITHOUT --poses (nominal fallback)', async () => {
    const sink: Sink = { updates: [], inserts: [], executes: 0 };
    const db = makeStitchDb(fakeWorld(), fakeCapture(2, null), sink);
    const { storage } = fakeStorage();
    const spawner = fakeSpawner();

    await handleStitch(deps(db, storage, spawner), stitchJob);

    expect(spawner.calls).toHaveLength(1);
    expect(spawner.calls[0]).not.toContain('--poses');
  });

  it('stitcher non-zero exit → throws retryable (does not advance the world)', async () => {
    const sink: Sink = { updates: [], inserts: [], executes: 0 };
    const db = makeStitchDb(fakeWorld(), fakeCapture(2, null), sink);
    const { storage } = fakeStorage();
    const failing: StitcherSpawner = async () => ({
      code: 1, stdout: '', stderr: 'boom: out of memory', timedOut: false,
    });

    await expect(handleStitch(deps(db, storage, failing), stitchJob)).rejects.toThrow(/boom/);
    // Not a NonRetryableJobError → the loop's handleJobError will retry it.
    expect(sink.updates.some((u) => u.patch['status'] === 'generating_draft')).toBe(false);
  });
});

// --- stitcher failure classification (spec §10 R8) ---------------------------

describe('stitcherExitCode', () => {
  it('passes a real exit code through', () => {
    expect(stitcherExitCode(0, null)).toBe(0);
    expect(stitcherExitCode(2, null)).toBe(2);
  });

  it('maps a reaping signal to 128 + signum so SIGKILL reads as 137', () => {
    // Node reports code: null when a signal reaps the child. Without this the
    // OOM-killer's fingerprint is erased and every OOM looks like a generic -1.
    expect(stitcherExitCode(null, 'SIGKILL')).toBe(STITCHER_EXIT_OOM_KILLED);
    expect(stitcherExitCode(null, 'SIGTERM')).toBe(143);
  });

  it('falls back to -1 when there is neither a code nor a known signal', () => {
    expect(stitcherExitCode(null, null)).toBe(-1);
  });
});

describe('classifyStitcherFailure', () => {
  it('input error (exit 2) is non-retryable on the FIRST attempt', () => {
    const err = classifyStitcherFailure(STITCHER_EXIT_INPUT_ERROR, 1, 'bad frame');
    expect(err).toBeInstanceOf(NonRetryableJobError);
    expect(err.message).toContain('unusable capture input');
  });

  it('OOM-kill is retryable once, then non-retryable', () => {
    const first = classifyStitcherFailure(STITCHER_EXIT_OOM_KILLED, 1, 'killed');
    expect(first).not.toBeInstanceOf(NonRetryableJobError);

    const second = classifyStitcherFailure(STITCHER_EXIT_OOM_KILLED, 2, 'killed');
    expect(second).toBeInstanceOf(NonRetryableJobError);
    expect(second.message).toContain('OOM-killed on attempt 2');
  });

  it('an internal error (exit 1) stays retryable even late', () => {
    // Transient disk/memory pressure can genuinely clear on a re-run, so exit 1
    // keeps the queue's normal backoff until MAX_ATTEMPTS parks it.
    const err = classifyStitcherFailure(1, 5, 'transient boom');
    expect(err).not.toBeInstanceOf(NonRetryableJobError);
    expect(err.message).toContain('transient boom');
  });

  it('classifies by code, never by message text', () => {
    // A message that merely MENTIONS memory must not be treated as an OOM.
    const err = classifyStitcherFailure(1, 3, 'boom: out of memory');
    expect(err).not.toBeInstanceOf(NonRetryableJobError);
  });
});

describe('classifyStitcherTimeout', () => {
  it('is retryable once, then non-retryable', () => {
    expect(classifyStitcherTimeout(1000, 1)).not.toBeInstanceOf(NonRetryableJobError);
    const parked = classifyStitcherTimeout(1000, STITCH_RESOURCE_MAX_ATTEMPTS);
    expect(parked).toBeInstanceOf(NonRetryableJobError);
    expect(parked.message).toContain('timed out after 1000ms');
  });
});

describe('handleStitch failure classification', () => {
  const jobWithAttempts = (attempts: number) =>
    ({ id: 'job-1', kind: 'stitch', worldId: 'w-1', attempts }) as unknown as Job;

  async function runFailing(
    run: { code: number; timedOut?: boolean; stderr?: string },
    attempts: number,
  ) {
    const sink: Sink = { updates: [], inserts: [], executes: 0 };
    const db = makeStitchDb(fakeWorld(), fakeCapture(2, null), sink);
    const { storage } = fakeStorage();
    const failing: StitcherSpawner = async () => ({
      code: run.code,
      stdout: '',
      stderr: run.stderr ?? 'stderr tail',
      timedOut: run.timedOut ?? false,
    });
    const err = await handleStitch(deps(db, storage, failing), jobWithAttempts(attempts)).then(
      () => null,
      (e: unknown) => e,
    );
    return { err, sink };
  }

  it('an undecodable frame (exit 2) parks the job immediately', async () => {
    const { err, sink } = await runFailing({ code: STITCHER_EXIT_INPUT_ERROR }, 1);
    expect(err).toBeInstanceOf(NonRetryableJobError);
    expect(sink.updates.some((u) => u.patch['status'] === 'generating_draft')).toBe(false);
  });

  it('an OOM-kill (137) retries once then parks', async () => {
    expect((await runFailing({ code: STITCHER_EXIT_OOM_KILLED }, 1)).err).not.toBeInstanceOf(
      NonRetryableJobError,
    );
    expect((await runFailing({ code: STITCHER_EXIT_OOM_KILLED }, 2)).err).toBeInstanceOf(
      NonRetryableJobError,
    );
  });

  it('a timeout retries once then parks', async () => {
    expect(
      (await runFailing({ code: 137, timedOut: true }, 1)).err,
    ).not.toBeInstanceOf(NonRetryableJobError);
    const late = await runFailing({ code: 137, timedOut: true }, 2);
    expect(late.err).toBeInstanceOf(NonRetryableJobError);
    expect((late.err as Error).message).toContain('timed out');
  });
});

// --- optional LiDAR depth (spec §5.2 items 2 + 4) ----------------------------

describe('handleStitch depth maps', () => {
  const PNG = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    Buffer.from('depthdata'),
  ]);
  const pose = (index: number, depth?: { width: number; height: number }) => ({
    index, transform: Array(16).fill(0), intrinsics: Array(9).fill(1),
    ...(depth ? { depth } : {}),
  });

  /** Storage backed by a key → bytes map; objectSize may be overridden per key. */
  function mapStorage(objects: Record<string, Buffer>, sizes: Record<string, number> = {}) {
    const gets: string[] = [];
    const storage = {
      kind: 'local',
      presignUpload: vi.fn(),
      presignDownload: vi.fn(),
      putObject: vi.fn(),
      getObject: vi.fn(async (key: string) => {
        gets.push(key);
        const b = objects[key];
        if (!b) throw new Error('NoSuchKey');
        return b;
      }),
      deleteObject: vi.fn(),
      objectSize: vi.fn(async (key: string) => {
        if (key in sizes) return sizes[key]!;
        const b = objects[key];
        if (!b) throw new Error('NoSuchKey');
        return b.length;
      }),
    } as unknown as StorageDriver;
    return { storage, gets };
  }

  /** Records argv and the staged depth dir's contents at spawn time (the work
   * dir is deleted once the handler returns). */
  function recordingSpawner() {
    const seen: { args: string[]; depthFiles: Record<string, Buffer> | null } = {
      args: [], depthFiles: null,
    };
    const inner = fakeSpawner();
    const fn: StitcherSpawner = async (bin, args, t, onStdout) => {
      seen.args = args;
      const i = args.indexOf('--depth-dir');
      if (i >= 0) {
        const dir = args[i + 1]!;
        seen.depthFiles = {};
        for (const f of await readdir(dir)) seen.depthFiles[f] = await readFile(path.join(dir, f));
      }
      return inner(bin, args, t, onStdout);
    };
    return { fn, seen };
  }

  const frames = (n: number) =>
    Object.fromEntries(
      Array.from({ length: n }, (_v, i) => [`captures/cap-1/frame_${i}.heic`, Buffer.from('jpg')]),
    );

  it('stages valid depth maps and passes --depth-dir; skips missing/invalid/oversize', async () => {
    const sink: Sink = { updates: [], inserts: [], executes: 0 };
    const d = { width: 256, height: 192 };
    const poses = [pose(0, d), pose(1, d), pose(2, d), pose(3, d), pose(4)];
    const db = makeStitchDb(fakeWorld(), fakeCapture(5, poses), sink);
    const { storage, gets } = mapStorage(
      {
        ...frames(5),
        'captures/cap-1/depth_0.png': PNG, // valid
        // depth_1 missing
        'captures/cap-1/depth_2.png': Buffer.from('not a png at all'),
        'captures/cap-1/depth_3.png': PNG,
        'captures/cap-1/depth_4.png': PNG, // pose 4 has no `depth` → never read
      },
      { 'captures/cap-1/depth_3.png': 1024 * 1024 + 1 },
    );
    const { fn, seen } = recordingSpawner();
    const log = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    await handleStitch(deps(db, storage, fn), stitchJob);

    expect(Object.keys(seen.depthFiles ?? {})).toEqual(['depth_0.png']);
    expect(seen.depthFiles!['depth_0.png']!.equals(PNG)).toBe(true);
    expect(gets).not.toContain('captures/cap-1/depth_3.png'); // oversize never read
    expect(gets).not.toContain('captures/cap-1/depth_4.png');
    expect(log).toHaveBeenCalledTimes(3);
    expect(sink.updates.some((u) => u.patch['status'] === 'generating_draft')).toBe(true);
    log.mockRestore();
  });

  it('every depth map unusable → no --depth-dir, job still succeeds', async () => {
    const sink: Sink = { updates: [], inserts: [], executes: 0 };
    const poses = [pose(0, { width: 256, height: 192 }), pose(1, { width: 256, height: 192 })];
    const db = makeStitchDb(fakeWorld(), fakeCapture(2, poses), sink);
    const { storage } = mapStorage(frames(2));
    const { fn, seen } = recordingSpawner();
    const log = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    await handleStitch(deps(db, storage, fn), stitchJob);

    expect(seen.args).not.toContain('--depth-dir');
    expect(sink.updates.some((u) => u.patch['status'] === 'generating_draft')).toBe(true);
    log.mockRestore();
  });

  it('no depth fields → no depth reads, no --depth-dir', async () => {
    const sink: Sink = { updates: [], inserts: [], executes: 0 };
    const db = makeStitchDb(fakeWorld(), fakeCapture(2, [pose(0), pose(1)]), sink);
    const { storage, gets } = mapStorage(frames(2));
    const { fn, seen } = recordingSpawner();

    await handleStitch(deps(db, storage, fn), stitchJob);

    expect(seen.args).not.toContain('--depth-dir');
    expect(gets.some((k) => k.includes('depth_'))).toBe(false);
  });
});

// --- purge removes depth maps with the frames (spec §5.2 item 4) -------------

describe('purge deletes depth keys', () => {
  function purgeDeps(deleted: string[]): WorkerDeps {
    const caps = [{ id: 'cap-1', worldId: 'w-1', frameCount: 2, r2FramesPrefix: 'captures/cap-1' }];
    const db = {
      select: () => ({ from: () => ({ where: async () => caps }) }),
      update: () => ({ set: () => ({ where: async () => undefined }) }),
      execute: async () => undefined,
    };
    const storage = {
      deleteObject: vi.fn(async (k: string) => { deleted.push(k); }),
    } as unknown as StorageDriver;
    return {
      db: db as unknown as WorkerDeps['db'],
      storage,
      provider: {} as WorkerDeps['provider'],
      config: stitchConfig,
      push: (async () => undefined) as unknown as WorkerDeps['push'],
    };
  }
  const captureKeys = [
    'captures/cap-1/frame_0.heic',
    'captures/cap-1/depth_0.png',
    'captures/cap-1/frame_1.heic',
    'captures/cap-1/depth_1.png',
  ];

  it('full purge', async () => {
    const deleted: string[] = [];
    await processJob(purgeDeps(deleted), { id: 'j', kind: 'purge', worldId: 'w-1', payload: null } as never);
    expect(deleted).toEqual(expect.arrayContaining(captureKeys));
    expect(deleted.some((k) => k.startsWith('worlds/w-1/'))).toBe(true);
  });

  it('framesOnly (reaper) purge', async () => {
    const deleted: string[] = [];
    await processJob(
      purgeDeps(deleted),
      { id: 'j', kind: 'purge', worldId: 'w-1', payload: { framesOnly: true } } as never,
    );
    expect(deleted).toEqual(captureKeys);
  });
});
