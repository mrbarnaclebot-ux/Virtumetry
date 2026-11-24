import { describe, it, expect, vi } from 'vitest';
import { DOWNLOAD_TTL_SECONDS, serializeWorldDetail, serializeWorldListItem } from '../src/routes/worlds.js';
import type { World } from '../src/db/schema.js';
import type { StorageDriver } from '../src/storage/index.js';

// GET /v1/worlds/:id contract (research Pitfall 1): the detail carries
// world.floorplan_meta for the Plan panel; the list never does.

const META = {
  version: 1,
  coordinate_system: 'spaitial-world-v1',
  image: { width_px: 200, height_px: 250, world_xz_from_pixel: [[0.02, 0, -2], [0, 0.02, -2.5], [0, 0, 1]] },
};

function fakeWorld(overrides: Partial<World> = {}): World {
  return {
    id: 'w-1',
    ownerId: 'u-1',
    title: 'Demo room',
    status: 'ready',
    splatKey: 'worlds/w-1/v1/splat.ply',
    colliderKey: null,
    floorplanKey: null,
    camerasKey: null,
    thumbnailKey: 'worlds/w-1/v1/thumbnail.jpg',
    floorplanMeta: META,
    assetVersion: 1,
    createdAt: new Date('2026-11-24T10:00:00Z'),
    updatedAt: new Date('2026-11-24T11:00:00Z'),
    deletedAt: null,
    ...overrides,
  } as World;
}

function mockStorage() {
  return {
    kind: 'local',
    presignDownload: vi.fn(async (key: string) => `https://signed.example/${key}`),
  } as unknown as StorageDriver & { presignDownload: ReturnType<typeof vi.fn> };
}

describe('serializeWorldDetail', () => {
  it('returns world.floorplan_meta equal to the stored jsonb', async () => {
    const body = await serializeWorldDetail(fakeWorld(), mockStorage());
    expect(body.world.floorplan_meta).toEqual(META);
  });

  it('returns floorplan_meta: null when absent', async () => {
    const body = await serializeWorldDetail(fakeWorld({ floorplanMeta: null }), mockStorage());
    expect(body.world).toHaveProperty('floorplan_meta', null);
  });

  it('presigns thumbnail_url and the other set assets', async () => {
    const storage = mockStorage();
    const body = await serializeWorldDetail(fakeWorld(), storage);
    expect(body.assets).toEqual({
      splat_url: 'https://signed.example/worlds/w-1/v1/splat.ply',
      thumbnail_url: 'https://signed.example/worlds/w-1/v1/thumbnail.jpg',
    });
    expect(storage.presignDownload).toHaveBeenCalledWith('worlds/w-1/v1/thumbnail.jpg', DOWNLOAD_TTL_SECONDS);
  });
});

describe('list items stay lean', () => {
  it('never carry floorplan_meta', async () => {
    const item = await serializeWorldListItem(fakeWorld(), mockStorage());
    expect(item).not.toHaveProperty('floorplan_meta');
  });
});
