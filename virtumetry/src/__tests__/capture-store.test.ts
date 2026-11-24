import { act, renderHook } from '@testing-library/react-native';
import { Directory, File, Paths } from 'expo-file-system';

import {
  __reloadForTest,
  addLocalScan,
  discardLocalScan,
  getLocalScan,
  getLocalScans,
  updateLocalScan,
  useLocalScan,
} from '@/capture/store';
import type { LocalScan } from '@/library/display-state';

const sessions = () => new Directory(Paths.document, 'sessions');
const indexFile = () => new File(Paths.document, 'sessions', 'index.json');

let n = 0;
function scan(over: Partial<LocalScan> = {}): LocalScan {
  const sessionId = `s-${++n}`;
  return {
    id: sessionId,
    sessionId,
    title: null,
    createdAt: '2026-11-24T10:00:00.000Z',
    dir: new Directory(sessions(), sessionId).uri,
    frameCount: 30,
    durationS: 7.8,
    imageW: 640,
    imageH: 480,
    readiness: 'green',
    precheckIssues: [],
    uploadState: 'saved',
    ...over,
  };
}

beforeEach(() => {
  if (sessions().exists) sessions().delete();
  __reloadForTest();
});

describe('local scan store', () => {
  it('persists to index.json and survives a restart', () => {
    const s = scan();
    addLocalScan(s);
    expect(JSON.parse(indexFile().textSync())).toEqual([s]);
    __reloadForTest(); // simulated app restart: drop memory, reload from disk
    expect(getLocalScans()).toEqual([s]);
  });

  it('updateLocalScan merges and persists; useLocalScan re-renders', async () => {
    const s = scan();
    addLocalScan(s);
    const { result } = await renderHook(() => useLocalScan(s.id));
    expect(result.current?.uploadState).toBe('saved');
    await act(async () => updateLocalScan(s.id, { uploadState: 'approved', approvedMaxCredits: 930 }));
    expect(result.current).toMatchObject({ uploadState: 'approved', approvedMaxCredits: 930, frameCount: 30 });
    __reloadForTest();
    expect(getLocalScan(s.id)?.approvedMaxCredits).toBe(930);
  });

  it('discardLocalScan deletes the session dir and the entry', () => {
    const s = scan();
    const dir = new Directory(sessions(), s.sessionId, 'frames');
    dir.create({ intermediates: true });
    new File(dir, '000001.jpg').writeSync('x');
    addLocalScan(s);
    discardLocalScan(s.id);
    expect(new Directory(sessions(), s.sessionId).exists).toBe(false);
    expect(getLocalScans()).toEqual([]);
    __reloadForTest();
    expect(getLocalScans()).toEqual([]);
  });

  it('keeps the entry and rethrows when the dir delete fails', () => {
    const s = scan();
    new Directory(sessions(), s.sessionId).create({ intermediates: true });
    addLocalScan(s);
    const spy = jest.spyOn(Directory.prototype, 'delete').mockImplementation(() => {
      throw new Error('EIO');
    });
    expect(() => discardLocalScan(s.id)).toThrow('EIO');
    spy.mockRestore();
    expect(getLocalScans()).toEqual([s]);
  });

  it('loads a missing or corrupt index as [] and sets the corrupt file aside (CR-02)', () => {
    expect(getLocalScans()).toEqual([]);
    sessions().create({ intermediates: true, idempotent: true });
    indexFile().writeSync('{not json');
    __reloadForTest();
    expect(getLocalScans()).toEqual([]);
    addLocalScan(scan());
    // The next write did not destroy the corrupt original.
    expect(new File(Paths.document, 'sessions', 'index.corrupt.json').textSync()).toBe('{not json');
  });

  it('writes via a tmp file and recovers it when index.json is missing (CR-02)', () => {
    const s = scan();
    addLocalScan(s);
    expect(new File(Paths.document, 'sessions', 'index.json.tmp').exists).toBe(false);
    // Crash between removing index.json and moving the tmp over it.
    new File(Paths.document, 'sessions', 'index.json.tmp').writeSync(indexFile().textSync());
    indexFile().delete();
    __reloadForTest();
    expect(getLocalScans()).toEqual([s]);
  });
});
