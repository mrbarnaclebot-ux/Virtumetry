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
  put(scan: LocalScan, signed: PresignedPut, onProgress?: (p: { bytesSent: number; totalBytes: number }) => void): Promise<number>;
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

const statusOf = (e: unknown) => (e as { status?: unknown } | null)?.status;

type Deps = { api: ScansApi; uploader: Uploader; local: LocalStore; batchSize?: number };

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
    // 404 on any :id route = deleted or not ours; 409 on create = idempotency_key_world_deleted.
    if (statusOf(e) === 404 || (statusOf(e) === 409 && !scan.serverWorldId)) return gone();
    throw e;
  }
}

async function reconcileOnce(
  scan: LocalScan,
  deps: Deps,
  onProgress?: (p: UploadProgress) => void,
): Promise<ReconcileResult> {
  const { api, uploader, local, batchSize = 200 } = deps;

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

  if (m.missingFrames.length) {
    for (let i = 0; i < m.missingFrames.length; i += batchSize) {
      const batch = m.missingFrames.slice(i, i + batchSize);
      const files = await Promise.all(batch.map(async (path) => ({ path, bytes: await uploader.size(scan, path) })));
      const { uploads } = await api.presignUploads(id, files);
      // Hand the whole batch to the native session at once; no JS concurrency cap.
      const results = await Promise.allSettled(uploads.map((s) => uploader.put(scan, s)));
      let failed = 0;
      let thrown = 0;
      for (const r of results) {
        if (r.status === 'fulfilled' && ok(r.value)) uploaded++;
        else {
          failed++;
          if (r.status === 'rejected') thrown++;
        }
      }
      report();
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
        status = await uploader.put(scan, uploads[0]);
      } catch {
        return pause();
      }
      if (!ok(status)) return { kind: 'incomplete', world: m.world };
      uploaded++;
      report();
    }
  }

  const res = await api.completeScan(id);
  if ('incomplete' in res) return { kind: 'incomplete', world: m.world };
  return (await applyServerState(scan, res.world, local)) ?? { kind: 'incomplete', world: res.world };
}
