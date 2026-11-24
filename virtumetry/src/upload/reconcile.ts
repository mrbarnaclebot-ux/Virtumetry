// D-21/D-22: server-reconciled upload. Pure: no Expo/React imports; api, uploader and local store are injected.
// Every pass starts from the server's missing report; nothing is trusted from local bookkeeping.
import type { LocalScan } from '@/library/display-state';
import type { completeScan, createScan, getMissing, presignUploads, PresignedPut, ScanWorld } from '@/lib/api';

export type ScansApi = {
  createScan: typeof createScan;
  presignUploads: typeof presignUploads;
  getMissing: typeof getMissing;
  completeScan: typeof completeScan;
};

export type Uploader = {
  size(scan: LocalScan, path: string): Promise<number>;
  /** Resolves with the HTTP status (non-2xx resolves too); rejects on network errors. */
  put(
    scan: LocalScan,
    signed: PresignedPut,
    onProgress?: (p: { bytesSent: number; totalBytes: number }) => void,
    signal?: AbortSignal,
  ): Promise<number>;
};

export type LocalStore = {
  update(id: string, patch: Partial<LocalScan>): void;
  deleteFiles(id: string): Promise<void>;
};

export type UploadProgress = { uploaded: number; total: number };
export type ReconcileResult = { kind: 'done' | 'blocked' | 'failed' | 'incomplete' | 'paused'; world?: ScanWorld };

const ADVANCED = new Set(['packing', 'submitting', 'processing', 'importing', 'ready']);
const MANIFEST = ['frames.jsonl', 'session.json'] as const;
const ok = (status: number) => status >= 200 && status < 300;

/** Packing or later → done (files deleted first, so a failed delete retries next pass); failed → blocked/failed (files kept, T-04-28). */
async function applyServerState(scan: LocalScan, world: ScanWorld, local: LocalStore): Promise<ReconcileResult | null> {
  if (ADVANCED.has(world.status)) {
    await local.deleteFiles(scan.id);
    local.update(scan.id, { uploadState: 'done', failureCode: null });
    return { kind: 'done', world };
  }
  if (world.status === 'failed' || world.status === 'cancelled') {
    const kind = world.failure_stage === 'validate' ? 'blocked' : 'failed';
    local.update(scan.id, { uploadState: kind, failureCode: world.failure_code });
    return { kind, world };
  }
  return null;
}

const codeOf = (e: unknown) => (e as { code?: unknown } | null)?.code;
/** Only the server's own codes mean the world is gone; a proxy or tunnel 404 stays retryable (WR-01). */
const GONE_CODES = new Set(['world_not_found', 'capture_not_found', 'idempotency_key_world_deleted']);

type Deps = { api: ScansApi; uploader: Uploader; local: LocalStore; batchSize?: number; stallMs?: number };

/**
 * Aborts the pass's puts when no bytes have moved for stallMs (WR-03): a background URLSession
 * task that waits for connectivity would otherwise hold the manager's single-pass lock for hours.
 * A late tick means JS timers were suspended (app in background), which never counts as a stall.
 */
function stallGuard(stallMs: number) {
  const ctrl = new AbortController();
  const tickMs = stallMs / 4;
  let last = Date.now();
  let lastTick = last;
  const id = setInterval(() => {
    const now = Date.now();
    if (now - lastTick > tickMs * 2) last = now;
    lastTick = now;
    if (now - last > stallMs) ctrl.abort();
  }, tickMs);
  return { signal: ctrl.signal, alive: () => void (last = Date.now()), stop: () => clearInterval(id) };
}

/**
 * The server world is gone (deleted, or its key was used by a deleted world): terminal, never
 * retried (CR-03). Files are kept so the owner can still Discard the local row.
 */
export const WORLD_GONE = 'WORLD_DELETED';

export async function reconcile(
  scan: LocalScan,
  deps: Deps,
  onProgress?: (p: UploadProgress) => void,
): Promise<ReconcileResult> {
  const gone = (): ReconcileResult => {
    deps.local.update(scan.id, { uploadState: 'failed', failureCode: WORLD_GONE });
    return { kind: 'failed' };
  };
  try {
    return await reconcileOnce(scan, deps, onProgress);
  } catch (e) {
    if (GONE_CODES.has(codeOf(e) as string)) return gone();
    throw e;
  }
}

async function reconcileOnce(
  scan: LocalScan,
  deps: Deps,
  onProgress?: (p: UploadProgress) => void,
): Promise<ReconcileResult> {
  const { api, uploader, local, batchSize = 200, stallMs = 60_000 } = deps;

  let id = scan.serverWorldId;
  if (!id) {
    id = (await api.createScan(scan)).world.id;
    local.update(scan.id, { serverWorldId: id, uploadState: 'uploading' });
  }

  let m = await api.getMissing(id);
  const settled = await applyServerState(scan, m.world, local);
  if (settled) return settled;
  if (scan.serverWorldId && scan.uploadState !== 'uploading') local.update(scan.id, { uploadState: 'uploading' });

  const total = m.totalFrames + MANIFEST.length;
  let uploaded = m.uploadedFrames + (m.manifestPresent ? MANIFEST.length : 0);
  const report = () => onProgress?.({ uploaded, total });
  report();

  const pause = (): ReconcileResult => {
    local.update(scan.id, { uploadState: 'paused' });
    return { kind: 'paused', world: m.world };
  };

  const guard = stallGuard(stallMs);
  const put = (s: PresignedPut) => uploader.put(scan, s, guard.alive, guard.signal).finally(guard.alive);
  try {
    if (m.missingFrames.length) {
      for (let i = 0; i < m.missingFrames.length; i += batchSize) {
        const batch = m.missingFrames.slice(i, i + batchSize);
        const files = await Promise.all(batch.map(async (path) => ({ path, bytes: await uploader.size(scan, path) })));
        const { uploads } = await api.presignUploads(id, files);
        // Hand the whole batch to the native session at once: a JS-side cap of ~4 (D-21) would
        // stop enqueueing when the app is suspended, so the background session could not finish
        // the scan (04-RESEARCH override). Progress still moves per file as each put settles.
        let failed = 0;
        let thrown = 0;
        await Promise.allSettled(
          uploads.map((s) =>
            put(s).then(
              (status) => {
                if (ok(status)) {
                  uploaded++;
                  report();
                } else failed++;
              },
              () => {
                failed++;
                thrown++;
              },
            ),
          ),
        );
        // Failures end the pass (T-04-31); a 403 (expired URL) is re-presigned next pass.
        if (failed) return thrown === failed ? pause() : { kind: 'incomplete', world: m.world };
      }
      m = await api.getMissing(id);
      const after = await applyServerState(scan, m.world, local);
      if (after) return after;
      if (m.missingFrames.length) return { kind: 'incomplete', world: m.world };
    }

    if (!m.manifestPresent) {
      // Manifest LAST, frames.jsonl before session.json.
      for (const path of MANIFEST) {
        const { uploads } = await api.presignUploads(id, [{ path, bytes: await uploader.size(scan, path) }]);
        let status: number;
        try {
          status = await put(uploads[0]);
        } catch {
          return pause();
        }
        if (!ok(status)) return { kind: 'incomplete', world: m.world };
        uploaded++;
        report();
      }
    }
  } finally {
    guard.stop();
  }

  const res = await api.completeScan(id);
  if ('incomplete' in res) return { kind: 'incomplete', world: m.world };
  return (await applyServerState(scan, res.world, local)) ?? { kind: 'incomplete', world: res.world };
}
