import { Readable } from 'node:stream';
import type { ReadableStream as WebReadableStream } from 'node:stream/web';
import {
  ProviderError,
  ProviderTimeoutError,
  verifyWebhookSignature,
  type Artifact,
  type ProviderLimits,
  type ReconProvider,
} from './types.js';

// Live Echo-3 client (D-01..D-03), stdlib fetch only. It never retries: retry
// policy (and the exactly-once ledger) lives in the pipeline. Built only behind
// the D-04 boot guard (ALLOW_PAID_PROVIDER=1 + both secrets + https base).
// Errors carry endpoint + status + code only — never the URL, body or key.

/** Must stay well under LEASE_SECONDS/2 so two runs of one submit job can't overlap. */
export const T_SUBMIT_MS = 60_000;
const T_CALL_MS = 30_000;
const T_DOWNLOAD_MS = 15 * 60_000; // covers the whole body of a 100+ MB splat
const LIMITS_TTL_MS = 60 * 60_000;
const REQ_PREFIX = '/v1/worlds/requests/';

/** Retry-After as seconds or HTTP date → whole seconds (≥ 0), else undefined. */
export function parseRetryAfter(h: string | null | undefined, now = Date.now()): number | undefined {
  if (!h) return undefined;
  const s = Number(h);
  if (Number.isFinite(s)) return Math.max(0, Math.ceil(s));
  const t = Date.parse(h);
  return Number.isFinite(t) ? Math.max(0, Math.ceil((t - now) / 1000)) : undefined;
}

function isThumbnailUrl(u: unknown): u is string {
  if (typeof u !== 'string' || !URL.canParse(u)) return false;
  const url = new URL(u);
  return url.protocol === 'https:' && url.hostname.endsWith('.spaitial.ai');
}

const LOOPBACK = new Set(['127.0.0.1', 'localhost', '[::1]']);

/**
 * WR-02 SSRF guard for every credential-less GET (signed storage URLs,
 * thumbnails): https, a DNS name (no IP literal), no internal suffix. Loopback
 * passes only when the API base itself is loopback — the test fake; config
 * refuses a non-https live base.
 * ponytail: hostname-only check; a public name that resolves to a private IP
 * (DNS rebinding) still passes. Pin resolved addresses if storage hosts get untrusted.
 */
export function downloadAllowed(url: URL, loopbackOk = false): boolean {
  const h = url.hostname.toLowerCase().replace(/\.$/, '');
  if (loopbackOk && LOOPBACK.has(h) && (url.protocol === 'http:' || url.protocol === 'https:')) return true;
  if (url.protocol !== 'https:') return false;
  if (h.startsWith('[') || /^[\d.]+$/.test(h)) return false; // WHATWG URL normalizes every IPv4 form to dotted
  return h.includes('.') && !/(^|\.)(localhost|local|localdomain|internal|home\.arpa)$/.test(h);
}

type Envelope = {
  world?: { thumbnail_url?: unknown } | null;
  validation?: { issues?: { code?: string; message?: string }[] } | null;
  error?: { code?: string; message?: string } | null;
};

export function createEcho3Provider(o: {
  apiKey: string;
  baseUrl: string;
  webhookSecret: string;
  fetch?: typeof fetch;
  timeouts?: { submit?: number; call?: number; download?: number };
}): ReconProvider {
  const f = o.fetch ?? fetch;
  const base = o.baseUrl.replace(/\/$/, '');
  const loopbackOk = LOOPBACK.has(new URL(base).hostname);
  const tSubmit = o.timeouts?.submit ?? T_SUBMIT_MS;
  const tCall = o.timeouts?.call ?? T_CALL_MS;
  const tDownload = o.timeouts?.download ?? T_DOWNLOAD_MS;
  let limitsCache: { value: ProviderLimits; at: number } | undefined;

  const req = (id: string) => `${REQ_PREFIX}${encodeURIComponent(id)}`;

  async function call(
    endpoint: string,
    path: string,
    init: { method?: string; body?: string; headers?: Record<string, string>; timeoutMs?: number } = {},
  ): Promise<Response> {
    let res: Response;
    try {
      res = await f(`${base}${path}`, {
        method: init.method ?? 'GET',
        body: init.body,
        redirect: 'manual',
        headers: { Authorization: `Bearer ${o.apiKey}`, Accept: 'application/json', ...init.headers },
        signal: AbortSignal.timeout(init.timeoutMs ?? tCall),
      });
    } catch (err) {
      if ((err as Error)?.name === 'TimeoutError') throw new ProviderTimeoutError(`${endpoint} timed out`, endpoint);
      // No status = uncertain (the request may or may not have landed).
      throw new ProviderError(`${endpoint} network error`, { endpoint, cause: err });
    }
    if (res.status >= 400) {
      const env = (await res.json().catch(() => null)) as { error?: { code?: unknown } } | null;
      const code = typeof env?.error?.code === 'string' ? env.error.code : `HTTP_${res.status}`;
      throw new ProviderError(`${endpoint} ${res.status} ${code}`, {
        status: res.status,
        endpoint,
        code,
        retryAfterS: parseRetryAfter(res.headers.get('retry-after')),
      });
    }
    return res;
  }

  async function getJson<T>(endpoint: string, path: string): Promise<T> {
    const res = await call(endpoint, path);
    try {
      return (await res.json()) as T;
    } catch (err) {
      throw new ProviderError(`${endpoint} returned non-JSON`, { status: res.status, endpoint, cause: err });
    }
  }

  const stream = (res: Response, endpoint: string): Readable => {
    if (!res.body) throw new ProviderError(`${endpoint} empty body`, { status: res.status, endpoint });
    return Readable.fromWeb(res.body as unknown as WebReadableStream);
  };

  /** GET without any credentials (signed storage URLs, public thumbnails). */
  async function bareGet(endpoint: string, url: URL): Promise<Readable> {
    if (!downloadAllowed(url, loopbackOk)) {
      throw new ProviderError(`${endpoint}: refusing download host`, { endpoint });
    }
    let res: Response;
    try {
      // No redirect is followed: each hop would skip the host check above.
      res = await f(url, { redirect: 'manual', signal: AbortSignal.timeout(tDownload) });
    } catch (err) {
      if ((err as Error)?.name === 'TimeoutError') throw new ProviderTimeoutError(`${endpoint} timed out`, endpoint);
      throw new ProviderError(`${endpoint} network error`, { endpoint, cause: err });
    }
    if (!res.ok) {
      await res.body?.cancel();
      throw new ProviderError(`${endpoint} ${res.status}`, { status: res.status, endpoint, code: `HTTP_${res.status}` });
    }
    return stream(res, endpoint);
  }

  const cancel = async (requestId: string): Promise<void> => {
    try {
      const res = await call('cancel', `${req(requestId)}/cancel`, { method: 'POST' });
      await res.body?.cancel();
    } catch (err) {
      if (err instanceof ProviderError && err.status === 409 && err.code === 'REQUEST_NOT_CANCELLABLE') return;
      throw err;
    }
  };

  return {
    mode: 'live',

    async limits() {
      if (limitsCache && Date.now() - limitsCache.at < LIMITS_TTL_MS) return limitsCache.value;
      const b = await getJson<{ min_frames: number; max_frames: number }>('limits', '/v1/captures/limits');
      limitsCache = { value: { minFrames: b.min_frames, maxFrames: b.max_frames }, at: Date.now() };
      return limitsCache.value;
    },

    async quote(frameCount) {
      const b = await getJson<{ required_credits: number; available_credits: number }>(
        'quote',
        `/v1/captures/process-quote?model=echo-3&frame_count=${encodeURIComponent(frameCount)}`,
      );
      return { credits: b.required_credits, available: b.available_credits };
    },

    async submit(body, idempotencyKey) {
      // `body` goes out byte-for-byte: same key + same bytes is the only replay
      // SpAItial treats as "no new job".
      const res = await call('submit', '/v1/worlds', {
        method: 'POST',
        body,
        timeoutMs: tSubmit,
        headers: { 'Content-Type': 'application/json', 'Idempotency-Key': idempotencyKey },
      });
      let requestId: unknown;
      try {
        requestId = ((await res.json()) as { request_id?: unknown }).request_id;
      } catch (err) {
        throw new ProviderError('submit response unreadable', { endpoint: 'submit', cause: err });
      }
      if ((res.status !== 200 && res.status !== 202) || typeof requestId !== 'string' || !/^req_/.test(requestId)) {
        // No status on purpose: the world may exist, so this is "uncertain".
        throw new ProviderError(`submit unexpected response ${res.status}`, { endpoint: 'submit' });
      }
      return { requestId };
    },

    async status(requestId) {
      const s = await getJson<{ status: string; progress?: unknown; error?: { code: string; message: string } }>(
        'status',
        `${req(requestId)}/status`,
      );
      const out: Awaited<ReturnType<ReconProvider['status']>> = {
        status: s.status,
        progress: typeof s.progress === 'number' ? s.progress : null,
        ...(s.error ? { error: { code: s.error.code, message: s.error.message } } : {}),
      };
      if (s.status === 'FAILED') {
        const env = await getJson<Envelope>('envelope', req(requestId));
        const issues = (env.validation?.issues ?? [])
          .filter((i) => typeof i.code === 'string')
          .map((i) => ({ code: i.code!, message: i.message ?? i.code! }));
        if (issues.length > 0) out.issues = issues;
        if (!out.error && env.error?.code) out.error = { code: env.error.code, message: env.error.message ?? '' };
      }
      return out;
    },

    async ensureExport(requestId, kind) {
      const path = `${req(requestId)}/exports/${kind}`;
      let st: string;
      try {
        st = (await getJson<{ status: string }>('export', path)).status;
      } catch (err) {
        if (!(err instanceof ProviderError && err.status === 404)) throw err;
        st = 'NOT_REQUESTED';
      }
      if (st === 'READY') return 'ready';
      if (st === 'FAILED') return 'failed';
      if (st !== 'NOT_REQUESTED') return 'pending';
      try {
        const res = await call('export', path, { method: 'POST' });
        await res.body?.cancel();
        return res.status === 200 ? 'ready' : 'pending';
      } catch (err) {
        if (err instanceof ProviderError && err.status === 409 && err.code === 'RESOURCE_NOT_READY') return 'pending';
        throw err;
      }
    },

    async artifacts(requestId) {
      const env = await getJson<Envelope>('envelope', req(requestId));
      const r = req(requestId);
      const out: Artifact[] = [
        { kind: 'splat', name: 'splat.spz', contentType: 'application/octet-stream', ref: `${r}/splat` },
        {
          kind: 'collider',
          name: 'collider.ply',
          contentType: 'application/octet-stream',
          ref: `${r}/exports/mesh-simplified?download=1`,
        },
        { kind: 'floorplan', name: 'floorplan.png', contentType: 'image/png', ref: `${r}/exports/floorplan?download=1` },
        {
          kind: 'floorplan_meta',
          name: 'floorplan.json',
          contentType: 'application/json',
          ref: `json:${r}/exports/floorplan`,
        },
        { kind: 'cameras', name: 'cameras.json', contentType: 'application/json', ref: `${r}/cameras` },
      ];
      const thumb = env.world?.thumbnail_url;
      if (isThumbnailUrl(thumb)) {
        out.push({ kind: 'thumbnail', name: 'thumbnail.jpg', contentType: 'image/jpeg', ref: thumb });
      }
      return out;
    },

    async open(artifact) {
      const ref = artifact.ref;
      // SSRF guard (T-06-04): checked before any fetch.
      if (artifact.kind === 'thumbnail' && isThumbnailUrl(ref)) return bareGet('thumbnail', new URL(ref));
      const apiPath = ref.startsWith('json:') ? ref.slice(5) : ref;
      if (!apiPath.startsWith(REQ_PREFIX) || apiPath.includes('..')) {
        throw new ProviderError(`refusing artifact ref outside ${REQ_PREFIX}`, { endpoint: 'download' });
      }
      if (ref.startsWith('json:')) {
        const b = await getJson<{ floorplan?: unknown }>('export', apiPath);
        if (b.floorplan === undefined) throw new ProviderError('export has no floorplan block', { endpoint: 'export' });
        return Readable.from([JSON.stringify(b.floorplan)]);
      }
      const res = await call('download', apiPath, { timeoutMs: tDownload });
      if (res.status >= 300 && res.status < 400) {
        const loc = res.headers.get('location');
        await res.body?.cancel();
        if (!loc) throw new ProviderError('download redirect without location', { status: res.status, endpoint: 'download' });
        // Second fetch carries NO Authorization: the key never reaches the storage host (T-06-02).
        return bareGet('download', new URL(loc, base));
      }
      return stream(res, 'download');
    },

    cancel,

    async deleteWorld(requestId) {
      try {
        const res = await call('delete', req(requestId), { method: 'DELETE' });
        await res.body?.cancel();
      } catch (err) {
        if (err instanceof ProviderError && err.status === 409 && err.code === 'RESOURCE_NOT_DELETABLE') {
          await cancel(requestId); // still active: cancel now, purge retries the delete
        }
        throw err;
      }
    },

    verifyWebhook(raw, header) {
      return verifyWebhookSignature(o.webhookSecret, raw, header);
    },
  };
}
