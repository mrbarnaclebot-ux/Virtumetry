import { randomUUID } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import {
  creditsForModel,
  ProviderError,
  type OperationStatus,
  type WorldAssets,
  type WorldGenProvider,
  type WorldMatch,
  type WorldModel,
} from './types.js';

// Offline provider for PROVIDER_MODE=mock. Burns ZERO credits and makes NO
// network calls, so the whole pipeline (stitch → generate → store) runs end to
// end locally. Operations complete instantly. Asset "downloads" are served from
// a tiny in-memory fixture map keyed by the fake URLs this provider hands out.

const FAKE_HOST = 'https://mock.worldlabs.local';

// --- Fixtures ---------------------------------------------------------------
// Realistic-enough bytes so the iOS app renders them in dev (plain text stubs
// made AsyncImage show its empty placeholder in simulator QA).

/**
 * A REAL 951-byte 64x32 blue→orange gradient JPEG (base64-inlined), generated
 * once via a raw-BMP + `sips` one-off script. Valid JFIF: starts FF D8 and
 * decodes in any image stack. Served for thumbnail AND pano downloads.
 */
const JPEG_FIXTURE = Buffer.from(
  '/9j/4AAQSkZJRgABAQAASABIAAD/4QBMRXhpZgAATU0AKgAAAAgAAYdpAAQAAAABAAAAGgAAAAAAA6ABAAMAAAABAAEAAKAC' +
    'AAQAAAABAAAAQKADAAQAAAABAAAAIAAAAAD/7QA4UGhvdG9zaG9wIDMuMAA4QklNBAQAAAAAAAA4QklNBCUAAAAAABDUHYzZ' +
    'jwCyBOmACZjs+EJ+/8AAEQgAIABAAwEiAAIRAQMRAf/EAB8AAAEFAQEBAQEBAAAAAAAAAAABAgMEBQYHCAkKC//EALUQAAIB' +
    'AwMCBAMFBQQEAAABfQECAwAEEQUSITFBBhNRYQcicRQygZGhCCNCscEVUtHwJDNicoIJChYXGBkaJSYnKCkqNDU2Nzg5OkNE' +
    'RUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6g4SFhoeIiYqSk5SVlpeYmZqio6Slpqeoqaqys7S1tre4ubrCw8TFxsfI' +
    'ycrS09TV1tfY2drh4uPk5ebn6Onq8fLz9PX29/j5+v/EAB8BAAMBAQEBAQEBAQEAAAAAAAABAgMEBQYHCAkKC//EALURAAIB' +
    'AgQEAwQHBQQEAAECdwABAgMRBAUhMQYSQVEHYXETIjKBCBRCkaGxwQkjM1LwFWJy0QoWJDThJfEXGBkaJicoKSo1Njc4OTpD' +
    'REVGR0hJSlNUVVZXWFlaY2RlZmdoaWpzdHV2d3h5eoKDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXG' +
    'x8jJytLT1NXW19jZ2uLj5OXm5+jp6vLz9PX29/j5+v/bAEMAAgICAgICBAICBAYEBAQGCAYGBgYICggICAgICgwKCgoKCgoM' +
    'DAwMDAwMDA4ODg4ODhAQEBAQEhISEhISEhISEv/bAEMBAwMDBQQFCAQECBMNCw0TExMTExMTExMTExMTExMTExMTExMTExMT' +
    'ExMTExMTExMTExMTExMTExMTExMTExMTE//dAAQABP/aAAwDAQACEQMRAD8A+TLTpXTWvUVzNp0rprXqK/ozOep+f5d0Ons+' +
    '1dRZ9q5ez7V1Fn2r8lzrqfeZcdNada6e07VzFp1rp7TtX5LnXU+7y7odPa9q6ez61zFr2rp7PrX5JnXU+8y7of/Q+TLTpXTW' +
    'vUVzNp0rprXqK/ozOep+f5d0Ons+1dRZ9q5ez7V1Fn2r8lzrqfeZcdNada6e07VzFp1rp7TtX5LnXU+7y7odPa9q6ez61zFr' +
    '2rp7PrX5JnXU+8y7of/Z',
  'base64',
);

/**
 * SPZ stub: SPZ files are gzip streams whose decompressed payload starts with
 * the magic "NGSP". This passes byte-sniffing/gzip checks in the pipeline but
 * is NOT Spark-renderable — Stage C viewer tests use a real SPZ fixture.
 */
const SPZ_FIXTURE = gzipSync(
  Buffer.concat([Buffer.from('NGSP'), Buffer.alloc(60, 0)]),
);

/** GLB stub: 12-byte glTF-binary header — magic "glTF", version 2, length. */
const GLB_FIXTURE = (() => {
  const b = Buffer.alloc(12);
  b.write('glTF', 0, 'ascii');
  b.writeUInt32LE(2, 4); // container version
  b.writeUInt32LE(12, 8); // total length (header only)
  return b;
})();

/** Pick the fixture matching an asset URL/filename extension. */
function fixtureFor(url: string): Buffer {
  if (url.endsWith('.spz')) return SPZ_FIXTURE;
  if (url.endsWith('.glb')) return GLB_FIXTURE;
  // .jpg (thumbnail, pano) and anything else image-ish.
  return JPEG_FIXTURE;
}

interface MockState {
  operations: Map<string, string>; // operationId -> worldId
  // display_name -> the world/operation generated under it. Mirrors the live
  // provider's world listing so the §10 R1 reconciliation path (resume from a
  // `pending:<jobId>` marker) is exercised offline.
  byDisplayName: Map<string, WorldMatch>;
}

export function createMockProvider(): WorldGenProvider {
  const state: MockState = { operations: new Map(), byDisplayName: new Map() };
  // Every URL we mint lives here so downloadAsset resolves offline.
  const assetBytes = new Map<string, Buffer>();

  const mintAssetUrl = (worldId: string, name: string): string => {
    const url = `${FAKE_HOST}/worlds/${worldId}/${name}`;
    assetBytes.set(url, fixtureFor(name));
    return url;
  };

  return {
    mode: 'mock',

    // Mock generations are FREE. Cost is a property of the provider (not a
    // PROVIDER_MODE check in the worker): the worker derives BOTH the
    // reserveCredits amount and the world's credits_spent increment from
    // creditsForModel, so returning 0 here means dev runs never consume the
    // DAILY_CREDIT_BUDGET or inflate spend metrics — while reserveCredits(0)
    // still runs, keeping the budget/ledger money path exercised offline
    // (a 0-amount credit_events row is intentional).
    creditsForModel(model: WorldModel): number {
      creditsForModel(model); // validate the model id exactly like live.
      return 0;
    },

    async uploadPano(_bytes, _filename): Promise<string> {
      return `mock-media-${randomUUID()}`;
    },

    async generateWorld(_mediaAssetId, _model: WorldModel, displayName): Promise<string> {
      const operationId = `mock-op-${randomUUID()}`;
      const worldId = `mock-world-${randomUUID()}`;
      state.operations.set(operationId, worldId);
      state.byDisplayName.set(displayName, { worldId, operationId, done: true });
      return operationId;
    },

    async findWorldByDisplayName(displayName): Promise<WorldMatch | null> {
      // In-process only: a mock provider in a FRESH process has no memory of an
      // earlier run's generation, so a cross-restart resume reconciles to null
      // and the job is parked dead — exactly the conservative behavior the live
      // path takes when it cannot prove a generation happened.
      return state.byDisplayName.get(displayName) ?? null;
    },

    async getOperation(operationId): Promise<OperationStatus> {
      const worldId = state.operations.get(operationId);
      if (!worldId) {
        // Unknown op id (e.g. resumed from a persisted id in a fresh process):
        // synthesize a deterministic world id so resume still completes.
        const synthesized = `mock-world-${operationId}`;
        state.operations.set(operationId, synthesized);
        return { done: true, worldId: synthesized };
      }
      return { done: true, worldId };
    },

    async getWorld(worldId): Promise<WorldAssets> {
      return {
        spzUrls: {
          k100: mintAssetUrl(worldId, 'splat_100k.spz'),
          k500: mintAssetUrl(worldId, 'splat_500k.spz'),
          full: mintAssetUrl(worldId, 'splat_full.spz'),
        },
        colliderMeshUrl: mintAssetUrl(worldId, 'collider.glb'),
        thumbnailUrl: mintAssetUrl(worldId, 'thumbnail.jpg'),
        caption: 'A mock world generated offline (zero credits).',
      };
    },

    async downloadAsset(url): Promise<Buffer> {
      const bytes = assetBytes.get(url);
      if (!bytes) {
        // Tolerate resumed worlds whose URLs were minted in a prior process —
        // still serve the format-correct fixture for the extension.
        if (url.startsWith(FAKE_HOST)) return fixtureFor(url);
        throw new ProviderError(`mock asset not found: ${url}`);
      }
      return bytes;
    },
  };
}
