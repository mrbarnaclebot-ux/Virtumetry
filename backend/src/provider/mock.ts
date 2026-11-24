import { randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import path from 'node:path';
import type { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import type { MOCK_SCENARIOS } from '../config.js';
import { readCentralDirectory, readEntry, type ReadRange, type ZipEntry } from '../bundle/zipread.js';
import {
  ProviderError,
  signWebhook,
  verifyWebhookSignature,
  type Artifact,
  type ArtifactKind,
  type ProviderStatus,
  type ReconProvider,
} from './types.js';

// Offline provider for PROVIDER_MODE=mock (D-12..D-14). Spends nothing. Its only
// network use is Range-reading OUR OWN presigned bundle ZIP (to mirror Echo-3's
// async validation) and calling the injected `deliver` for webhooks.

export type MockScenario = (typeof MOCK_SCENARIOS)[number];
type Issue = { code: string; message: string };

// ponytail: the mock is dev/test only; its outputs are the committed test
// fixtures, which are not in the Docker image. Pass outputsDir if that changes.
const DEFAULT_OUTPUTS_DIR = fileURLToPath(
  new URL('../../test/fixtures/mock-outputs/', import.meta.url),
);

const OUTPUTS: { kind: ArtifactKind; name: string; contentType: string }[] = [
  { kind: 'splat', name: 'splat.ply', contentType: 'application/octet-stream' },
  { kind: 'collider', name: 'collider.ply', contentType: 'application/octet-stream' },
  { kind: 'floorplan', name: 'floorplan.png', contentType: 'image/png' },
  { kind: 'floorplan_meta', name: 'floorplan.json', contentType: 'application/json' },
  { kind: 'cameras', name: 'cameras.json', contentType: 'application/json' },
];
const OUTPUT_NAMES = new Set(OUTPUTS.map((o) => o.name));

const MAX_FRAMES = 5000;
const RANGE_TIMEOUT_MS = 30_000;

interface Req {
  body: string;
  requestId: string;
  submittedAt: number;
  /** Bundle validation; resolves before the request can turn terminal. */
  checked: Promise<void>;
  issues: Issue[];
  cancelled: boolean;
  meshPolls: number;
}

export function createMockProvider(
  opts: {
    scenario?: MockScenario;
    processingSeconds?: number;
    retryAfterS?: number;
    now?: () => number;
    webhookSecret?: string;
    deliver?: (raw: Buffer, headers: Record<string, string>) => Promise<unknown>;
    outputsDir?: string;
    fetchImpl?: typeof fetch;
  } = {},
): ReconProvider & { calls: { submit: { key: string; body: string }[]; deleteWorld: string[] } } {
  const scenario = opts.scenario ?? 'happy';
  const processingMs = (opts.processingSeconds ?? 0) * 1000;
  const now = opts.now ?? Date.now;
  const fetchImpl = opts.fetchImpl ?? fetch;
  const outputsDir = opts.outputsDir ?? DEFAULT_OUTPUTS_DIR;
  const byKey = new Map<string, Req>();
  const byId = new Map<string, Req>();
  const calls = { submit: [] as { key: string; body: string }[], deleteWorld: [] as string[] };
  let transientFired = false;

  const find = (requestId: string): Req => {
    const r = byId.get(requestId);
    if (!r) throw new ProviderError(`unknown request ${requestId}`, { status: 404, code: 'NOT_FOUND' });
    return r;
  };

  /** Terminal outcome, ignoring time. */
  const outcome = (r: Req): ProviderStatus => {
    if (r.cancelled) return { status: 'CANCELLED', progress: null };
    if (r.issues.length > 0) {
      return {
        status: 'FAILED',
        progress: null,
        error: { code: 'VALIDATION_FAILED', message: 'capture bundle failed validation' },
        issues: r.issues,
      };
    }
    if (scenario === 'failed') {
      return {
        status: 'FAILED',
        progress: null,
        error: { code: 'WORLD_GENERATION_FAILED', message: 'mock: scripted failure' },
      };
    }
    return { status: 'COMPLETED', progress: 1 };
  };

  async function checkBundle(body: string): Promise<Issue[]> {
    const zipUnreadable = (message: string) => [{ code: 'ZIP_UNREADABLE', message }];
    let url: unknown;
    try {
      url = (JSON.parse(body) as { input?: { zip?: { zip_url?: unknown } } }).input?.zip?.zip_url;
    } catch {
      return [{ code: 'INVALID_INPUT', message: 'body is not JSON' }];
    }
    if (typeof url !== 'string') return [{ code: 'INVALID_INPUT', message: 'input.zip.zip_url missing' }];
    const zipUrl = url;

    const get = (a: number, b: number) =>
      fetchImpl(zipUrl, {
        headers: { Range: `bytes=${a}-${b}` },
        signal: AbortSignal.timeout(RANGE_TIMEOUT_MS),
      });
    // Messages never include the (presigned) URL.
    try {
      const pre = await get(0, 15);
      if (pre.status !== 206) return zipUnreadable(`Range preflight returned ${pre.status}, expected 206`);
      const head = Buffer.from(await pre.arrayBuffer());
      if (head.length < 4 || head.readUInt32LE(0) !== 0x04034b50) return zipUnreadable('not a ZIP');
      const total = Number(/\/(\d+)\s*$/.exec(pre.headers.get('content-range') ?? '')?.[1]);
      if (!Number.isFinite(total) || total <= 0) return zipUnreadable('no total size in Content-Range');

      const read: ReadRange = async (a, b) => {
        const r = await get(a, b);
        if (r.status !== 206) throw new Error(`Range read returned ${r.status}`);
        return Buffer.from(await r.arrayBuffer());
      };
      const entries = await readCentralDirectory(total, read);
      const issues: Issue[] = [];
      if (entries.some((e) => e.method !== 0)) {
        issues.push({ code: 'ZIP_ENTRY_NOT_STORED', message: 'every entry must be stored (method 0)' });
      }
      const images = entries
        .filter((e) => /^images\/Image_\d{6}\.jpg$/.test(e.name))
        .sort((a, b) => a.name.localeCompare(b.name));
      if (images.length === 0) issues.push({ code: 'IMAGES_MISSING', message: 'no images/Image_%06d.jpg' });
      const gap = images.findIndex((e, i) => e.name !== `images/Image_${String(i + 1).padStart(6, '0')}.jpg`);
      if (gap >= 0) issues.push({ code: 'IMAGE_SEQUENCE_GAP', message: `gap before ${images[gap]!.name}` });

      const intr = entries.find((e) => e.name === 'cameras/per_frame_intrinsics.json');
      if (!intr) {
        issues.push({ code: 'PER_FRAME_INTRINSICS_MISSING', message: 'cameras/per_frame_intrinsics.json missing' });
      } else {
        let frameCount: unknown;
        try {
          frameCount = (JSON.parse((await readEntry(intr, read)).toString('utf8')) as { frame_count?: unknown })
            .frame_count;
        } catch {
          issues.push({ code: 'CAMERA_FILE_INVALID_JSON', message: 'per_frame_intrinsics.json is not JSON' });
        }
        if (frameCount !== undefined && frameCount !== images.length) {
          issues.push({
            code: 'PER_FRAME_INTRINSICS_FRAME_COUNT_MISMATCH',
            message: `frame_count ${String(frameCount)} != ${images.length} images`,
          });
        }
      }
      const first: ZipEntry | undefined = images[0];
      if (first && !(await readEntry(first, read, 65_536)).includes(Buffer.from('Exif\0\0', 'binary'))) {
        issues.push({ code: 'EXIF_MISSING', message: `${first.name} has no EXIF in the first 64 KiB` });
      }
      return issues;
    } catch (err) {
      return zipUnreadable(err instanceof Error ? err.message : String(err));
    }
  }

  function scheduleWebhook(r: Req): void {
    const { webhookSecret, deliver } = opts;
    if (!webhookSecret || !deliver || scenario === 'webhook_dropped') return;
    setTimeout(() => {
      void (async () => {
        await r.checked;
        const o = outcome(r);
        const event =
          o.status === 'COMPLETED' ? 'world.completed' : o.status === 'CANCELLED' ? 'world.cancelled' : 'world.failed';
        const deliveryId = `wd_${randomUUID()}`;
        const raw = Buffer.from(
          JSON.stringify({
            event,
            delivery_id: deliveryId,
            timestamp: new Date(now()).toISOString(),
            request_id: r.requestId,
            status: o.status,
            validation: { passed: r.issues.length === 0, issues: r.issues },
            ...(o.error ? { error: o.error } : {}),
          }),
        );
        const attempts = scenario === 'duplicate_webhooks' ? 2 : 1;
        for (let attempt = 1; attempt <= attempts; attempt++) {
          try {
            await deliver(raw, {
              'Content-Type': 'application/json',
              'User-Agent': 'SpaitialWebhook/1.0',
              'X-Spaitial-Event': event,
              'X-Spaitial-Request-ID': r.requestId,
              'X-Spaitial-Delivery-ID': deliveryId,
              'X-Spaitial-Delivery-Attempt': String(attempt),
              'X-Spaitial-Signature': signWebhook(webhookSecret, raw),
            });
          } catch (err) {
            console.error(`[mock-provider] webhook delivery ${deliveryId} failed: ${String(err)}`);
          }
        }
      })();
    }, processingMs).unref();
  }

  return {
    mode: 'mock',
    calls,

    async limits() {
      return { minFrames: 1, maxFrames: MAX_FRAMES };
    },

    // Cost is a property of the provider: the mock quotes Echo-3's 900 + n so
    // the budget path is exercised for real, in the mock ledger partition.
    async quote(frameCount) {
      if (frameCount > MAX_FRAMES) {
        throw new ProviderError(`frame_count ${frameCount} exceeds ${MAX_FRAMES}`, {
          status: 400,
          code: 'CAPTURE_FRAME_LIMIT_EXCEEDED',
        });
      }
      return { credits: 900 + frameCount, available: Number.POSITIVE_INFINITY };
    },

    async submit(body, idempotencyKey) {
      calls.submit.push({ key: idempotencyKey, body });
      if (scenario === '402') {
        throw new ProviderError('mock: insufficient credits', { status: 402, code: 'INSUFFICIENT_CREDITS' });
      }
      if (scenario === '409') {
        throw new ProviderError('mock: idempotency key reused', { status: 409, code: 'IDEMPOTENCY_KEY_REUSED' });
      }
      if ((scenario === '429' || scenario === '503') && !transientFired) {
        transientFired = true;
        throw new ProviderError(`mock: scripted ${scenario}`, {
          status: Number(scenario),
          code: scenario === '429' ? 'RATE_LIMIT_EXCEEDED' : 'WORLD_INTAKE_UNAVAILABLE',
          retryAfterS: opts.retryAfterS ?? 1,
        });
      }
      const prior = byKey.get(idempotencyKey);
      if (prior) {
        if (prior.body !== body) {
          throw new ProviderError('idempotency key reused with a different body', {
            status: 409,
            code: 'IDEMPOTENCY_KEY_REUSED',
          });
        }
        return { requestId: prior.requestId };
      }
      const r: Req = {
        body,
        requestId: `req_${randomUUID()}`,
        submittedAt: now(),
        checked: Promise.resolve(),
        issues: [],
        cancelled: false,
        meshPolls: 0,
      };
      r.checked = checkBundle(body).then((issues) => {
        r.issues = issues;
      });
      byKey.set(idempotencyKey, r);
      byId.set(r.requestId, r);
      await r.checked;
      scheduleWebhook(r);
      return { requestId: r.requestId };
    },

    async status(requestId) {
      const r = find(requestId);
      await r.checked;
      if (r.cancelled) return outcome(r);
      const elapsed = now() - r.submittedAt;
      if (elapsed < processingMs) return { status: 'PROCESSING', progress: elapsed / processingMs };
      return outcome(r);
    },

    async ensureExport(requestId, kind) {
      const r = find(requestId);
      if (kind === 'mesh-simplified' && r.meshPolls++ === 0) return 'pending';
      return 'ready';
    },

    async artifacts(requestId) {
      find(requestId);
      return OUTPUTS.map((o) => ({ ...o, ref: o.name }));
    },

    async open(artifact: Artifact): Promise<Readable> {
      // Fixed allowlist: never a path built from caller input (T-02-21).
      if (!OUTPUT_NAMES.has(artifact.name)) {
        throw new ProviderError(`unknown mock artifact ${artifact.name}`, { status: 404, code: 'NOT_FOUND' });
      }
      return createReadStream(path.join(outputsDir, artifact.name));
    },

    async cancel(requestId) {
      find(requestId).cancelled = true;
    },

    async deleteWorld(requestId) {
      calls.deleteWorld.push(requestId);
      find(requestId); // 404 for unknown / already deleted
      byId.delete(requestId);
    },

    verifyWebhook(raw, signatureHeader) {
      return verifyWebhookSignature(opts.webhookSecret, raw, signatureHeader);
    },
  };
}
