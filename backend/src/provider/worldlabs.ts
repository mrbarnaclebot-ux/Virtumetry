import {
  creditsForModel,
  ProviderError,
  ProviderTimeoutError,
  type OperationStatus,
  type WorldAssets,
  type WorldGenProvider,
  type WorldMatch,
  type WorldModel,
} from './types.js';

// Live World Labs Marble provider. This is a faithful TypeScript port of
// tools/spike/spike.py (the LIVE-VERIFIED contract). Endpoint shapes, field
// names, and the tolerant fallbacks (media_asset.media_asset_id ?? .id, etc.)
// are copied deliberately — do not "clean up" without re-verifying live.
//
// Auth: header `WLT-Api-Key: <key>` (server-side only — never shipped in the
// app, spec §4/§14). Base URL https://api.worldlabs.ai.

const DEFAULT_BASE_URL = 'https://api.worldlabs.ai';
const DEFAULT_TIMEOUT_MS = 120_000; // matches spike.py urlopen timeout=120.

/** World Labs rejects a longer worlds:generate display_name with a 422. */
export const MAX_DISPLAY_NAME = 64;

// --- Asset download hardening (spec §10 R10) ---------------------------------
//
// getWorld() returns asset URLs chosen by the PROVIDER. downloadAsset used to
// fetch whatever came back, with our API key attached and no size ceiling — so a
// compromised or buggy provider response could exfiltrate the key to any host it
// named, or hand the worker a multi-gigabyte body to buffer.

/**
 * Hosts assets may be fetched from when `WORLDLABS_ASSET_HOSTS` is unset. The
 * API host serves nothing but the API; `cdn.marble.worldlabs.ai` is the CDN the
 * Phase 0 spike observed serving SPZ/GLB/thumbnail assets (spec §10 risk table).
 * A leading dot means "this host or any subdomain of it".
 */
export const DEFAULT_ASSET_HOSTS = ['api.worldlabs.ai', '.worldlabs.ai'];

/** Redirects downloadAsset follows (each re-checked) before giving up. */
export const MAX_ASSET_REDIRECTS = 3;
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

/** Default ceiling on a single downloaded asset (200 MB). */
export const DEFAULT_ASSET_MAX_BYTES = 200 * 1024 * 1024;

/** Parse a comma-separated host allowlist; falls back to DEFAULT_ASSET_HOSTS. */
export function parseAssetHosts(csv?: string): string[] {
  const entries = (csv ?? '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  return entries.length > 0 ? entries : DEFAULT_ASSET_HOSTS;
}

/**
 * True for hostnames that are IP literals in a private, loopback, link-local or
 * otherwise non-routable range.
 *
 * Defence in depth: the allowlist above already excludes these, so this only
 * fires if someone puts an address in `WORLDLABS_ASSET_HOSTS`. It refuses to let
 * a misconfiguration turn asset fetching into an SSRF primitive against the
 * container's own network (link-local 169.254.169.254 is the cloud metadata
 * endpoint on every major provider).
 */
export function isNonRoutableHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (host === 'localhost' || host.endsWith('.localhost')) return true;

  // IPv4 literal.
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (v4) {
    const [a, b] = [Number(v4[1]), Number(v4[2])];
    if (a === 0 || a === 10 || a === 127) return true;
    if (a === 169 && b === 254) return true; // link-local incl. cloud metadata
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
    return false;
  }

  // IPv6 literal.
  if (host.includes(':')) {
    if (host === '::' || host === '::1') return true;
    if (/^f[cd][0-9a-f]{2}:/.test(host)) return true; // unique-local fc00::/7
    if (/^fe[89ab][0-9a-f]:/.test(host)) return true; // link-local fe80::/10
    // IPv4-mapped (::ffff:127.0.0.1) — re-check the embedded address.
    const mapped = /::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/.exec(host);
    if (mapped?.[1]) return isNonRoutableHost(mapped[1]);
    return false;
  }

  return false;
}

/** True when `host` matches an allowlist entry (exact, or `.suffix` subdomain). */
export function hostAllowed(host: string, allowlist: string[]): boolean {
  const h = host.toLowerCase();
  return allowlist.some((entry) =>
    entry.startsWith('.') ? h === entry.slice(1) || h.endsWith(entry) : h === entry,
  );
}

/**
 * Validate a provider-supplied asset URL. Returns the parsed URL or throws.
 * https only: the key must never ride a plaintext request, and an asset fetched
 * over http could be swapped in transit.
 */
export function assertDownloadableUrl(raw: string, allowlist: string[]): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new ProviderError(`asset URL is not a valid URL: ${raw}`, { endpoint: raw });
  }
  if (url.protocol !== 'https:') {
    throw new ProviderError(`asset URL must be https, got ${url.protocol}`, {
      endpoint: raw,
    });
  }
  if (isNonRoutableHost(url.hostname)) {
    throw new ProviderError(`asset URL host is non-routable: ${url.hostname}`, {
      endpoint: raw,
    });
  }
  if (!hostAllowed(url.hostname, allowlist)) {
    throw new ProviderError(
      `asset URL host ${url.hostname} is not in the allowlist (${allowlist.join(', ')})`,
      { endpoint: raw },
    );
  }
  return url;
}

/** Injectable fetch (Node 24 global) so tests can assert request shaping. */
export type FetchLike = typeof fetch;

export interface WorldLabsOptions {
  apiKey: string;
  baseUrl?: string;
  fetchImpl?: FetchLike;
  timeoutMs?: number;
  /** Comma-separated host allowlist for asset downloads (spec §10 R10). */
  assetHosts?: string;
  /** Byte ceiling for a single downloaded asset. */
  assetMaxBytes?: number;
}

/**
 * Read a response body, aborting as soon as it exceeds `cap` bytes.
 *
 * Streams rather than `arrayBuffer()`: the point is to stop a hostile or broken
 * response BEFORE it is fully in memory, so checking the size afterwards would
 * be too late. Content-Length is honoured as a fast path but never trusted — it
 * is attacker-controlled and may be absent under chunked encoding.
 */
async function readBodyCapped(
  res: Response,
  cap: number,
  url: string,
  abort: AbortController,
): Promise<Buffer> {
  const declared = Number(res.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > cap) {
    abort.abort();
    throw new ProviderError(
      `asset exceeds the ${cap}-byte cap (Content-Length ${declared})`,
      { endpoint: url },
    );
  }

  if (!res.body) {
    // No stream available (some test doubles, HEAD-like responses).
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.byteLength > cap) {
      throw new ProviderError(
        `asset exceeds the ${cap}-byte cap (${buf.byteLength} bytes)`,
        { endpoint: url },
      );
    }
    return buf;
  }

  const reader = res.body.getReader();
  const chunks: Buffer[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > cap) {
      // Stop the transfer instead of draining it.
      await reader.cancel().catch(() => undefined);
      abort.abort();
      throw new ProviderError(
        `asset exceeds the ${cap}-byte cap (aborted after ${total} bytes)`,
        { endpoint: url },
      );
    }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks, total);
}

interface PrepareUploadResponse {
  media_asset?: { media_asset_id?: string; id?: string };
  upload_info?: {
    upload_url: string;
    upload_method?: string;
    required_headers?: Record<string, string> | null;
  };
}

export function createWorldLabsProvider(opts: WorldLabsOptions): WorldGenProvider {
  const baseUrl = (opts.baseUrl ?? DEFAULT_BASE_URL).replace(/\/$/, '');
  const doFetch: FetchLike = opts.fetchImpl ?? fetch;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const assetHosts = parseAssetHosts(opts.assetHosts);
  const assetMaxBytes = opts.assetMaxBytes ?? DEFAULT_ASSET_MAX_BYTES;

  const jsonHeaders = (): Record<string, string> => ({
    'WLT-Api-Key': opts.apiKey,
    'Content-Type': 'application/json',
  });

  // Core request helper with an AbortController timeout + typed errors.
  async function request(
    method: string,
    url: string,
    init?: { headers?: Record<string, string>; body?: string | Uint8Array },
  ): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      return await doFetch(url, {
        method,
        headers: init?.headers ?? jsonHeaders(),
        body: init?.body,
        signal: controller.signal,
        // Spec §10 R29: fetch follows redirects by default and would carry
        // WLT-Api-Key to wherever a 3xx points. The API never redirects, so a
        // redirect is refused outright (surfaces as a network ProviderError).
        redirect: 'error',
      });
    } catch (err) {
      if (err instanceof Error && err.name === 'AbortError') {
        throw new ProviderTimeoutError(`request timed out after ${timeoutMs}ms`, url);
      }
      throw new ProviderError(`network error: ${String(err)}`, { endpoint: url, cause: err });
    } finally {
      clearTimeout(timer);
    }
  }

  async function requestJson<T>(
    method: string,
    path: string,
    body?: unknown,
  ): Promise<T> {
    const url = `${baseUrl}${path}`;
    const res = await request(method, url, {
      headers: jsonHeaders(),
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new ProviderError(`${method} ${path} failed: ${res.status} ${text}`.trim(), {
        status: res.status,
        endpoint: url,
      });
    }
    return (await res.json()) as T;
  }

  return {
    mode: 'live',
    creditsForModel,

    async uploadPano(bytes, filename): Promise<string> {
      // 1. prepare_upload (FREE) — mirrors spike.stage_upload.
      const prep = await requestJson<PrepareUploadResponse>(
        'POST',
        '/marble/v1/media-assets:prepare_upload',
        { file_name: filename, kind: 'image', extension: 'jpg' },
      );
      const mediaAssetId =
        prep.media_asset?.media_asset_id ?? prep.media_asset?.id;
      const upload = prep.upload_info;
      if (!mediaAssetId || !upload?.upload_url) {
        throw new ProviderError('prepare_upload returned no media_asset_id/upload_url', {
          endpoint: '/marble/v1/media-assets:prepare_upload',
        });
      }
      // 2. PUT the bytes to the signed URL with the provider's required headers
      //    plus a default Content-Type (spike: put_hdrs.setdefault image/jpeg).
      const method = upload.upload_method ?? 'PUT';
      const putHeaders: Record<string, string> = { ...(upload.required_headers ?? {}) };
      if (!('Content-Type' in putHeaders) && !('content-type' in putHeaders)) {
        putHeaders['Content-Type'] = 'image/jpeg';
      }
      const putRes = await request(method, upload.upload_url, {
        headers: putHeaders,
        // Node fetch accepts a Uint8Array/Buffer body.
        body: new Uint8Array(bytes),
      });
      if (putRes.status !== 200 && putRes.status !== 201) {
        const text = await putRes.text().catch(() => '');
        throw new ProviderError(`pano PUT failed: ${putRes.status} ${text}`.trim(), {
          status: putRes.status,
          endpoint: upload.upload_url,
        });
      }
      return mediaAssetId;
    },

    async generateWorld(mediaAssetId, model: WorldModel, displayName): Promise<string> {
      // worlds:generate (SPENDS CREDITS). NEVER retried internally — a resumed
      // worker resumes via the persisted operation_id instead (spec §14).
      if (displayName.length > MAX_DISPLAY_NAME) {
        throw new Error(
          `display_name is ${displayName.length} chars; World Labs allows at most ${MAX_DISPLAY_NAME}`,
        );
      }
      const body = await requestJson<Record<string, unknown>>(
        'POST',
        '/marble/v1/worlds:generate',
        {
          display_name: displayName,
          model,
          world_prompt: {
            type: 'image',
            image_prompt: { source: 'media_asset', media_asset_id: mediaAssetId },
            is_pano: true,
          },
        },
      );
      const operationId =
        (body['operation_id'] as string | undefined) ??
        (body['id'] as string | undefined) ??
        (body['name'] as string | undefined);
      if (!operationId) {
        throw new ProviderError('worlds:generate returned no operation_id', {
          endpoint: '/marble/v1/worlds:generate',
        });
      }
      return operationId;
    },

    async getOperation(operationId): Promise<OperationStatus> {
      const body = await requestJson<Record<string, unknown>>(
        'GET',
        `/marble/v1/operations/${operationId}`,
      );
      const done = Boolean(body['done']);
      const error = body['error'];
      const response = (body['response'] as Record<string, unknown> | undefined) ?? {};
      const world = response['world'] as Record<string, unknown> | undefined;
      const worldId =
        (response['world_id'] as string | undefined) ??
        (response['id'] as string | undefined) ??
        (world?.['id'] as string | undefined);
      const result: OperationStatus = { done };
      if (worldId) result.worldId = worldId;
      if (error) {
        result.error =
          typeof error === 'string' ? error : JSON.stringify(error);
      }
      return result;
    },

    async findWorldByDisplayName(displayName): Promise<WorldMatch | null> {
      // Reconciliation lookup for a `pending:<jobId>` marker (spec §10 R1). FREE
      // — it lists worlds this key already owns; it never generates.
      //
      // ⚠️ UNVERIFIED SHAPE. Unlike every other call in this file, the list
      // endpoint was NOT exercised by tools/spike/spike.py against the live API,
      // so both the path and the response envelope are best-effort guesses at
      // the documented `GET /marble/v1/worlds` listing, parsed tolerantly (any
      // of `worlds` / `items` / `results`, and id/display-name aliases). If the
      // endpoint 404s or the shape differs, requestJson throws a ProviderError,
      // which the worker treats as RETRYABLE reconciliation failure — the job
      // retries the lookup and is eventually parked; it NEVER re-generates. So
      // a wrong guess costs a stalled job, never a double bill. Verify against
      // the live API before relying on automatic recovery.
      const body = await requestJson<Record<string, unknown>>(
        'GET',
        '/marble/v1/worlds?page_size=100',
      );
      const list =
        (body['worlds'] as unknown[] | undefined) ??
        (body['items'] as unknown[] | undefined) ??
        (body['results'] as unknown[] | undefined) ??
        [];
      for (const entry of list) {
        const w = entry as Record<string, unknown>;
        const name =
          (w['display_name'] as string | undefined) ?? (w['name'] as string | undefined);
        if (name !== displayName) continue;
        const worldId =
          (w['world_id'] as string | undefined) ?? (w['id'] as string | undefined);
        if (!worldId) continue;
        const match: WorldMatch = { worldId };
        const operationId = w['operation_id'] as string | undefined;
        if (operationId) match.operationId = operationId;
        const status = (w['status'] as string | undefined) ?? (w['state'] as string | undefined);
        if (status) {
          // Anything that isn't an explicit terminal-success state is treated as
          // "still running" → reconcile again later rather than adopt an
          // unfinished world.
          match.done = /^(done|complete|completed|succeeded|ready)$/i.test(status);
        }
        return match;
      }
      return null;
    },

    async getWorld(worldId): Promise<WorldAssets> {
      const body = await requestJson<Record<string, unknown>>(
        'GET',
        `/marble/v1/worlds/${worldId}`,
      );
      const assets = (body['assets'] as Record<string, unknown> | undefined) ?? {};
      const splats = (assets['splats'] as Record<string, unknown> | undefined) ?? {};
      const spz = (splats['spz_urls'] as Record<string, string> | undefined) ?? {};
      const mesh = (assets['mesh'] as Record<string, unknown> | undefined) ?? {};

      const out: WorldAssets = { spzUrls: {} };
      if (spz['100k']) out.spzUrls.k100 = spz['100k'];
      if (spz['500k']) out.spzUrls.k500 = spz['500k'];
      if (spz['full_res']) out.spzUrls.full = spz['full_res'];
      const collider = mesh['collider_mesh_url'] as string | undefined;
      if (collider) out.colliderMeshUrl = collider;
      const thumb = assets['thumbnail_url'] as string | undefined;
      if (thumb) out.thumbnailUrl = thumb;
      const caption = assets['caption'] as string | undefined;
      if (caption) out.caption = caption;
      return out;
    },

    async downloadAsset(rawUrl): Promise<Buffer> {
      // The URL comes from the PROVIDER's JSON, so it is untrusted input.
      let url = assertDownloadableUrl(rawUrl, assetHosts);

      // Never send the API key here (spec §10 R29). Asset URLs are signed CDN
      // links — the live-verified spike downloads them with no credential — and
      // attaching it to a provider-chosen host is exactly how a key leaks.
      //
      // Redirects are followed by hand so EVERY hop is re-checked against the
      // allowlist; fetch's own following checks only the first URL. One
      // controller/timer covers the whole chain.
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        let res: Response;
        for (let hop = 0; ; hop++) {
          try {
            res = await doFetch(url.toString(), {
              method: 'GET',
              signal: controller.signal,
              redirect: 'manual',
            });
          } catch (err) {
            if (err instanceof Error && err.name === 'AbortError') {
              throw new ProviderTimeoutError(
                `asset download timed out after ${timeoutMs}ms`,
                rawUrl,
              );
            }
            throw new ProviderError(`network error: ${String(err)}`, {
              endpoint: rawUrl,
              cause: err,
            });
          }
          const location = res.headers.get('location');
          if (!REDIRECT_STATUSES.has(res.status) || !location) break;
          await res.body?.cancel().catch(() => undefined);
          if (hop >= MAX_ASSET_REDIRECTS) {
            throw new ProviderError(
              `asset download exceeded ${MAX_ASSET_REDIRECTS} redirects`,
              { endpoint: rawUrl },
            );
          }
          let next: string;
          try {
            next = new URL(location, url).toString();
          } catch {
            throw new ProviderError(`asset redirect has an invalid Location: ${location}`, {
              endpoint: rawUrl,
            });
          }
          url = assertDownloadableUrl(next, assetHosts);
        }

        if (!res.ok) {
          throw new ProviderError(`asset download failed: ${res.status}`, {
            status: res.status,
            endpoint: rawUrl,
          });
        }
        return await readBodyCapped(res, assetMaxBytes, rawUrl, controller);
      } finally {
        clearTimeout(timer);
      }
    },
  };
}
