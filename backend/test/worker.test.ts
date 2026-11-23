import { describe, it, expect, vi } from 'vitest';
import { processJob, type WorkerDeps } from '../src/worker.js';
import { loadConfig } from '../src/config.js';
import type { StorageDriver } from '../src/storage/index.js';

// --- purge removes capture frames and world assets ----------------------------

const config = loadConfig({
  DATABASE_URL: 'postgres://u:p@localhost:5432/db',
  DEV_AUTH_TOKEN: 't',
} as NodeJS.ProcessEnv);

describe('purge', () => {
  function purgeDeps(deleted: string[]): WorkerDeps {
    const caps = [{ id: 'cap-1', worldId: 'w-1', frameCount: 2, r2FramesPrefix: 'captures/cap-1' }];
    const db = {
      select: () => ({ from: () => ({ where: async () => caps }) }),
      update: () => ({ set: () => ({ where: async () => undefined }) }),
      execute: async () => undefined,
    };
    const storage = {
      list: vi.fn(async (p: string) => STORED.filter((k) => k.startsWith(p)).map((key) => ({ key, size: 1 }))),
      deleteObject: vi.fn(async (k: string) => { deleted.push(k); }),
    } as unknown as StorageDriver;
    return {
      db: db as unknown as WorkerDeps['db'],
      storage,
      config,
      push: (async () => undefined) as unknown as WorkerDeps['push'],
    };
  }
  const captureKeys = [
    'captures/cap-1/session.json',
    'captures/cap-1/frames.jsonl',
    'captures/cap-1/frames/000001.jpg',
    'bundles/cap-1/capture_bundle.zip',
  ];
  const worldKeys = ['worlds/w-1/v1/splat.spz', 'worlds/w-1/v1/collider.ply'];
  // cap-10 / w-10 share a string prefix and must survive (trailing-slash prefixes).
  const STORED = [...captureKeys, ...worldKeys, 'captures/cap-10/session.json', 'worlds/w-10/v1/splat.spz'];

  it('full purge', async () => {
    const deleted: string[] = [];
    await processJob(purgeDeps(deleted), { id: 'j', kind: 'purge', worldId: 'w-1', payload: null } as never);
    expect(deleted.sort()).toEqual([...captureKeys, ...worldKeys].sort());
  });

  it('framesOnly (reaper) purge', async () => {
    const deleted: string[] = [];
    await processJob(
      purgeDeps(deleted),
      { id: 'j', kind: 'purge', worldId: 'w-1', payload: { framesOnly: true } } as never,
    );
    expect(deleted.sort()).toEqual([...captureKeys].sort());
  });

  it('rejects any non-purge job kind as non-retryable', async () => {
    await expect(
      processJob(purgeDeps([]), { id: 'j', kind: 'stale_kind', worldId: 'w-1', payload: null } as never),
    ).rejects.toMatchObject({ name: 'NonRetryableJobError' });
  });
});
