import { act, renderHook } from '@testing-library/react-native';
import { AppState } from 'react-native';

import { getLocalScans, updateLocalScan } from '@/capture/store';
import type { LocalScan } from '@/library/display-state';
import { reconcile } from '@/upload/reconcile';
import { kickUploadManager, startUploadManager, stopUploadManager, useUploadProgress } from '@/upload/manager';

jest.mock('@/upload/reconcile', () => ({ reconcile: jest.fn() }));
jest.mock('@/capture/store', () => ({
  getLocalScans: jest.fn(() => []),
  getLocalScan: jest.fn(),
  updateLocalScan: jest.fn(),
}));
jest.mock('@/lib/api', () => {
  class ApiError extends Error {}
  class UnauthorizedError extends ApiError {}
  return {
    ApiError,
    UnauthorizedError,
    createScan: jest.fn(),
    presignUploads: jest.fn(),
    getMissing: jest.fn(),
    completeScan: jest.fn(),
  };
});

const mockReconcile = reconcile as jest.MockedFunction<typeof reconcile>;
const mockScans = getLocalScans as jest.MockedFunction<typeof getLocalScans>;

const scan = (id: string, uploadState: LocalScan['uploadState']) => ({ id, sessionId: id, uploadState }) as LocalScan;
const flush = () => new Promise((r) => setTimeout(r, 0));

let appStateHandler: ((s: string) => void) | null;
const remove = jest.fn();

beforeEach(() => {
  appStateHandler = null;
  remove.mockClear();
  jest.spyOn(AppState, 'addEventListener').mockImplementation((_type, handler) => {
    appStateHandler = handler as (s: string) => void;
    return { remove } as never;
  });
  mockReconcile.mockReset().mockResolvedValue({ kind: 'done' });
  mockScans.mockReturnValue([
    scan('a', 'approved'),
    scan('b', 'uploading'),
    scan('c', 'paused'),
    scan('d', 'saved'),
    scan('e', 'done'),
    scan('f', 'blocked'),
  ]);
});

afterEach(async () => {
  stopUploadManager();
  await flush();
  jest.restoreAllMocks();
});

describe('upload manager', () => {
  it('start is idempotent and runs one pass over approved/uploading/paused scans', async () => {
    startUploadManager();
    startUploadManager();
    await flush();
    expect(AppState.addEventListener).toHaveBeenCalledTimes(1);
    expect(mockReconcile.mock.calls.map(([s]) => s.id)).toEqual(['a', 'b', 'c']);
  });

  it("AppState 'active' runs another pass; background does not", async () => {
    startUploadManager();
    await flush();
    mockReconcile.mockClear();
    appStateHandler!('background');
    await flush();
    expect(mockReconcile).not.toHaveBeenCalled();
    appStateHandler!('active');
    await flush();
    expect(mockReconcile).toHaveBeenCalledTimes(3);
  });

  it('never runs two passes at once; requests during a pass schedule exactly one follow-up', async () => {
    mockScans.mockReturnValue([scan('a', 'approved')]);
    let release!: () => void;
    mockReconcile.mockImplementationOnce(() => new Promise((r) => (release = () => r({ kind: 'done' }))));
    startUploadManager();
    await flush();
    kickUploadManager();
    kickUploadManager();
    appStateHandler!('active');
    await flush();
    expect(mockReconcile).toHaveBeenCalledTimes(1);
    release();
    await flush();
    await flush();
    expect(mockReconcile).toHaveBeenCalledTimes(2);
  });

  it('one failing scan does not block the others; Unauthorized stops the pass', async () => {
    const { UnauthorizedError } = jest.requireMock('@/lib/api');
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    mockReconcile.mockRejectedValueOnce(new Error('boom'));
    startUploadManager();
    await flush();
    expect(mockReconcile).toHaveBeenCalledTimes(3);
    expect(warn.mock.calls.flat().join(' ')).not.toContain('https://');

    mockReconcile.mockClear();
    mockReconcile.mockRejectedValueOnce(new UnauthorizedError());
    kickUploadManager();
    await flush();
    expect(mockReconcile).toHaveBeenCalledTimes(1);
  });

  it('stop removes the AppState listener', async () => {
    startUploadManager();
    await flush();
    stopUploadManager();
    expect(remove).toHaveBeenCalledTimes(1);
  });

  it('progress reaches useUploadProgress subscribers and the store, throttled', async () => {
    mockScans.mockReturnValue([scan('a', 'approved')]);
    let emit!: (p: { uploaded: number; total: number }) => void;
    let release!: () => void;
    mockReconcile.mockImplementationOnce((_s, _d, onProgress) => {
      emit = onProgress!;
      return new Promise((r) => (release = () => r({ kind: 'done' })));
    });
    const { result } = await renderHook(() => useUploadProgress('a'));
    expect(result.current).toBeUndefined();
    startUploadManager();
    await flush();
    await act(async () => {
      emit({ uploaded: 1, total: 32 });
      emit({ uploaded: 2, total: 32 }); // within 500 ms: dropped
    });
    expect(result.current).toEqual({ uploaded: 1, total: 32 });
    await act(async () => emit({ uploaded: 32, total: 32 })); // completion always goes through
    expect(result.current).toEqual({ uploaded: 32, total: 32 });
    expect(updateLocalScan).toHaveBeenCalledWith('a', { progress: { uploaded: 32, total: 32 } });
    release();
  });

  it('retries a paused/incomplete pass on a backoff while in the foreground (WR-03)', async () => {
    jest.useFakeTimers();
    try {
      mockScans.mockReturnValue([scan('a', 'paused')]);
      mockReconcile.mockResolvedValue({ kind: 'paused' });
      startUploadManager();
      await jest.advanceTimersByTimeAsync(0);
      expect(mockReconcile).toHaveBeenCalledTimes(1);
      await jest.advanceTimersByTimeAsync(15_000);
      expect(mockReconcile).toHaveBeenCalledTimes(2);
      mockReconcile.mockResolvedValue({ kind: 'done' });
      await jest.advanceTimersByTimeAsync(30_000);
      expect(mockReconcile).toHaveBeenCalledTimes(3);
      await jest.advanceTimersByTimeAsync(600_000); // done: no more retries
      expect(mockReconcile).toHaveBeenCalledTimes(3);
    } finally {
      stopUploadManager();
      jest.useRealTimers();
    }
  });
});
