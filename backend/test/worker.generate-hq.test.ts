import { describe, it, expect, vi } from 'vitest';
import type { Job } from '../src/db/schema.js';
import { worlds, type World } from '../src/db/schema.js';
import type { Db } from '../src/db/client.js';
import { processJob, type WorkerDeps } from '../src/worker.js';
import { loadConfig } from '../src/config.js';
import type { StorageDriver } from '../src/storage/index.js';
import type { WorldGenProvider } from '../src/provider/index.js';

// The `generate_hq` finalize (spec §7 state machine): what a finished HQ pass
// writes onto the world row, and what the enhance flow depends on the client
// seeing afterwards.

// DAILY_CREDIT_BUDGET is set to the PRODUCTION value (now also the default).
// A budget below one marble-1.1 generation (1500) makes every enhance die in
// reserveCredits before it reaches the provider — see the budget-exceeded test.
const config = loadConfig({
  DATABASE_URL: 'postgres://u:p@localhost:5432/db',
  DEV_AUTH_TOKEN: 't',
  DAILY_CREDIT_BUDGET: '2000',
} as NodeJS.ProcessEnv);

// The pre-R18 default, smaller than one HQ.
const tooSmallBudgetConfig = loadConfig({
  DATABASE_URL: 'postgres://u:p@localhost:5432/db',
  DEV_AUTH_TOKEN: 't',
  DAILY_CREDIT_BUDGET: '500',
} as NodeJS.ProcessEnv);

function fakeWorld(overrides: Partial<World> = {}): World {
  return {
    id: 'w-1', ownerId: 'user-1', title: null, caption: null, lat: null, lng: null,
    placeName: null, isPublic: false, status: 'generating_hq', phase: null, progress: null,
    panoUrl: 'worlds/w-1/pano.jpg', thumbnailUrl: 'worlds/w-1/thumbnail.jpg',
    spz100kUrl: null, spz500kUrl: 'worlds/w-1/splat_500k.spz',
    spzFullUrl: null, colliderGlbUrl: null, assetVersion: 1, provider: 'worldlabs',
    draftWorldId: 'provider-draft', hqWorldId: null,
    draftModel: 'marble-1.0-draft', hqModel: null, creditsSpent: 150,
    createdAt: new Date('2026-07-12T10:00:00Z'),
    updatedAt: new Date('2026-07-12T10:00:00Z'), deletedAt: null,
    ...overrides,
  };
}

interface Sink {
  updates: { table: unknown; patch: Record<string, unknown> }[];
  pushes: string[];
}

function makeDb(world: World, sink: Sink): Db {
  return {
    select: () => ({
      from: (table: unknown) => {
        const rows = table === worlds ? [world] : [];
        const chain = {
          where: () => chain,
          orderBy: () => chain,
          limit: async () => rows,
          then: (res: (v: unknown) => void) => res(rows),
        };
        return chain;
      },
    }),
    update: (table: unknown) => ({
      set: (patch: Record<string, unknown>) => ({
        where: () => {
          sink.updates.push({ table, patch });
          const rows = [{ id: world.id }];
          return Object.assign(Promise.resolve(rows), { returning: async () => rows });
        },
      }),
    }),
    insert: () => ({ values: () => ({ returning: async () => [{ id: 'job-x' }] }) }),
    transaction: async (cb: (tx: unknown) => Promise<void>) => {
      await cb({
        execute: async () => ({ rows: [{ total: 0 }] }),
        insert: () => ({ values: async () => undefined }),
      });
    },
    execute: async () => ({ rows: [{ id: 'job-1' }] }),
  } as unknown as Db;
}

function makeDeps(db: Db, sink: Sink, cfg = config): WorkerDeps {
  const storage = {
    kind: 'local',
    presignUpload: vi.fn(),
    presignDownload: vi.fn(),
    putObject: vi.fn(async () => undefined),
    getObject: vi.fn(async (key: string) => Buffer.from(`bytes:${key}`)),
    deleteObject: vi.fn(),
    objectSize: vi.fn(async () => 1024),
  } as unknown as StorageDriver;

  const provider = {
    mode: 'live',
    creditsForModel: (m: string) => (m === 'marble-1.1' ? 1500 : 150),
    uploadPano: vi.fn(async () => 'media-1'),
    generateWorld: vi.fn(async () => 'op-1'),
    getOperation: vi.fn(async () => ({ done: true, worldId: 'provider-hq-1' })),
    getWorld: vi.fn(async () => ({
      spzUrls: { k500: 'u500', k100: 'u100' },
      thumbnailUrl: 'uthumb',
      colliderMeshUrl: 'ucollider',
    })),
    downloadAsset: vi.fn(async () => Buffer.from('bytes')),
    findWorldByDisplayName: vi.fn(async () => null),
  } as unknown as WorldGenProvider;

  return {
    db,
    storage,
    provider,
    config: cfg,
    push: (async (_userId: string, title: string) => {
      sink.pushes.push(title);
    }) as unknown as WorkerDeps['push'],
    clock: { now: () => 0, sleep: async () => undefined },
    workerId: 'worker-A',
  };
}

const hqJob = {
  id: 'job-hq',
  kind: 'generate_hq',
  worldId: 'w-1',
  attempts: 1,
  providerOperationId: null,
} as unknown as Job;

const draftJob = { ...hqJob, id: 'job-draft', kind: 'generate_draft' } as unknown as Job;

describe('generate_hq finalize', () => {
  it('writes complete + HQ provider world + 1500 credits, and BUMPS asset_version', async () => {
    const sink: Sink = { updates: [], pushes: [] };
    await processJob(makeDeps(makeDb(fakeWorld(), sink), sink), hqJob);

    const finalize = sink.updates.find((u) => u.patch['status'] === 'complete');
    expect(finalize).toBeDefined();
    const patch = finalize!.patch;
    expect(patch['hqWorldId']).toBe('provider-hq-1');
    expect(patch['hqModel']).toBe('marble-1.1');
    expect(patch['progress']).toBeNull();
    // Re-hosted onto OUR storage — the same keys the draft used.
    expect(patch['spz500kUrl']).toBe('worlds/w-1/splat_500k.spz');
    expect(patch['thumbnailUrl']).toBe('worlds/w-1/thumbnail.jpg');

    // The HQ bytes land on the draft's keys, so the client's cache key MUST move
    // or every viewer keeps replaying the cached draft splat.
    expect(patch['assetVersion']).toBeDefined();
    expect(sink.pushes).toEqual(['Your world is complete']);
  });

  it('the draft pass does NOT bump asset_version (the draft is version 1)', async () => {
    const sink: Sink = { updates: [], pushes: [] };
    const world = fakeWorld({ status: 'generating_draft', spz500kUrl: null });
    await processJob(makeDeps(makeDb(world, sink), sink), draftJob);

    const finalize = sink.updates.find((u) => u.patch['status'] === 'draft_ready');
    expect(finalize).toBeDefined();
    expect(finalize!.patch['assetVersion']).toBeUndefined();
    expect(sink.pushes).toEqual(['Your draft world is ready']);
  });

  it('a budget that cannot fit marble-1.1 fails the job before the provider is called', async () => {
    const sink: Sink = { updates: [], pushes: [] };
    const deps = makeDeps(makeDb(fakeWorld(), sink), sink, tooSmallBudgetConfig);

    // A 500 budget (the old default) cannot fit one 1500-credit HQ generation.
    // BudgetExceededError is non-retryable: handleJobError parks the job dead
    // and flips the world to `failed_generating_hq`. The API's advisory
    // budgetFits check usually refuses first; this is the authoritative guard.
    await expect(processJob(deps, hqJob)).rejects.toThrow(/daily credit budget exceeded/);
    expect(deps.provider.generateWorld).not.toHaveBeenCalled();
    expect(sink.updates.some((u) => u.patch['status'] === 'complete')).toBe(false);
    expect(sink.pushes).toEqual([]);
  });
});

describe('full_res splat (best-effort tier)', () => {
  function withFullRes(deps: WorkerDeps, download: (url: string) => Promise<Buffer>): WorkerDeps {
    deps.provider.getWorld = vi.fn(async () => ({ spzUrls: { k500: 'u500', full: 'ufull' } }));
    deps.provider.downloadAsset = vi.fn(download);
    return deps;
  }

  it('stores full_res on our storage when the provider returns it', async () => {
    const sink: Sink = { updates: [], pushes: [] };
    const deps = withFullRes(makeDeps(makeDb(fakeWorld(), sink), sink), async () => Buffer.from('b'));
    await processJob(deps, hqJob);

    const patch = sink.updates.find((u) => u.patch['status'] === 'complete')!.patch;
    expect(patch['spzFullUrl']).toBe('worlds/w-1/splat_full.spz');
    expect(deps.storage.putObject).toHaveBeenCalledWith('worlds/w-1/splat_full.spz', expect.anything());
  });

  it('a failed full_res download still completes the job, with spz_full_url null', async () => {
    const sink: Sink = { updates: [], pushes: [] };
    // The draft's full_res key must not survive into the bumped HQ version.
    const world = fakeWorld({ spzFullUrl: 'worlds/w-1/splat_full.spz' });
    const deps = withFullRes(makeDeps(makeDb(world, sink), sink), async (url) => {
      if (url === 'ufull') throw new Error('asset too large');
      return Buffer.from('b');
    });
    await processJob(deps, hqJob);

    const patch = sink.updates.find((u) => u.patch['status'] === 'complete')!.patch;
    expect(patch['spzFullUrl']).toBeNull();
    expect(patch['spz500kUrl']).toBe('worlds/w-1/splat_500k.spz');
    expect(sink.pushes).toEqual(['Your world is complete']);
  });
});
