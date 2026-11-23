import { describe, it, expect } from 'vitest';
import { gunzipSync } from 'node:zlib';
import { createMockProvider } from '../src/provider/mock.js';

// Mock asset fixtures must be realistic enough for UI dev work (simulator QA:
// AsyncImage showed the empty placeholder for text stubs). Assert real magic
// bytes per format.

async function mintedAssets() {
  const provider = createMockProvider();
  const opId = await provider.generateWorld('ma-1', 'marble-1.0-draft', 'W');
  const { worldId } = await provider.getOperation(opId);
  const assets = await provider.getWorld(worldId!);
  return { provider, assets };
}

describe('mock provider asset fixtures', () => {
  it('thumbnail download is a real JPEG (FF D8 magic, JFIF, <2 KB)', async () => {
    const { provider, assets } = await mintedAssets();
    const bytes = await provider.downloadAsset(assets.thumbnailUrl!);
    expect(bytes[0]).toBe(0xff);
    expect(bytes[1]).toBe(0xd8); // JPEG SOI marker.
    expect(bytes.subarray(6, 10).toString('ascii')).toBe('JFIF');
    expect(bytes.byteLength).toBeLessThan(2048);
    // Any .jpg served from the mock host (incl. a pano URL from a resumed
    // world minted in a prior process) gets the same JPEG bytes.
    const pano = await provider.downloadAsset(
      'https://mock.worldlabs.local/worlds/w-x/pano.jpg',
    );
    expect(pano.equals(bytes)).toBe(true);
  });

  it('spz download is gzip whose decompressed bytes start with the SPZ magic "NGSP"', async () => {
    const { provider, assets } = await mintedAssets();
    for (const url of [assets.spzUrls.k100!, assets.spzUrls.k500!, assets.spzUrls.full!]) {
      const bytes = await provider.downloadAsset(url);
      expect(bytes[0]).toBe(0x1f); // gzip magic.
      expect(bytes[1]).toBe(0x8b);
      const inflated = gunzipSync(bytes);
      expect(inflated.subarray(0, 4).toString('ascii')).toBe('NGSP');
    }
  });

  it('collider download starts with the GLB magic "glTF"', async () => {
    const { provider, assets } = await mintedAssets();
    const bytes = await provider.downloadAsset(assets.colliderMeshUrl!);
    expect(bytes.subarray(0, 4).toString('ascii')).toBe('glTF');
    expect(bytes.readUInt32LE(4)).toBe(2); // glTF container version.
  });

  it('rejects downloads for non-mock hosts', async () => {
    const { provider } = await mintedAssets();
    await expect(
      provider.downloadAsset('https://evil.example/x.jpg'),
    ).rejects.toMatchObject({ name: 'ProviderError' });
  });
});
