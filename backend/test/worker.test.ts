import { describe, it, expect, vi } from 'vitest';
import { processJob, type WorkerDeps } from '../src/worker.js';
import { MODEL_CREDITS } from '../src/provider/index.js';
import { createMockProvider } from '../src/provider/mock.js';
import { loadConfig } from '../src/config.js';
import type { StorageDriver } from '../src/storage/index.js';

// --- mock generations are FREE ------------------------------------------------
// PROVIDER_MODE=mock must not eat the daily budget or inflate spend metrics.
describe('mock provider billing', () => {
  it('creditsForModel returns 0 for every model (draft and hq)', () => {
    const provider = createMockProvider();
    expect(provider.creditsForModel('marble-1.0-draft')).toBe(0);
    expect(provider.creditsForModel('marble-1.1')).toBe(0);
  });

  it('real provider costs are unchanged (draft 150 / hq 1500)', () => {
    expect(MODEL_CREDITS['marble-1.0-draft']).toBe(150);
    expect(MODEL_CREDITS['marble-1.1']).toBe(1500);
  });
});

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
      deleteObject: vi.fn(async (k: string) => { deleted.push(k); }),
    } as unknown as StorageDriver;
    return {
      db: db as unknown as WorkerDeps['db'],
      storage,
      config,
      push: (async () => undefined) as unknown as WorkerDeps['push'],
    };
  }
  const captureKeys = ['captures/cap-1/frame_0.heic', 'captures/cap-1/frame_1.heic'];

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

  it('rejects any non-purge job kind as non-retryable', async () => {
    await expect(
      processJob(purgeDeps([]), { id: 'j', kind: 'stale_kind', worldId: 'w-1', payload: null } as never),
    ).rejects.toMatchObject({ name: 'NonRetryableJobError' });
  });
});
