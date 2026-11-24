import { fetchWithProgress } from '@/viewer/progress';

function fakeResponse(chunks: number[][], { length, status = 200 }: { length?: number; status?: number } = {}) {
  let i = 0;
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (k: string) => (k.toLowerCase() === 'content-length' && length != null ? String(length) : null) },
    body: {
      getReader: () => ({
        read: async () =>
          i < chunks.length ? { done: false, value: new Uint8Array(chunks[i++]) } : { done: true, value: undefined },
      }),
    },
  };
}

const chunks = [[1, 2, 3], [4, 5, 6], [7, 8, 9], [10]];

describe('fetchWithProgress (D-05)', () => {
  afterEach(() => jest.restoreAllMocks());

  it('reports monotonic floor percents, 100 only once all bytes are in', async () => {
    const seen: (number | null)[] = [];
    let readsDone = 0;
    const res = fakeResponse(chunks, { length: 10 });
    const reader = res.body.getReader();
    res.body.getReader = () => ({
      read: async () => {
        const r = await reader.read();
        if (!r.done) readsDone++;
        return r;
      },
    });
    global.fetch = jest.fn().mockResolvedValue(res) as unknown as typeof fetch;

    const bytes = await fetchWithProgress('https://r2/splat', (p) => {
      seen.push(p);
      if (p === 100) expect(readsDone).toBe(chunks.length);
    });

    // The last chunk completes the bytes but the stream is not done yet: 99, then 100 on done.
    expect(seen).toEqual([30, 60, 90, 99, 100]);
    expect(bytes.byteOffset).toBe(0);
    expect(Array.from(bytes)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  });

  it('gives null when Content-Length is missing', async () => {
    const seen: (number | null)[] = [];
    global.fetch = jest.fn().mockResolvedValue(fakeResponse(chunks)) as unknown as typeof fetch;
    const bytes = await fetchWithProgress('https://r2/splat', (p) => seen.push(p));
    expect(seen.length).toBeGreaterThan(0);
    expect(seen.every((p) => p === null)).toBe(true);
    expect(bytes.length).toBe(10);
  });

  it('rejects a non-ok response with its status', async () => {
    global.fetch = jest.fn().mockResolvedValue(fakeResponse([], { status: 403 })) as unknown as typeof fetch;
    await expect(fetchWithProgress('https://r2/splat', () => {})).rejects.toMatchObject({ status: 403 });
  });
});
