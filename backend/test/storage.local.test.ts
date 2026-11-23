import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createLocalStorage } from '../src/storage/local.js';
import type { Config } from '../src/config.js';

let dir: string;

function makeConfig(): Config {
  return {
    LOCAL_STORAGE_DIR: dir,
    PUBLIC_BASE_URL: 'http://localhost:8080',
  } as unknown as Config;
}

beforeAll(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'virtspace-storage-'));
});

afterAll(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

describe('local storage driver', () => {
  it('round-trips put → get → delete', async () => {
    const storage = createLocalStorage(makeConfig());
    const key = 'captures/abc/frame_0.heic';
    const payload = Buffer.from('hello-world');

    await storage.putObject(key, payload);
    const got = await storage.getObject(key);
    expect(got.equals(payload)).toBe(true);

    await storage.deleteObject(key);
    await expect(storage.getObject(key)).rejects.toBeTruthy();
  });

  it('builds dev-storage presigned URLs', async () => {
    const storage = createLocalStorage(makeConfig());
    const up = await storage.presignUpload('captures/x/frame_1.heic', 'image/heic', 100);
    expect(up.method).toBe('PUT');
    expect(up.url).toBe('http://localhost:8080/dev-storage/captures/x/frame_1.heic');

    const down = await storage.presignDownload('captures/x/frame_1.heic', 60);
    expect(down).toContain('/dev-storage/captures/x/frame_1.heic');
  });

  it('rejects path traversal keys', async () => {
    const storage = createLocalStorage(makeConfig());
    await expect(storage.putObject('../escape.txt', Buffer.from('x'))).rejects.toThrow(
      /Unsafe/,
    );
  });
});
