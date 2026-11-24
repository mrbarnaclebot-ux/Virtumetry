import type { LocalScan } from '@/library/display-state';
import type { MissingReport, PresignedPut, ScanWorld } from '@/lib/api';
import { reconcile, WORLD_GONE, type ScansApi, type Uploader } from '@/upload/reconcile';

const pad6 = (i: number) => String(i).padStart(6, '0');
const framePath = (i: number) => `frames/${pad6(i)}.jpg`;

function world(over: Partial<ScanWorld> = {}): ScanWorld {
  return {
    id: 'w-1',
    title: null,
    caption: null,
    status: 'uploading',
    phase: null,
    progress: null,
    heartbeat_at: '2026-11-24T10:00:00.000Z',
    created_at: '2026-11-24T10:00:00.000Z',
    failure_stage: null,
    failure_code: null,
    failure_message: null,
    eta_seconds: null,
    credits_spent: null,
    assets: {},
    ...over,
  };
}

function localScan(over: Partial<LocalScan> = {}): LocalScan {
  return {
    id: 'sess-1',
    sessionId: 'sess-1',
    title: null,
    createdAt: '2026-11-24T10:00:00.000Z',
    dir: 'file:///doc/sessions/sess-1',
    frameCount: 30,
    durationS: 7.8,
    imageW: 640,
    imageH: 480,
    readiness: 'green',
    precheckIssues: [],
    approvedMaxCredits: 930,
    uploadState: 'approved',
    ...over,
  };
}

/** In-memory server: storage keys + world status, mirroring the plan 02/03 contract. */
function fakeServer(frameCount = 30, present: string[] = []) {
  const stored = new Set(present);
  let current = world();
  const log: string[] = [];
  const missing = (): MissingReport => {
    if (current.status !== 'uploading') {
      return { world: current, missingFrames: [], manifestPresent: true, uploadedFrames: frameCount, totalFrames: frameCount };
    }
    const missingFrames = Array.from({ length: frameCount }, (_, i) => framePath(i + 1)).filter((p) => !stored.has(p));
    return {
      world: current,
      missingFrames,
      manifestPresent: stored.has('frames.jsonl') && stored.has('session.json'),
      uploadedFrames: frameCount - missingFrames.length,
      totalFrames: frameCount,
    };
  };
  const api = {
    createScan: jest.fn(async () => ({ world: current })),
    presignUploads: jest.fn(async (_id: string, files: { path: string; bytes: number }[]) => ({
      uploads: files.map((f): PresignedPut => ({ path: f.path, url: `https://r2.invalid/${f.path}`, method: 'PUT', headers: {} })),
    })),
    getMissing: jest.fn(async () => missing()),
    completeScan: jest.fn(async () => {
      const m = missing();
      if (m.missingFrames.length || !m.manifestPresent) return { incomplete: true as const };
      if (current.status === 'uploading') current = { ...current, status: 'packing' };
      return { world: current };
    }),
  } satisfies ScansApi;
  return {
    api,
    stored,
    log,
    setWorld: (w: Partial<ScanWorld>) => (current = { ...current, ...w }),
  };
}

function okUploader(server: ReturnType<typeof fakeServer>, status: (path: string) => number = () => 200) {
  return {
    size: jest.fn(async (_scan: LocalScan, path: string) => path.length),
    put: jest.fn(async (_scan: LocalScan, s: PresignedPut) => {
      const code = status(s.path);
      if (code >= 200 && code < 300) server.stored.add(s.path);
      server.log.push(s.path);
      return code;
    }),
  } satisfies Uploader;
}

const fakeLocal = () => ({ update: jest.fn(), deleteFiles: jest.fn(async () => {}) });

describe('reconcile', () => {
  it('creates the server scan once with the approval and stores serverWorldId', async () => {
    const server = fakeServer(3);
    const local = fakeLocal();
    const scan = localScan({ frameCount: 3 });
    const res = await reconcile(scan, { api: server.api, uploader: okUploader(server), local });
    expect(server.api.createScan).toHaveBeenCalledTimes(1);
    expect(server.api.createScan).toHaveBeenCalledWith(scan);
    expect(local.update).toHaveBeenCalledWith('sess-1', { serverWorldId: 'w-1', uploadState: 'uploading' });
    expect(res.kind).toBe('done');
  });

  it('force-quit: re-sends only the 15 missing frames, manifest last, completes once', async () => {
    const present = Array.from({ length: 15 }, (_, i) => framePath(i + 1));
    const server = fakeServer(30, present);
    const local = fakeLocal();
    const uploader = okUploader(server);
    const scan = localScan({ serverWorldId: 'w-1', uploadState: 'uploading' });

    const res = await reconcile(scan, { api: server.api, uploader, local });

    expect(server.api.createScan).not.toHaveBeenCalled();
    const presigned = server.api.presignUploads.mock.calls.flatMap(([, files]) => files);
    const frameFiles = presigned.filter((f) => f.path.startsWith('frames/'));
    expect(frameFiles.map((f) => f.path)).toEqual(Array.from({ length: 15 }, (_, i) => framePath(i + 16)));
    expect(frameFiles.every((f) => f.bytes === f.path.length)).toBe(true);
    expect(uploader.put.mock.calls.filter(([, s]) => s.path.startsWith('frames/'))).toHaveLength(15);
    // Manifest after every frame, frames.jsonl before session.json, session.json last.
    expect(server.log.slice(-2)).toEqual(['frames.jsonl', 'session.json']);
    expect(server.log.slice(0, 15).every((p) => p.startsWith('frames/'))).toBe(true);
    expect(server.api.completeScan).toHaveBeenCalledTimes(1);
    expect(res.kind).toBe('done');
    expect(local.deleteFiles).toHaveBeenCalledWith('sess-1');
    expect(local.update).toHaveBeenCalledWith('sess-1', expect.objectContaining({ uploadState: 'done' }));

    // A second run after success (status packing): nothing uploaded, no second complete.
    uploader.put.mockClear();
    const again = await reconcile(scan, { api: server.api, uploader, local });
    expect(again.kind).toBe('done');
    expect(uploader.put).not.toHaveBeenCalled();
    expect(server.api.completeScan).toHaveBeenCalledTimes(1);
  });

  it('hands the whole batch over before any put resolves, then re-queries missing', async () => {
    const server = fakeServer(4);
    const resolvers: (() => void)[] = [];
    const uploader: Uploader = {
      size: async () => 1,
      put: jest.fn(
        (_scan, s) =>
          new Promise<number>((resolve) => {
            resolvers.push(() => {
              server.stored.add(s.path);
              resolve(200);
            });
          }),
      ),
    };
    const onProgress = jest.fn();
    const p = reconcile(localScan({ serverWorldId: 'w-1', frameCount: 4 }), { api: server.api, uploader, local: fakeLocal() }, onProgress);
    await new Promise((r) => setTimeout(r, 0));
    expect(uploader.put).toHaveBeenCalledTimes(4); // all started, none resolved yet
    expect(server.api.getMissing).toHaveBeenCalledTimes(1);
    const progress = onProgress.mock.calls.length;
    resolvers.shift()!();
    await new Promise((r) => setTimeout(r, 0));
    // Progress moves per settled put, not per batch (WR-04).
    expect(onProgress.mock.calls.length).toBe(progress + 1);
    resolvers.splice(0).forEach((r) => r());
    // manifest puts are sequential: resolve them as they appear
    for (let i = 0; i < 20 && resolvers.length === 0; i++) await new Promise((r) => setTimeout(r, 0));
    resolvers.splice(0).forEach((r) => r());
    for (let i = 0; i < 20 && resolvers.length === 0; i++) await new Promise((r) => setTimeout(r, 0));
    resolvers.splice(0).forEach((r) => r());
    expect((await p).kind).toBe('done');
    expect(server.api.getMissing).toHaveBeenCalledTimes(2);
  });

  it('presigns 45 missing frames in batches of the injected size', async () => {
    const server = fakeServer(45);
    await reconcile(localScan({ serverWorldId: 'w-1', frameCount: 45 }), {
      api: server.api,
      uploader: okUploader(server),
      local: fakeLocal(),
      batchSize: 20,
    });
    const frameBatches = server.api.presignUploads.mock.calls
      .map(([, files]) => files)
      .filter((files) => files[0].path.startsWith('frames/'));
    expect(frameBatches.map((b) => b.length)).toEqual([20, 20, 5]);
  });

  it('never counts a 403/500 put; the next run re-presigns that path', async () => {
    const server = fakeServer(5);
    let fail = true;
    const uploader = okUploader(server, (p) => (fail && p === framePath(2) ? 403 : fail && p === framePath(3) ? 500 : 200));
    const local = fakeLocal();
    const progress = jest.fn();
    const scan = localScan({ serverWorldId: 'w-1', frameCount: 5, uploadState: 'uploading' });
    const first = await reconcile(scan, { api: server.api, uploader, local }, progress);
    expect(first.kind).toBe('incomplete');
    expect(server.api.completeScan).not.toHaveBeenCalled();
    expect(progress).toHaveBeenLastCalledWith({ uploaded: 3, total: 7 });

    fail = false;
    server.api.presignUploads.mockClear();
    const second = await reconcile(scan, { api: server.api, uploader, local });
    expect(server.api.presignUploads.mock.calls[0][1].map((f) => f.path)).toEqual([framePath(2), framePath(3)]);
    expect(second.kind).toBe('done');
  });

  it('pauses when every put throws a network error', async () => {
    const server = fakeServer(3);
    const uploader: Uploader = { size: async () => 1, put: jest.fn(async () => Promise.reject(new Error('offline'))) };
    const local = fakeLocal();
    const res = await reconcile(localScan({ serverWorldId: 'w-1', frameCount: 3 }), { api: server.api, uploader, local });
    expect(res.kind).toBe('paused');
    expect(local.update).toHaveBeenCalledWith('sess-1', { uploadState: 'paused' });
  });

  it.each(['packing', 'submitting', 'processing', 'importing', 'ready'])('%s on the server → done and files deleted', async (status) => {
    const server = fakeServer(3);
    server.setWorld({ status });
    const local = fakeLocal();
    const uploader = okUploader(server);
    const res = await reconcile(localScan({ serverWorldId: 'w-1' }), { api: server.api, uploader, local });
    expect(res.kind).toBe('done');
    expect(local.update).toHaveBeenCalledWith('sess-1', expect.objectContaining({ uploadState: 'done' }));
    expect(local.deleteFiles).toHaveBeenCalledWith('sess-1');
    expect(uploader.put).not.toHaveBeenCalled();
  });

  it('failed at validate → blocked with the code, files kept; other failure → failed', async () => {
    const server = fakeServer(3);
    server.setWorld({ status: 'failed', failure_stage: 'validate', failure_code: 'IMAGES_MISSING' });
    const local = fakeLocal();
    const res = await reconcile(localScan({ serverWorldId: 'w-1' }), { api: server.api, uploader: okUploader(server), local });
    expect(res.kind).toBe('blocked');
    expect(local.update).toHaveBeenCalledWith('sess-1', { uploadState: 'blocked', failureCode: 'IMAGES_MISSING' });
    expect(local.deleteFiles).not.toHaveBeenCalled();

    server.setWorld({ failure_stage: 'pack', failure_code: 'ZIP_FAILED' });
    const other = await reconcile(localScan({ serverWorldId: 'w-1' }), { api: server.api, uploader: okUploader(server), local });
    expect(other.kind).toBe('failed');
    expect(local.update).toHaveBeenCalledWith('sess-1', { uploadState: 'failed', failureCode: 'ZIP_FAILED' });
    expect(local.deleteFiles).not.toHaveBeenCalled();
  });

  it('complete returning a failed/validate world → blocked', async () => {
    const server = fakeServer(2);
    server.api.completeScan.mockImplementationOnce(async () => ({
      world: world({ status: 'failed', failure_stage: 'validate', failure_code: 'EXIF_MISSING' }),
    }));
    const local = fakeLocal();
    const res = await reconcile(localScan({ serverWorldId: 'w-1', frameCount: 2 }), {
      api: server.api,
      uploader: okUploader(server),
      local,
    });
    expect(res.kind).toBe('blocked');
    expect(local.update).toHaveBeenCalledWith('sess-1', { uploadState: 'blocked', failureCode: 'EXIF_MISSING' });
    expect(local.deleteFiles).not.toHaveBeenCalled();
  });

  it('reports progress as server count + 2xx puts over totalFrames + 2', async () => {
    const server = fakeServer(4, [framePath(1), framePath(2)]);
    const progress = jest.fn();
    await reconcile(localScan({ serverWorldId: 'w-1', frameCount: 4 }), { api: server.api, uploader: okUploader(server), local: fakeLocal() }, progress);
    expect(progress).toHaveBeenNthCalledWith(1, { uploaded: 2, total: 6 });
    expect(progress).toHaveBeenCalledWith({ uploaded: 4, total: 6 });
    expect(progress).toHaveBeenLastCalledWith({ uploaded: 6, total: 6 });
  });

  it('a deleted world (404) or deleted key (409 on create) is terminal: failed, files kept (CR-03)', async () => {
    const httpError = (status: number, code?: string) => Object.assign(new Error(`API error ${status}`), { status, code });
    const server = fakeServer(3);
    server.api.getMissing.mockRejectedValueOnce(httpError(404, 'world_not_found'));
    const local = fakeLocal();
    const res = await reconcile(localScan({ serverWorldId: 'w-1' }), { api: server.api, uploader: okUploader(server), local });
    expect(res.kind).toBe('failed');
    expect(local.update).toHaveBeenCalledWith('sess-1', { uploadState: 'failed', failureCode: WORLD_GONE });
    expect(local.deleteFiles).not.toHaveBeenCalled();

    server.api.createScan.mockRejectedValueOnce(httpError(409, 'idempotency_key_world_deleted'));
    expect((await reconcile(localScan(), { api: server.api, uploader: okUploader(server), local })).kind).toBe('failed');

    // A 404/409 without our code (proxy, offline tunnel, old backend) is not terminal (iter-2 WR-01).
    server.api.getMissing.mockRejectedValueOnce(httpError(404));
    await expect(reconcile(localScan({ serverWorldId: 'w-1' }), { api: server.api, uploader: okUploader(server), local })).rejects.toThrow('404');
    server.api.createScan.mockRejectedValueOnce(httpError(409, 'not_uploading'));
    await expect(reconcile(localScan(), { api: server.api, uploader: okUploader(server), local })).rejects.toThrow('409');

    // Other errors still propagate (retried next pass).
    server.api.getMissing.mockRejectedValueOnce(httpError(500));
    await expect(reconcile(localScan({ serverWorldId: 'w-1' }), { api: server.api, uploader: okUploader(server), local })).rejects.toThrow('500');
  });

  it('a definitely refused create goes back to saved for re-approval; a rate-limit 429 is retried (WR-02)', async () => {
    const httpError = (status: number, code?: string) => Object.assign(new Error(`API error ${status}`), { status, code });
    const server = fakeServer(3);
    const local = fakeLocal();
    for (const [status, code] of [
      [400, 'approval_below_quote'],
      [400, 'invalid_body'],
      [429, 'scan_quota_exceeded'],
    ] as const) {
      server.api.createScan.mockRejectedValueOnce(httpError(status, code));
      expect((await reconcile(localScan(), { api: server.api, uploader: okUploader(server), local })).kind).toBe('failed');
      expect(local.update).toHaveBeenLastCalledWith('sess-1', { uploadState: 'saved', failureCode: code.toUpperCase() });
    }
    // An inline approve stored a world meanwhile: the refusal must not overwrite it.
    server.api.createScan.mockRejectedValueOnce(httpError(429, 'scan_quota_exceeded'));
    local.update.mockClear();
    const raced = { ...local, get: () => localScan({ serverWorldId: 'w-9' }) };
    expect((await reconcile(localScan(), { api: server.api, uploader: okUploader(server), local: raced })).kind).toBe('incomplete');
    expect(local.update).not.toHaveBeenCalled();
    server.api.createScan.mockRejectedValueOnce(httpError(429, 'rate_limited'));
    await expect(reconcile(localScan(), { api: server.api, uploader: okUploader(server), local })).rejects.toThrow('429');
  });

  it('aborts a put that moves no bytes for stallMs and pauses instead of holding the pass (WR-03)', async () => {
    const server = fakeServer(2);
    const uploader: Uploader = {
      size: async () => 1,
      put: jest.fn(
        (_scan, _s, _onProgress, signal) =>
          new Promise<number>((_resolve, reject) => signal?.addEventListener('abort', () => reject(new Error('cancelled')))),
      ),
    };
    const local = fakeLocal();
    const res = await reconcile(localScan({ serverWorldId: 'w-1', frameCount: 2 }), { api: server.api, uploader, local, stallMs: 40 });
    expect(res.kind).toBe('paused');
    expect(server.api.completeScan).not.toHaveBeenCalled();
  });
});
