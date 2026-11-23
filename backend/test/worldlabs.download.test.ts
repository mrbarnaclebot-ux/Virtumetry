import { describe, it, expect } from 'vitest';
import {
  createWorldLabsProvider,
  assertDownloadableUrl,
  parseAssetHosts,
  hostAllowed,
  isNonRoutableHost,
  DEFAULT_ASSET_HOSTS,
  DEFAULT_ASSET_MAX_BYTES,
  type FetchLike,
} from '../src/provider/worldlabs.js';

// downloadAsset hardening (spec §10 R10). Asset URLs come from the PROVIDER's
// JSON, so they are untrusted: the API key must not ride along to an arbitrary
// host, only https + allowlisted hosts are fetchable, and a body is capped while
// it streams. Fake fetch throughout — no network.

const KEY = 'wlt-secret-key';

interface Recorded {
  url: string;
  headers: Record<string, string>;
}

function fetchReturning(
  make: () => Response,
): { fetch: FetchLike; calls: Recorded[] } {
  const calls: Recorded[] = [];
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    const headers: Record<string, string> = {};
    const h = init?.headers as Record<string, string> | undefined;
    if (h) for (const [k, v] of Object.entries(h)) headers[k] = v;
    calls.push({ url: String(url), headers });
    return make();
  }) as unknown as FetchLike;
  return { fetch: fetchImpl, calls };
}

function provider(fetchImpl: FetchLike, over: Record<string, unknown> = {}) {
  return createWorldLabsProvider({ apiKey: KEY, fetchImpl, ...over });
}

/** A streaming response of `size` bytes, optionally lying about Content-Length. */
function streamOf(size: number, headers: Record<string, string> = {}): Response {
  const chunk = new Uint8Array(1024);
  let sent = 0;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (sent >= size) {
        controller.close();
        return;
      }
      const n = Math.min(chunk.length, size - sent);
      sent += n;
      controller.enqueue(chunk.subarray(0, n));
    },
  });
  return new Response(body, { status: 200, headers });
}

describe('parseAssetHosts', () => {
  it('falls back to the defaults when unset or empty', () => {
    expect(parseAssetHosts(undefined)).toEqual(DEFAULT_ASSET_HOSTS);
    expect(parseAssetHosts('')).toEqual(DEFAULT_ASSET_HOSTS);
    expect(parseAssetHosts('  ,  ')).toEqual(DEFAULT_ASSET_HOSTS);
  });

  it('parses and normalises a comma-separated list', () => {
    expect(parseAssetHosts('A.example.com, .cdn.example.com ')).toEqual([
      'a.example.com',
      '.cdn.example.com',
    ]);
  });

  it('defaults cover the API host and the observed Marble CDN host', () => {
    expect(hostAllowed('api.worldlabs.ai', DEFAULT_ASSET_HOSTS)).toBe(true);
    expect(hostAllowed('cdn.marble.worldlabs.ai', DEFAULT_ASSET_HOSTS)).toBe(true);
  });
});

describe('hostAllowed', () => {
  it('matches an exact entry only exactly', () => {
    expect(hostAllowed('a.example.com', ['a.example.com'])).toBe(true);
    expect(hostAllowed('evil.a.example.com', ['a.example.com'])).toBe(false);
  });

  it('a leading dot matches the host and its subdomains', () => {
    expect(hostAllowed('example.com', ['.example.com'])).toBe(true);
    expect(hostAllowed('cdn.example.com', ['.example.com'])).toBe(true);
    // The classic suffix bug: must NOT match a lookalike registrable domain.
    expect(hostAllowed('notexample.com', ['.example.com'])).toBe(false);
    expect(hostAllowed('example.com.evil.net', ['.example.com'])).toBe(false);
  });
});

describe('isNonRoutableHost', () => {
  it.each([
    'localhost', '127.0.0.1', '10.1.2.3', '192.168.1.1', '172.16.0.1',
    '172.31.255.255', '0.0.0.0', '100.64.0.1',
    '169.254.169.254', // cloud metadata endpoint
    '::1', '::', 'fd00::1', 'fe80::1', '::ffff:127.0.0.1',
  ])('rejects %s', (host) => {
    expect(isNonRoutableHost(host)).toBe(true);
  });

  it.each(['api.worldlabs.ai', '8.8.8.8', '172.32.0.1', '11.0.0.1', '2606:4700::1'])(
    'allows %s',
    (host) => {
      expect(isNonRoutableHost(host)).toBe(false);
    },
  );
});

describe('assertDownloadableUrl', () => {
  const hosts = DEFAULT_ASSET_HOSTS;

  it('accepts an https URL on an allowlisted host', () => {
    const url = assertDownloadableUrl('https://cdn.marble.worldlabs.ai/a.spz', hosts);
    expect(url.hostname).toBe('cdn.marble.worldlabs.ai');
  });

  it('rejects http', () => {
    expect(() => assertDownloadableUrl('http://api.worldlabs.ai/a.spz', hosts)).toThrow(
      /must be https/,
    );
  });

  it('rejects a host outside the allowlist', () => {
    expect(() => assertDownloadableUrl('https://evil.example.com/a.spz', hosts)).toThrow(
      /not in the allowlist/,
    );
  });

  it('rejects a non-routable literal even if the allowlist names it', () => {
    expect(() => assertDownloadableUrl('https://169.254.169.254/latest', ['169.254.169.254']))
      .toThrow(/non-routable/);
  });

  it('rejects a malformed URL', () => {
    expect(() => assertDownloadableUrl('not a url', hosts)).toThrow(/not a valid URL/);
  });
});

describe('downloadAsset', () => {
  it('never sends the API key, even to the API host (spec §10 R29)', async () => {
    const { fetch, calls } = fetchReturning(() => new Response('bytes', { status: 200 }));
    await provider(fetch).downloadAsset('https://api.worldlabs.ai/asset.spz');
    expect(JSON.stringify(calls[0]!.headers)).not.toContain(KEY);
  });

  it('does NOT send the API key to the CDN host', async () => {
    const { fetch, calls } = fetchReturning(() => new Response('bytes', { status: 200 }));
    await provider(fetch).downloadAsset('https://cdn.marble.worldlabs.ai/asset.spz');
    // The whole point: a signed CDN URL needs no credential, and attaching one
    // to a provider-chosen host is how a key leaks.
    expect(calls[0]!.headers['WLT-Api-Key']).toBeUndefined();
    expect(JSON.stringify(calls[0]!.headers)).not.toContain(KEY);
  });

  it('refuses a host outside the allowlist without making a request', async () => {
    const { fetch, calls } = fetchReturning(() => new Response('bytes', { status: 200 }));
    await expect(
      provider(fetch).downloadAsset('https://evil.example.com/asset.spz'),
    ).rejects.toThrow(/not in the allowlist/);
    expect(calls).toHaveLength(0); // never dialled
  });

  it('refuses http without making a request', async () => {
    const { fetch, calls } = fetchReturning(() => new Response('bytes', { status: 200 }));
    await expect(
      provider(fetch).downloadAsset('http://api.worldlabs.ai/asset.spz'),
    ).rejects.toThrow(/must be https/);
    expect(calls).toHaveLength(0);
  });

  it('honours an env-configured allowlist', async () => {
    const { fetch, calls } = fetchReturning(() => new Response('bytes', { status: 200 }));
    const p = provider(fetch, { assetHosts: '.assets.example.com' });
    await p.downloadAsset('https://x.assets.example.com/a.spz');
    expect(calls).toHaveLength(1);
    // …and the defaults no longer apply once overridden.
    await expect(p.downloadAsset('https://cdn.marble.worldlabs.ai/a.spz')).rejects.toThrow(
      /not in the allowlist/,
    );
  });

  it('returns the body when under the cap', async () => {
    const { fetch } = fetchReturning(() => streamOf(4096));
    const buf = await provider(fetch, { assetMaxBytes: 8192 }).downloadAsset(
      'https://cdn.marble.worldlabs.ai/a.spz',
    );
    expect(buf.byteLength).toBe(4096);
  });

  it('rejects up front when Content-Length declares an over-cap body', async () => {
    const { fetch } = fetchReturning(() =>
      streamOf(64, { 'content-length': String(999_999) }),
    );
    await expect(
      provider(fetch, { assetMaxBytes: 1024 }).downloadAsset(
        'https://cdn.marble.worldlabs.ai/a.spz',
      ),
    ).rejects.toThrow(/Content-Length/);
  });

  it('aborts mid-stream when a body exceeds the cap without declaring it', async () => {
    // Content-Length is attacker-controlled and absent under chunked encoding,
    // so the running total is the guard that actually matters.
    const { fetch } = fetchReturning(() => streamOf(40 * 1024));
    await expect(
      provider(fetch, { assetMaxBytes: 8 * 1024 }).downloadAsset(
        'https://cdn.marble.worldlabs.ai/a.spz',
      ),
    ).rejects.toThrow(/aborted after/);
  });

  it('surfaces a non-2xx as a provider error', async () => {
    const { fetch } = fetchReturning(() => new Response('nope', { status: 403 }));
    await expect(
      provider(fetch).downloadAsset('https://cdn.marble.worldlabs.ai/a.spz'),
    ).rejects.toThrow(/asset download failed: 403/);
  });

  it('defaults the cap to 200 MB', () => {
    expect(DEFAULT_ASSET_MAX_BYTES).toBe(200 * 1024 * 1024);
  });
});

// Spec §10 R29: fetch's own redirect following checks only the first URL, so a
// 3xx from an allowlisted host could bounce the request anywhere.
describe('downloadAsset redirects', () => {
  /** Replays `responses` in order, recording url + redirect mode + headers. */
  function chain(responses: Response[]) {
    const calls: { url: string; redirect?: RequestRedirect; headers: string }[] = [];
    let i = 0;
    const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({
        url: String(url),
        redirect: init?.redirect,
        headers: JSON.stringify(init?.headers ?? {}),
      });
      const res = responses[i++];
      if (!res) throw new Error('unexpected extra fetch');
      return res;
    }) as unknown as FetchLike;
    return { fetch: fetchImpl, calls };
  }
  const to = (location: string, status = 302) =>
    new Response(null, { status, headers: { location } });

  it('follows an allowlisted redirect by hand, re-checking the hop', async () => {
    const { fetch, calls } = chain([
      to('https://cdn.marble.worldlabs.ai/real.spz', 307),
      new Response('bytes', { status: 200 }),
    ]);
    const buf = await provider(fetch).downloadAsset('https://api.worldlabs.ai/a.spz');
    expect(buf.toString()).toBe('bytes');
    expect(calls.map((c) => c.url)).toEqual([
      'https://api.worldlabs.ai/a.spz',
      'https://cdn.marble.worldlabs.ai/real.spz',
    ]);
    expect(calls.every((c) => c.redirect === 'manual')).toBe(true);
    expect(calls.every((c) => !c.headers.includes(KEY))).toBe(true);
  });

  it('resolves a relative Location against the current hop', async () => {
    const { fetch, calls } = chain([to('/b.spz'), new Response('ok', { status: 200 })]);
    await provider(fetch).downloadAsset('https://cdn.marble.worldlabs.ai/a/a.spz');
    expect(calls[1]!.url).toBe('https://cdn.marble.worldlabs.ai/b.spz');
  });

  it('refuses a redirect off the allowlist without dialling it', async () => {
    const { fetch, calls } = chain([to('https://evil.example.com/steal')]);
    await expect(
      provider(fetch).downloadAsset('https://cdn.marble.worldlabs.ai/a.spz'),
    ).rejects.toThrow(/not in the allowlist/);
    expect(calls).toHaveLength(1);
  });

  it('refuses a redirect to cloud metadata or plain http', async () => {
    for (const loc of ['https://169.254.169.254/latest', 'http://cdn.marble.worldlabs.ai/a']) {
      const { fetch, calls } = chain([to(loc)]);
      await expect(
        provider(fetch, { assetHosts: '169.254.169.254,.worldlabs.ai' }).downloadAsset(
          'https://cdn.marble.worldlabs.ai/a.spz',
        ),
      ).rejects.toThrow(/non-routable|must be https/);
      expect(calls).toHaveLength(1);
    }
  });

  it('gives up after 3 redirects', async () => {
    const hop = () => to('https://cdn.marble.worldlabs.ai/loop');
    const { fetch, calls } = chain([hop(), hop(), hop(), hop()]);
    await expect(
      provider(fetch).downloadAsset('https://cdn.marble.worldlabs.ai/loop'),
    ).rejects.toThrow(/exceeded 3 redirects/);
    expect(calls).toHaveLength(4);
  });

  it('API calls refuse redirects outright', async () => {
    const { fetch, calls } = chain([new Response('{}', { status: 200 })]);
    await provider(fetch).getOperation('op-1');
    expect(calls[0]!.redirect).toBe('error');
  });
});
