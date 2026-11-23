import { describe, it, expect, vi } from 'vitest';
import { serializeWorldListItem } from '../src/routes/worlds.js';
import type { World } from '../src/db/schema.js';
import type { StorageDriver } from '../src/storage/index.js';

// GET /v1/worlds list-item contract (iOS Library screen): every item carries
// an `assets` object with ONLY thumbnail_url — presigned when the key column
// is set, absent otherwise. Heavy asset fields are never presigned in a list.

function fakeWorld(overrides: Partial<World> = {}): World {
  return {
    id: 'w-1',
    ownerId: 'u-1',
    title: 'Kloofendal',
    caption: null,
    lat: null,
    lng: null,
    placeName: null,
    isPublic: false,
    status: 'draft_ready',
    phase: null,
    progress: null,
    panoUrl: null,
    thumbnailUrl: null,
    spz100kUrl: null,
    spz500kUrl: null,
    spzFullUrl: null,
    colliderGlbUrl: null,
    assetVersion: 1,
    provider: null,
    draftWorldId: null,
    hqWorldId: null,
    draftModel: null,
    hqModel: null,
    creditsSpent: 0,
    createdAt: new Date('2026-07-12T10:00:00Z'),
    updatedAt: new Date('2026-07-12T11:00:00Z'),
    deletedAt: null,
    ...overrides,
  };
}

function mockStorage(): StorageDriver & { presignDownload: ReturnType<typeof vi.fn> } {
  return {
    kind: 'local',
    presignUpload: vi.fn(),
    presignDownload: vi.fn(async (key: string) => `https://signed.example/${key}`),
    putObject: vi.fn(),
    getObject: vi.fn(),
    deleteObject: vi.fn(),
  } as unknown as StorageDriver & { presignDownload: ReturnType<typeof vi.fn> };
}

describe('serializeWorldListItem', () => {
  it('includes assets.thumbnail_url (presigned) when the thumbnail key is set', async () => {
    const storage = mockStorage();
    const item = await serializeWorldListItem(
      fakeWorld({ thumbnailUrl: 'worlds/w-1/thumbnail.jpg' }),
      storage,
    );

    expect(item.assets).toEqual({
      thumbnail_url: 'https://signed.example/worlds/w-1/thumbnail.jpg',
    });
    // Presigned with the shared TTL used by the detail route.
    expect(storage.presignDownload).toHaveBeenCalledWith('worlds/w-1/thumbnail.jpg', 3600);
    // serializeWorld fields ride along unchanged.
    expect(item.id).toBe('w-1');
    expect(item.title).toBe('Kloofendal');
    expect(item.status).toBe('draft_ready');
  });

  it('has an empty assets object (no thumbnail_url key) when unset', async () => {
    const storage = mockStorage();
    const item = await serializeWorldListItem(fakeWorld(), storage);

    expect(item.assets).toEqual({});
    expect(item.assets).not.toHaveProperty('thumbnail_url');
    expect(storage.presignDownload).not.toHaveBeenCalled();
  });

  it('never presigns heavy asset fields in list context, even when set', async () => {
    const storage = mockStorage();
    const item = await serializeWorldListItem(
      fakeWorld({
        thumbnailUrl: 'worlds/w-1/thumbnail.jpg',
        panoUrl: 'worlds/w-1/pano.jpg',
        spz100kUrl: 'worlds/w-1/splat_100k.spz',
        spz500kUrl: 'worlds/w-1/splat_500k.spz',
        spzFullUrl: 'worlds/w-1/splat_full.spz',
        colliderGlbUrl: 'worlds/w-1/collider.glb',
      }),
      storage,
    );

    // Exactly one presign call — the thumbnail — regardless of other columns.
    expect(storage.presignDownload).toHaveBeenCalledTimes(1);
    expect(item.assets).toEqual({
      thumbnail_url: 'https://signed.example/worlds/w-1/thumbnail.jpg',
    });
  });
});
