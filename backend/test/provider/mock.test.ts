import { promises as fs, readFileSync, readdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import type { Readable } from 'node:stream';
import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import { createMockProvider } from '../../src/provider/mock.js';
import { createProvider } from '../../src/provider/index.js';
import {
  ProviderError,
  signWebhook,
  verifyWebhookSignature,
  type Artifact,
} from '../../src/provider/types.js';
import { MOCK_SCENARIOS, type Config } from '../../src/config.js';
import { createLocalStorage, type LocalStorage } from '../../src/storage/local.js';
import { captureKey } from '../../src/storage/index.js';
import { packCapture } from '../../src/bundle/pack.js';

const SECRET = 'test-webhook-secret';
const ZIP_URL = 'https://bundles.test/capture.zip';
const body = (url = ZIP_URL, title = 't') =>
  JSON.stringify({ model: 'echo-3', title, input: { type: 'capture_bundle', zip: { type: 'url', zip_url: url } } });

/** fetch stub: every request gets `status` and no body. */
const statusFetch = (status: number) =>
  (async () => new Response(null, { status })) as unknown as typeof fetch;

/** fetch stub serving HTTP Range reads from a local file. */
function fileFetch(file: string): typeof fetch {
  return (async (_url: unknown, init?: RequestInit) => {
    const total = (await fs.stat(file)).size;
    const m = /bytes=(\d+)-(\d+)/.exec(new Headers(init?.headers).get('range') ?? '');
    if (!m) return new Response(null, { status: 200 });
    const a = Number(m[1]);
    const b = Math.min(Number(m[2]), total - 1);
    const fh = await fs.open(file, 'r');
    try {
      const buf = Buffer.alloc(b - a + 1);
      await fh.read(buf, 0, buf.length, a);
      return new Response(buf, { status: 206, headers: { 'Content-Range': `bytes ${a}-${b}/${total}` } });
    } finally {
      await fh.close();
    }
  }) as unknown as typeof fetch;
}

async function readAll(s: Readable): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const c of s) chunks.push(c as Buffer);
  return Buffer.concat(chunks);
}

async function expectProviderError(p: Promise<unknown>, status: number, code: string) {
  const err = await p.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(ProviderError);
  expect((err as ProviderError).status).toBe(status);
  expect((err as ProviderError).code).toBe(code);
  return err as ProviderError;
}

// A real store-only bundle packed from the tiny-session fixture.
let dir: string;
let bundleFile: string;
beforeAll(async () => {
  const FIX = fileURLToPath(new URL('../fixtures/tiny-session/', import.meta.url));
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'virtumetry-mock-'));
  const storage: LocalStorage = createLocalStorage({
    LOCAL_STORAGE_DIR: dir,
    PUBLIC_BASE_URL: 'http://localhost:8080',
  } as unknown as Config);
  const cid = randomUUID();
  for (const f of ['session.json', 'frames.jsonl']) {
    await storage.putObject(captureKey(cid, f), readFileSync(path.join(FIX, f)));
  }
  for (const f of readdirSync(path.join(FIX, 'frames'))) {
    await storage.putObject(captureKey(cid, `frames/${f}`), readFileSync(path.join(FIX, 'frames', f)));
  }
  const res = await packCapture(storage, cid, { minFrames: 1, maxFrames: 5000 });
  bundleFile = storage.resolvePath(res.bundleKey);
});
afterAll(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

describe('free endpoints', () => {
  it('limits and quote = 900 + frames', async () => {
    const p = createMockProvider();
    expect(p.mode).toBe('mock');
    expect(await p.limits()).toEqual({ minFrames: 1, maxFrames: 5000 });
    expect((await p.quote(30)).credits).toBe(930);
    await expectProviderError(p.quote(5001), 400, 'CAPTURE_FRAME_LIMIT_EXCEEDED');
  });
});

describe('idempotency', () => {
  it('same key + same body → same request; different body → 409', async () => {
    const p = createMockProvider({ fetchImpl: statusFetch(404) });
    const a = await p.submit(body(), 'k1');
    const b = await p.submit(body(), 'k1');
    expect(a.requestId).toMatch(/^req_/);
    expect(b.requestId).toBe(a.requestId);
    expect(p.calls.submit).toHaveLength(2);
    await expectProviderError(p.submit(body(ZIP_URL, 'other'), 'k1'), 409, 'IDEMPOTENCY_KEY_REUSED');
    expect((await p.submit(body(), 'k2')).requestId).not.toBe(a.requestId);
  });
});

describe('scenarios', () => {
  it("'402' always refuses with INSUFFICIENT_CREDITS", async () => {
    const p = createMockProvider({ scenario: '402' });
    await expectProviderError(p.submit(body(), 'k'), 402, 'INSUFFICIENT_CREDITS');
    await expectProviderError(p.submit(body(), 'k'), 402, 'INSUFFICIENT_CREDITS');
  });

  it("'409' always refuses with IDEMPOTENCY_KEY_REUSED", async () => {
    const p = createMockProvider({ scenario: '409' });
    await expectProviderError(p.submit(body(), 'k'), 409, 'IDEMPOTENCY_KEY_REUSED');
    await expectProviderError(p.submit(body(), 'k'), 409, 'IDEMPOTENCY_KEY_REUSED');
  });

  it.each([
    ['429', 'RATE_LIMIT_EXCEEDED'],
    ['503', 'WORLD_INTAKE_UNAVAILABLE'],
  ] as const)("'%s' fails once with Retry-After, then the same key+body succeeds", async (scenario, code) => {
    const p = createMockProvider({ scenario, retryAfterS: 7, fetchImpl: statusFetch(404) });
    const err = await expectProviderError(p.submit(body(), 'k'), Number(scenario), code);
    expect(err.retryAfterS).toBe(7);
    expect((await p.submit(body(), 'k')).requestId).toMatch(/^req_/);
    const d = createMockProvider({ scenario, fetchImpl: statusFetch(404) });
    expect((await expectProviderError(d.submit(body(), 'k'), Number(scenario), code)).retryAfterS).toBe(1);
  });

  it("'happy' stays PROCESSING until processingSeconds, then COMPLETED", async () => {
    let t = 1_000_000;
    const p = createMockProvider({ processingSeconds: 10, now: () => t, fetchImpl: fileFetch(bundleFile) });
    const { requestId } = await p.submit(body(), 'k');
    const s0 = await p.status(requestId);
    expect(s0.status).toBe('PROCESSING');
    t += 9_999;
    expect((await p.status(requestId)).status).toBe('PROCESSING');
    t += 1;
    const done = await p.status(requestId);
    expect(done).toMatchObject({ status: 'COMPLETED', progress: 1 });
    expect(done.issues ?? []).toEqual([]);
  });

  it("'failed' ends FAILED with WORLD_GENERATION_FAILED", async () => {
    const p = createMockProvider({ scenario: 'failed', fetchImpl: fileFetch(bundleFile) });
    const { requestId } = await p.submit(body(), 'k');
    const s = await p.status(requestId);
    expect(s.status).toBe('FAILED');
    expect(s.error?.code).toBe('WORLD_GENERATION_FAILED');
  });

  it('an unreadable bundle (non-206 Range preflight) ends FAILED with ZIP_UNREADABLE', async () => {
    const p = createMockProvider({ fetchImpl: statusFetch(404) });
    const { requestId } = await p.submit(body(), 'k');
    const s = await p.status(requestId);
    expect(s.status).toBe('FAILED');
    expect(s.issues?.map((i) => i.code)).toEqual(['ZIP_UNREADABLE']);
  });

  it('cancel → CANCELLED', async () => {
    const p = createMockProvider({ processingSeconds: 60, fetchImpl: fileFetch(bundleFile) });
    const { requestId } = await p.submit(body(), 'k');
    await p.cancel(requestId);
    expect((await p.status(requestId)).status).toBe('CANCELLED');
    await expectProviderError(p.status('req_unknown'), 404, 'NOT_FOUND');
  });
});

describe('exports and artifacts', () => {
  it('mesh export is pending once then ready; floorplan is ready', async () => {
    const p = createMockProvider({ fetchImpl: fileFetch(bundleFile) });
    const { requestId } = await p.submit(body(), 'k');
    expect(await p.ensureExport(requestId, 'mesh-simplified')).toBe('pending');
    expect(await p.ensureExport(requestId, 'mesh-simplified')).toBe('ready');
    expect(await p.ensureExport(requestId, 'floorplan')).toBe('ready');
  });

  it('lists and streams the committed placeholder outputs', async () => {
    const p = createMockProvider({ fetchImpl: fileFetch(bundleFile) });
    const { requestId } = await p.submit(body(), 'k');
    const arts = await p.artifacts(requestId);
    expect(arts.map((a) => a.name).sort()).toEqual(
      ['cameras.json', 'collider.ply', 'floorplan.json', 'floorplan.png', 'splat.ply'].sort(),
    );
    const by = new Map(arts.map((a) => [a.name, a]));
    expect((await readAll(await p.open(by.get('splat.ply')!))).subarray(0, 3).toString()).toBe('ply');
    expect((await readAll(await p.open(by.get('collider.ply')!))).subarray(0, 3).toString()).toBe('ply');
    const png = await readAll(await p.open(by.get('floorplan.png')!));
    expect(png.subarray(0, 8)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
    const cams = JSON.parse((await readAll(await p.open(by.get('cameras.json')!))).toString());
    expect(cams.schema_version).toBe('spaitial.capture_cameras.v1');
  });

  it('open() refuses names outside the artifact allowlist', async () => {
    const p = createMockProvider();
    const evil: Artifact = { kind: 'splat', name: '../../../.env', contentType: 'text/plain', ref: '../../../.env' };
    await expect(p.open(evil)).rejects.toBeInstanceOf(ProviderError);
  });
});

describe('webhooks', () => {
  const mk = (scenario: (typeof MOCK_SCENARIOS)[number]) => {
    const deliver = vi.fn(async (_raw: Buffer, _headers: Record<string, string>) => undefined);
    const p = createMockProvider({
      scenario,
      webhookSecret: SECRET,
      deliver,
      fetchImpl: fileFetch(bundleFile),
    });
    return { p, deliver };
  };

  it.each([
    ['happy', 'world.completed'],
    ['failed', 'world.failed'],
  ] as const)("'%s' delivers one signed %s", async (scenario, event) => {
    const { p, deliver } = mk(scenario);
    const { requestId } = await p.submit(body(), 'k');
    await vi.waitFor(() => expect(deliver).toHaveBeenCalledTimes(1));
    const [raw, h] = deliver.mock.calls[0]!;
    expect(h['X-Spaitial-Event']).toBe(event);
    expect(h['X-Spaitial-Request-ID']).toBe(requestId);
    expect(h['X-Spaitial-Delivery-ID']).toMatch(/^wd_[0-9a-f-]{36}$/);
    expect(h['X-Spaitial-Delivery-Attempt']).toBe('1');
    expect(verifyWebhookSignature(SECRET, raw, h['X-Spaitial-Signature'])).toBe(true);
    expect(p.verifyWebhook(raw, h['X-Spaitial-Signature'])).toBe(true);
    expect(JSON.parse(raw.toString())).toMatchObject({ event, request_id: requestId });
  });

  it("'duplicate_webhooks' delivers the same delivery id twice", async () => {
    const { p, deliver } = mk('duplicate_webhooks');
    await p.submit(body(), 'k');
    await vi.waitFor(() => expect(deliver).toHaveBeenCalledTimes(2));
    const [a, b] = deliver.mock.calls.map((c) => c[1]);
    expect(a!['X-Spaitial-Delivery-ID']).toBe(b!['X-Spaitial-Delivery-ID']);
    expect(b!['X-Spaitial-Delivery-Attempt']).toBe('2');
  });

  it("'webhook_dropped' delivers nothing, but status still completes", async () => {
    const { p, deliver } = mk('webhook_dropped');
    const { requestId } = await p.submit(body(), 'k');
    await new Promise((r) => setTimeout(r, 50));
    expect(deliver).not.toHaveBeenCalled();
    expect((await p.status(requestId)).status).toBe('COMPLETED');
  });

  it('verifyWebhookSignature fails closed', () => {
    const raw = Buffer.from('{"a":1}');
    const good = signWebhook(SECRET, raw);
    expect(good).toMatch(/^sha256=[0-9a-f]{64}$/);
    expect(verifyWebhookSignature(SECRET, raw, good)).toBe(true);
    expect(verifyWebhookSignature(SECRET, raw, signWebhook('wrong', raw))).toBe(false);
    expect(verifyWebhookSignature(SECRET, Buffer.from('{"a":2}'), good)).toBe(false);
    expect(verifyWebhookSignature(SECRET, raw, undefined)).toBe(false);
    expect(verifyWebhookSignature(undefined, raw, good)).toBe(false);
    expect(verifyWebhookSignature('', raw, good)).toBe(false);
  });
});

describe('createProvider', () => {
  it('mock mode wires MOCK_SCENARIO and the webhook secret', async () => {
    const p = createProvider({
      PROVIDER_MODE: 'mock',
      MOCK_SCENARIO: '402',
      MOCK_PROCESSING_SECONDS: 0,
      SPAITIAL_WEBHOOK_SECRET: SECRET,
    } as Config);
    expect(p.mode).toBe('mock');
    await expectProviderError(p.submit(body(), 'k'), 402, 'INSUFFICIENT_CREDITS');
    const raw = Buffer.from('x');
    expect(p.verifyWebhook(raw, signWebhook(SECRET, raw))).toBe(true);
  });

  it('live mode throws (Phase 6)', () => {
    expect(() => createProvider({ PROVIDER_MODE: 'live' } as Config)).toThrow(
      'no live provider in this build (Phase 6)',
    );
  });

  it('every MOCK_SCENARIO is covered above', () => {
    expect([...MOCK_SCENARIOS].sort()).toEqual(
      ['402', '409', '429', '503', 'duplicate_webhooks', 'failed', 'happy', 'webhook_dropped'].sort(),
    );
  });
});
