import { describe, it, expect } from 'vitest';
import {
  createWorldLabsProvider,
  MAX_DISPLAY_NAME,
  type FetchLike,
} from '../src/provider/worldlabs.js';

// Verifies worldlabs.ts shapes requests EXACTLY like the live-verified spike
// (tools/spike/spike.py): endpoints, headers (WLT-Api-Key), and JSON bodies.

interface RecordedCall {
  url: string;
  method: string;
  headers: Record<string, string>;
  body?: string | Uint8Array;
}

function jsonResponse(obj: unknown, status = 200): Response {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

/** Build a fetch mock that records calls and replays queued responses. */
function mockFetch(responses: Response[]): { fetch: FetchLike; calls: RecordedCall[] } {
  const calls: RecordedCall[] = [];
  let i = 0;
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    const headers: Record<string, string> = {};
    const h = init?.headers as Record<string, string> | undefined;
    if (h) for (const [k, v] of Object.entries(h)) headers[k] = v;
    calls.push({
      url: String(url),
      method: init?.method ?? 'GET',
      headers,
      body: init?.body as string | Uint8Array | undefined,
    });
    const res = responses[i++];
    if (!res) throw new Error(`no mock response for call ${i}`);
    return res;
  }) as unknown as FetchLike;
  return { fetch: fetchImpl, calls };
}

const KEY = 'wlt_test_key';

describe('worldlabs provider request shaping', () => {
  it('uploadPano: prepare_upload body + PUT with required headers + Content-Type', async () => {
    const { fetch, calls } = mockFetch([
      jsonResponse({
        media_asset: { media_asset_id: 'ma_123' },
        upload_info: {
          upload_url: 'https://signed.example/put',
          upload_method: 'PUT',
          required_headers: { 'x-amz-meta-foo': 'bar' },
        },
      }),
      new Response('', { status: 200 }),
    ]);
    const provider = createWorldLabsProvider({ apiKey: KEY, fetchImpl: fetch });

    const mediaId = await provider.uploadPano(Buffer.from('PANO'), 'pano.jpg');
    expect(mediaId).toBe('ma_123');

    // Call 1 — prepare_upload.
    expect(calls[0]!.url).toBe('https://api.worldlabs.ai/marble/v1/media-assets:prepare_upload');
    expect(calls[0]!.method).toBe('POST');
    expect(calls[0]!.headers['WLT-Api-Key']).toBe(KEY);
    expect(calls[0]!.headers['Content-Type']).toBe('application/json');
    expect(JSON.parse(calls[0]!.body as string)).toEqual({
      file_name: 'pano.jpg',
      kind: 'image',
      extension: 'jpg',
    });

    // Call 2 — PUT bytes to the signed URL with merged headers.
    expect(calls[1]!.url).toBe('https://signed.example/put');
    expect(calls[1]!.method).toBe('PUT');
    expect(calls[1]!.headers['x-amz-meta-foo']).toBe('bar');
    expect(calls[1]!.headers['Content-Type']).toBe('image/jpeg');
  });

  it('uploadPano: falls back to media_asset.id when media_asset_id absent', async () => {
    const { fetch } = mockFetch([
      jsonResponse({
        media_asset: { id: 'ma_fallback' },
        upload_info: { upload_url: 'https://signed.example/put' },
      }),
      new Response('', { status: 201 }),
    ]);
    const provider = createWorldLabsProvider({ apiKey: KEY, fetchImpl: fetch });
    expect(await provider.uploadPano(Buffer.from('X'), 'p.jpg')).toBe('ma_fallback');
  });

  it('generateWorld: refuses a display_name over the 64-char cap without calling fetch', async () => {
    const { fetch, calls } = mockFetch([]);
    const provider = createWorldLabsProvider({ apiKey: KEY, fetchImpl: fetch });

    await expect(
      provider.generateWorld('ma_123', 'marble-1.0-draft', 'x'.repeat(MAX_DISPLAY_NAME + 1)),
    ).rejects.toThrow(/at most 64/);
    expect(calls).toHaveLength(0);
  });

  it('generateWorld: exact worlds:generate body with is_pano + media_asset source', async () => {
    const { fetch, calls } = mockFetch([jsonResponse({ operation_id: 'op_9' })]);
    const provider = createWorldLabsProvider({ apiKey: KEY, fetchImpl: fetch });

    const opId = await provider.generateWorld('ma_123', 'marble-1.1', 'My World');
    expect(opId).toBe('op_9');
    expect(calls[0]!.url).toBe('https://api.worldlabs.ai/marble/v1/worlds:generate');
    expect(calls[0]!.method).toBe('POST');
    expect(calls[0]!.headers['WLT-Api-Key']).toBe(KEY);
    expect(JSON.parse(calls[0]!.body as string)).toEqual({
      display_name: 'My World',
      model: 'marble-1.1',
      world_prompt: {
        type: 'image',
        image_prompt: { source: 'media_asset', media_asset_id: 'ma_123' },
        is_pano: true,
      },
    });
  });

  it('getOperation: normalizes done + nested world_id', async () => {
    const { fetch, calls } = mockFetch([
      jsonResponse({ done: true, response: { world_id: 'w_42' } }),
    ]);
    const provider = createWorldLabsProvider({ apiKey: KEY, fetchImpl: fetch });
    const op = await provider.getOperation('op_9');
    expect(op).toEqual({ done: true, worldId: 'w_42' });
    expect(calls[0]!.url).toBe('https://api.worldlabs.ai/marble/v1/operations/op_9');
    expect(calls[0]!.method).toBe('GET');
  });

  it('getWorld: maps spz_urls 100k/500k/full_res + mesh/thumbnail/caption', async () => {
    const { fetch } = mockFetch([
      jsonResponse({
        assets: {
          splats: { spz_urls: { '100k': 'u100', '500k': 'u500', full_res: 'ufull' } },
          mesh: { collider_mesh_url: 'ucollider' },
          thumbnail_url: 'uthumb',
          caption: 'a place',
        },
      }),
    ]);
    const provider = createWorldLabsProvider({ apiKey: KEY, fetchImpl: fetch });
    const w = await provider.getWorld('w_42');
    expect(w).toEqual({
      spzUrls: { k100: 'u100', k500: 'u500', full: 'ufull' },
      colliderMeshUrl: 'ucollider',
      thumbnailUrl: 'uthumb',
      caption: 'a place',
    });
  });

  it('throws ProviderError with status on non-2xx', async () => {
    const { fetch } = mockFetch([new Response('nope', { status: 500 })]);
    const provider = createWorldLabsProvider({ apiKey: KEY, fetchImpl: fetch });
    await expect(provider.getOperation('op_x')).rejects.toMatchObject({
      name: 'ProviderError',
      status: 500,
    });
  });

  // spec §10 R1 — reconciliation lookup for a `pending:<jobId>` marker. The
  // listing endpoint is NOT spike-verified, so the contract that matters here is
  // (a) it is a plain GET that never touches worlds:generate, and (b) a bad
  // response surfaces as a ProviderError (retryable) rather than a re-generate.
  describe('findWorldByDisplayName', () => {
    it('GETs the worlds listing with the API key and matches on display_name', async () => {
      const { fetch, calls } = mockFetch([
        jsonResponse({
          worlds: [
            { world_id: 'w_other', display_name: 'something else' },
            {
              world_id: 'w_match',
              display_name: 'VirtSpace world row-1 [job:job-9]',
              operation_id: 'op_9',
              status: 'done',
            },
          ],
        }),
      ]);
      const provider = createWorldLabsProvider({ apiKey: KEY, fetchImpl: fetch });

      const match = await provider.findWorldByDisplayName(
        'VirtSpace world row-1 [job:job-9]',
      );

      expect(calls[0]!.method).toBe('GET');
      expect(calls[0]!.url).toContain('/marble/v1/worlds');
      expect(calls[0]!.url).not.toContain('generate');
      expect(calls[0]!.headers['WLT-Api-Key']).toBe(KEY);
      expect(match).toEqual({ worldId: 'w_match', operationId: 'op_9', done: true });
    });

    it('marks a still-running world as not done so the worker reconciles again', async () => {
      const { fetch } = mockFetch([
        jsonResponse({
          items: [{ id: 'w_running', name: 'nm', status: 'generating' }],
        }),
      ]);
      const provider = createWorldLabsProvider({ apiKey: KEY, fetchImpl: fetch });
      expect(await provider.findWorldByDisplayName('nm')).toEqual({
        worldId: 'w_running',
        done: false,
      });
    });

    it('returns null when nothing matches', async () => {
      const { fetch } = mockFetch([jsonResponse({ worlds: [] })]);
      const provider = createWorldLabsProvider({ apiKey: KEY, fetchImpl: fetch });
      expect(await provider.findWorldByDisplayName('nope')).toBeNull();
    });

    it('surfaces a listing failure as a ProviderError (retryable, never re-generates)', async () => {
      const { fetch } = mockFetch([new Response('nope', { status: 404 })]);
      const provider = createWorldLabsProvider({ apiKey: KEY, fetchImpl: fetch });
      await expect(provider.findWorldByDisplayName('nm')).rejects.toMatchObject({
        name: 'ProviderError',
        status: 404,
      });
    });
  });

  it('credits: draft=150, hq=1500', () => {
    const provider = createWorldLabsProvider({ apiKey: KEY, fetchImpl: mockFetch([]).fetch });
    expect(provider.creditsForModel('marble-1.0-draft')).toBe(150);
    expect(provider.creditsForModel('marble-1.1')).toBe(1500);
  });
});
