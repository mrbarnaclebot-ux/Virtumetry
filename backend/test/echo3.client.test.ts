import { readFileSync } from 'node:fs';
import { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { createEcho3Provider, downloadAllowed, parseRetryAfter, T_SUBMIT_MS } from '../src/provider/echo3.js';
import { ProviderError, ProviderTimeoutError, signWebhook, type Artifact } from '../src/provider/types.js';
import { LEASE_SECONDS } from '../src/queue.js';
import { withHeartbeat } from '../src/pipeline.js';
import { startFakeEcho3, type Step } from './helpers/fake-echo3.js';

// V1 client contract against the hermetic fake (127.0.0.1). Never a spaitial host.

const KEY = 'spt_live_test';
const SECRET = 'whsec_test';
const FIX = fileURLToPath(new URL('./fixtures/mock-outputs/', import.meta.url));
const BODY = '{"model":"echo-3","title":"t","input":{"type":"capture_bundle"}}';

let fake: Awaited<ReturnType<typeof startFakeEcho3>> | undefined;
afterEach(async () => {
  await fake?.close();
  fake = undefined;
});

async function mk(opts: Parameters<typeof startFakeEcho3>[0] = {}, timeouts?: { submit?: number }) {
  fake = await startFakeEcho3(opts);
  const p = createEcho3Provider({ apiKey: KEY, baseUrl: fake.baseUrl, webhookSecret: SECRET, timeouts });
  return { p, f: fake };
}

const bytes = async (r: Readable) => {
  const out: Buffer[] = [];
  for await (const c of r) out.push(Buffer.from(c as Buffer));
  return Buffer.concat(out);
};

const reject = async (pr: Promise<unknown>) => {
  try {
    await pr;
  } catch (e) {
    return e as ProviderError;
  }
  throw new Error('expected rejection');
};

describe('echo3 submit', () => {
  it('sends bearer, Idempotency-Key, content-type and the exact body; 202 → requestId', async () => {
    const { p, f } = await mk();
    const { requestId } = await p.submit(BODY, 'k1');
    expect(requestId).toMatch(/^req_/);
    expect(f.state.submits).toEqual([{ key: 'k1', body: BODY, auth: `Bearer ${KEY}` }]);
  });

  it('same key + same body twice → same requestId, billed once', async () => {
    const { p, f } = await mk();
    const a = await p.submit(BODY, 'k1');
    const b = await p.submit(BODY, 'k1');
    expect(b.requestId).toBe(a.requestId);
    expect(f.state.billed).toBe(1);
    expect(new Set(f.state.submits.map((s) => s.body)).size).toBe(1);
  });

  it('same key + different body → 409 IDEMPOTENCY_KEY_REUSED', async () => {
    const { p } = await mk();
    await p.submit(BODY, 'k1');
    const e = await reject(p.submit(`${BODY} `, 'k1'));
    expect(e).toBeInstanceOf(ProviderError);
    expect(e.status).toBe(409);
    expect(e.code).toBe('IDEMPOTENCY_KEY_REUSED');
  });

  it('429 with Retry-After: 7 → retryAfterS 7', async () => {
    const { p } = await mk({ submitScript: ['429'] });
    const e = await reject(p.submit(BODY, 'k1'));
    expect([e.status, e.code, e.retryAfterS]).toEqual([429, 'RATE_LIMIT_EXCEEDED', 7]);
  });

  it('Retry-After as an HTTP date ≈ seconds ahead', async () => {
    const { p } = await mk({ submitScript: ['429'], retryAfter: new Date(Date.now() + 10_000).toUTCString() });
    const e = await reject(p.submit(BODY, 'k1'));
    expect(e.retryAfterS).toBeGreaterThanOrEqual(8);
    expect(e.retryAfterS).toBeLessThanOrEqual(11);
    expect(parseRetryAfter('Wed, 21 Oct 2015 07:28:00 GMT', Date.parse('Wed, 21 Oct 2015 07:27:50 GMT'))).toBe(10);
    expect(parseRetryAfter(null)).toBeUndefined();
  });

  it.each([
    ['503', 503, 'WORLD_INTAKE_UNAVAILABLE'],
    ['500', 500, 'INTERNAL_ERROR'],
    ['401', 401, 'UNAUTHORIZED'],
    ['402', 402, 'INSUFFICIENT_CREDITS'],
  ] as const)('%s maps status + envelope code', async (step, status, code) => {
    const { p, f } = await mk({ submitScript: [step as Step] });
    const e = await reject(p.submit(BODY, 'k1'));
    expect([e.status, e.code]).toEqual([status, code]);
    expect(f.state.billed).toBe(0);
    expect(e.message).not.toContain(KEY);
    expect(e.message).not.toContain('127.0.0.1');
  });

  it('non-JSON error body → HTTP_<status>', async () => {
    const p = createEcho3Provider({
      apiKey: KEY,
      baseUrl: 'http://127.0.0.1:1',
      webhookSecret: SECRET,
      fetch: (async () => new Response('<html>bad gateway</html>', { status: 502 })) as typeof fetch,
    });
    const e = await reject(p.submit(BODY, 'k1'));
    expect([e.status, e.code]).toEqual([502, 'HTTP_502']);
  });

  it("'timeout' → ProviderTimeoutError", async () => {
    const { p, f } = await mk({ submitScript: ['timeout'] }, { submit: 300 });
    const e = await reject(p.submit(BODY, 'k1'));
    expect(e).toBeInstanceOf(ProviderTimeoutError);
    expect(f.state.billed).toBe(1);
  });

  it("'drop-after-accept' → ProviderError with no status (uncertain), billed 1", async () => {
    const { p, f } = await mk({ submitScript: ['drop-after-accept'] });
    const e = await reject(p.submit(BODY, 'k1'));
    expect(e).toBeInstanceOf(ProviderError);
    expect(e).not.toBeInstanceOf(ProviderTimeoutError);
    expect(e.status).toBeUndefined();
    expect(f.state.billed).toBe(1);
  });

  it('a 202 without a req_ id is uncertain (no status)', async () => {
    const p = createEcho3Provider({
      apiKey: KEY,
      baseUrl: 'http://127.0.0.1:1',
      webhookSecret: SECRET,
      fetch: (async () => Response.json({ request_id: 'nope' }, { status: 202 })) as typeof fetch,
    });
    expect((await reject(p.submit(BODY, 'k1'))).status).toBeUndefined();
  });

  it('T_SUBMIT_MS < LEASE_SECONDS * 1000 / 2', () => {
    expect(T_SUBMIT_MS < (LEASE_SECONDS * 1000) / 2).toBe(true);
  });
});

describe('echo3 free calls', () => {
  it('quote(30) → 930 credits; limits cached', async () => {
    const { p, f } = await mk();
    expect(await p.quote(30)).toEqual({ credits: 930, available: 100000 });
    expect(await p.limits()).toEqual({ minFrames: 1, maxFrames: 5000 });
    await p.limits();
    expect(f.state.calls.limits).toBe(1);
  });

  it('status walks the sequence; null progress stays null', async () => {
    const { p } = await mk();
    expect(await p.status('req_a')).toEqual({ status: 'PROCESSING', progress: null });
    expect(await p.status('req_a')).toEqual({ status: 'COMPLETED', progress: 1 });
  });

  it('FAILED reads the envelope for issue codes', async () => {
    const { p, f } = await mk({
      statusSequence: ['FAILED'],
      failedEnvelope: { validation: { passed: false, issues: [{ code: 'EXIF_MISSING', message: 'no exif' }] } },
    });
    const s = await p.status('req_a');
    expect(s.status).toBe('FAILED');
    expect(s.progress).toBeNull();
    expect(s.issues).toEqual([{ code: 'EXIF_MISSING', message: 'no exif' }]);
    expect(s.error?.code).toBe('WORLD_GENERATION_FAILED');
    expect(f.state.calls.envelope).toBe(1);
  });

  it.each([
    [['READY'], 'ready', 0],
    [['PROCESSING'], 'pending', 0],
    [['FAILED'], 'failed', 0],
    [['NOT_REQUESTED', 'PROCESSING'], 'pending', 1],
    [['NOT_REQUESTED', 'READY'], 'ready', 1],
    [['404', 'PROCESSING'], 'pending', 1],
  ] as const)('ensureExport %j → %s (POSTs: %d)', async (seq, want, posts) => {
    const { p, f } = await mk({ exportScript: { 'mesh-simplified': [...seq] } });
    expect(await p.ensureExport('req_a', 'mesh-simplified')).toBe(want);
    expect(f.state.calls['export:POST:mesh-simplified'] ?? 0).toBe(posts);
  });

  it('cancel: 409 REQUEST_NOT_CANCELLABLE resolves', async () => {
    const { p, f } = await mk({ statusSequence: ['COMPLETED'] });
    await expect(p.cancel('req_a')).resolves.toBeUndefined();
    expect(f.state.calls.cancel).toBe(1);
  });

  it('deleteWorld: unknown → ProviderError 404; known → resolves', async () => {
    const { p } = await mk();
    const e = await reject(p.deleteWorld('req_missing'));
    expect(e.status).toBe(404);
    const { requestId } = await p.submit(BODY, 'k1');
    await expect(p.deleteWorld(requestId)).resolves.toBeUndefined();
  });

  it('verifyWebhook uses the configured secret', async () => {
    const { p } = await mk();
    const raw = Buffer.from('{"x":1}');
    expect(p.verifyWebhook(raw, signWebhook(SECRET, raw))).toBe(true);
    expect(p.verifyWebhook(raw, signWebhook('other', raw))).toBe(false);
  });
});

describe('echo3 artifacts + open', () => {
  it('lists the mock kinds with splat.spz; no thumbnail when null', async () => {
    const { p } = await mk();
    const list = await p.artifacts('req_a');
    expect(list.map((a) => [a.kind, a.name])).toEqual([
      ['splat', 'splat.spz'],
      ['collider', 'collider.ply'],
      ['floorplan', 'floorplan.png'],
      ['floorplan_meta', 'floorplan.json'],
      ['cameras', 'cameras.json'],
    ]);
  });

  it.each([
    ['http://127.0.0.1/t.jpg', false],
    ['https://evil.example/t.jpg', false],
    ['https://img.spaitial.ai/t.jpg', true],
  ])('thumbnail %s listed=%s (never opened)', async (url, listed) => {
    const { p } = await mk({ thumbnailUrl: url });
    const list = await p.artifacts('req_a');
    expect(list.some((a) => a.kind === 'thumbnail' && a.ref === url)).toBe(listed);
  });

  it('open(splat) follows the 302 cross-origin with NO Authorization', async () => {
    const { p, f } = await mk();
    const splat = (await p.artifacts('req_a')).find((a) => a.kind === 'splat')!;
    const got = await bytes(await p.open(splat));
    expect(got.equals(readFileSync(`${FIX}splat.ply`))).toBe(true);
    expect(f.state.signedHits).toEqual([{ path: '/signed/splat', auth: undefined }]);
  });

  it('open() streams collider, floorplan, cameras via signed hits without auth', async () => {
    const { p, f } = await mk();
    const list = await p.artifacts('req_a');
    for (const [kind, file] of [
      ['collider', 'collider.ply'],
      ['floorplan', 'floorplan.png'],
      ['cameras', 'cameras.json'],
    ] as const) {
      const got = await bytes(await p.open(list.find((a) => a.kind === kind)!));
      expect(got.equals(readFileSync(`${FIX}${file}`))).toBe(true);
    }
    expect(f.state.signedHits.every((h) => h.auth === undefined)).toBe(true);
  });

  it('open(floorplan_meta) streams the export floorplan block', async () => {
    const { p } = await mk();
    const meta = (await p.artifacts('req_a')).find((a) => a.kind === 'floorplan_meta')!;
    const got = JSON.parse((await bytes(await p.open(meta))).toString('utf8')) as unknown;
    expect(got).toEqual(JSON.parse(readFileSync(`${FIX}floorplan.json`, 'utf8')));
  });

  it.each(['https://evil.example/x', '/v1/other', 'json:/v1/other', '/v1/worlds/requests/../../x'])(
    'open() refuses %s before any fetch',
    async (ref) => {
      let fetched = 0;
      const p = createEcho3Provider({
        apiKey: KEY,
        baseUrl: 'http://127.0.0.1:1',
        webhookSecret: SECRET,
        fetch: (async () => {
          fetched++;
          return new Response('x');
        }) as typeof fetch,
      });
      const a: Artifact = { kind: 'splat', name: 'splat.spz', contentType: 'application/octet-stream', ref };
      await expect(p.open(a)).rejects.toThrow(/refusing/);
      await expect(p.open({ ...a, kind: 'thumbnail', ref: 'http://img.spaitial.ai/t.jpg' })).rejects.toThrow(
        /refusing/,
      );
      expect(fetched).toBe(0);
    },
  );
});

describe('WR-02 download SSRF guard', () => {
  /** API base is a public https name (injected fetch, no network); the API answers 302 → `loc`. */
  const redirectTo = (loc: string) => {
    const seen: { url: string; init?: RequestInit }[] = [];
    const p = createEcho3Provider({
      apiKey: KEY,
      baseUrl: 'https://api.example.com',
      webhookSecret: SECRET,
      fetch: (async (input: string | URL, init?: RequestInit) => {
        seen.push({ url: String(input), init });
        return seen.length === 1 ? new Response(null, { status: 302, headers: { location: loc } }) : new Response('bytes');
      }) as typeof fetch,
    });
    const a: Artifact = { kind: 'splat', name: 'splat.spz', contentType: 'application/octet-stream', ref: '/v1/worlds/requests/req_a/splat' };
    return { open: () => p.open(a), seen };
  };

  it.each([
    'http://169.254.169.254/latest/meta-data',
    'https://10.0.0.5/x',
    'https://2130706433/x',
    'https://[::1]/x',
    'https://127.0.0.1/x',
    'http://storage.example.com/x',
    'https://metadata.google.internal/x',
    'https://localhost/x',
    'file:///etc/passwd',
  ])('refuses a redirect to %s without fetching it', async (loc) => {
    const { open, seen } = redirectTo(loc);
    await expect(open()).rejects.toThrow(/refusing download host/);
    expect(seen).toHaveLength(1);
  });

  /** API 302 → `hops[0]`; each storage hop i answers 302 → hops[i+1]; the last answers 200. */
  const chain = (hops: string[]) => {
    const seen: { url: string; init?: RequestInit }[] = [];
    const p = createEcho3Provider({
      apiKey: KEY,
      baseUrl: 'https://api.example.com',
      webhookSecret: SECRET,
      fetch: (async (input: string | URL, init?: RequestInit) => {
        seen.push({ url: String(input), init });
        const next = hops[seen.length - 1];
        return next ? new Response(null, { status: 307, headers: { location: next } }) : new Response('bytes');
      }) as typeof fetch,
    });
    const a: Artifact = { kind: 'splat', name: 'splat.spz', contentType: 'application/octet-stream', ref: '/v1/worlds/requests/req_a/splat' };
    return { open: () => p.open(a), seen };
  };

  it('iter2 WR-03: follows storage redirects (relative too) with the host check and no auth on every hop', async () => {
    const { open, seen } = chain(['https://s3.amazonaws.com/b/obj?sig=1', 'https://b.s3.eu-west-1.amazonaws.com/obj?sig=1', '/obj2?sig=2']);
    expect((await bytes(await open())).toString()).toBe('bytes');
    expect(seen.map((s) => s.url)).toEqual([
      'https://api.example.com/v1/worlds/requests/req_a/splat',
      'https://s3.amazonaws.com/b/obj?sig=1',
      'https://b.s3.eu-west-1.amazonaws.com/obj?sig=1',
      'https://b.s3.eu-west-1.amazonaws.com/obj2?sig=2',
    ]);
    for (const s of seen.slice(1)) {
      expect(s.init?.redirect).toBe('manual');
      expect(s.init?.headers).toBeUndefined();
    }
  });

  it('iter2 WR-03: refuses a second hop to a metadata IP without fetching it', async () => {
    const { open, seen } = chain(['https://storage.example.com/obj?sig=1', 'http://169.254.169.254/latest/meta-data']);
    await expect(open()).rejects.toThrow(/refusing download host/);
    expect(seen).toHaveLength(2);
  });

  it('iter2 WR-03: stops after 3 storage hops', async () => {
    const { open, seen } = chain(['https://a.example.com/1', 'https://a.example.com/2', 'https://a.example.com/3', 'https://a.example.com/4', 'https://a.example.com/5']);
    await expect(open()).rejects.toThrow(/download 307/);
    expect(seen).toHaveLength(5); // API + first storage URL + 3 followed hops; the 4th redirect is not followed
  });

  it('follows a redirect to a public https host without auth', async () => {
    const { open, seen } = redirectTo('https://storage.example.com/obj?sig=1');
    expect((await bytes(await open())).toString()).toBe('bytes');
    expect(seen[1]!.url).toBe('https://storage.example.com/obj?sig=1');
    expect(seen[1]!.init?.redirect).toBe('manual');
    expect(seen[1]!.init?.headers).toBeUndefined();
  });

  it('loopback is allowed only when the API base is loopback (the test fake)', () => {
    expect(downloadAllowed(new URL('http://localhost:9/x'), true)).toBe(true);
    expect(downloadAllowed(new URL('http://localhost:9/x'), false)).toBe(false);
    expect(downloadAllowed(new URL('http://10.0.0.1/x'), true)).toBe(false);
  });
});

describe('WR-03 response shape validation', () => {
  const json = (body: unknown) => {
    let calls = 0;
    const p = createEcho3Provider({
      apiKey: KEY,
      baseUrl: 'http://127.0.0.1:1',
      webhookSecret: SECRET,
      fetch: (async () => {
        calls++;
        return Response.json(body);
      }) as typeof fetch,
    });
    return { p, calls: () => calls };
  };

  it.each([{}, { required_credits: '930', available_credits: 1 }, { required_credits: 0, available_credits: 1 }, { required_credits: 930 }])(
    'quote %j → ProviderError with no status',
    async (body) => {
      const e = await reject(json(body).p.quote(30));
      expect(e).toBeInstanceOf(ProviderError);
      expect(e.status).toBeUndefined();
    },
  );

  it.each([{}, { min_frames: 10 }, { min_frames: 10, max_frames: 5 }, { min_frames: 1.5, max_frames: 5 }])(
    'limits %j → ProviderError, not cached',
    async (body) => {
      const { p, calls } = json(body);
      await expect(p.limits()).rejects.toBeInstanceOf(ProviderError);
      await expect(p.limits()).rejects.toBeInstanceOf(ProviderError);
      expect(calls()).toBe(2);
    },
  );
});

describe('WR-04 lease heartbeat while an artifact streams', () => {
  it('beats during the stream and passes every byte through', async () => {
    let beats = 0;
    const out = withHeartbeat(Readable.from([Buffer.from('ab'), Buffer.from('cd'), Buffer.from('ef')]), async () => {
      beats++;
    }, 0);
    expect((await bytes(out)).toString()).toBe('abcdef');
    expect(beats).toBe(3);
  });

  it('a lost lease errors the stream (the upload aborts)', async () => {
    const out = withHeartbeat(Readable.from([Buffer.from('ab')]), async () => {
      throw new Error('lease lost');
    }, 0);
    await expect(bytes(out)).rejects.toThrow('lease lost');
  });

  it('a source error reaches the consumer', async () => {
    const src = new Readable({ read() { this.destroy(new Error('socket reset')); } });
    await expect(bytes(withHeartbeat(src, async () => undefined))).rejects.toThrow('socket reset');
  });
});
