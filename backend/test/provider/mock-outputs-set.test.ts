import { readFileSync } from 'node:fs';
import type { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Config } from '../../src/config.js';
import { createProvider } from '../../src/provider/index.js';

const FIXTURES = fileURLToPath(new URL('../fixtures/', import.meta.url));
const NAMES = ['cameras.json', 'collider.ply', 'floorplan.json', 'floorplan.png', 'splat.ply', 'thumbnail.jpg'];
const body = JSON.stringify({ model: 'echo-3', title: 't', input: { type: 'capture_bundle', zip: { type: 'url', zip_url: 'https://bundles.test/c.zip' } } });

async function readAll(s: Readable): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const c of s) chunks.push(c as Buffer);
  return Buffer.concat(chunks);
}

afterEach(() => vi.unstubAllGlobals());

describe.each([
  ['default', 'mock-outputs'],
  ['demo-room', 'demo-room'],
] as const)('MOCK_OUTPUTS_SET=%s', (set, dir) => {
  it(`serves test/fixtures/${dir} including a thumbnail`, async () => {
    // Bundle validation Range-reads the zip; no network in unit tests.
    vi.stubGlobal('fetch', async () => new Response(null, { status: 404 }));
    const p = createProvider({
      PROVIDER_MODE: 'mock',
      MOCK_SCENARIO: 'happy',
      MOCK_PROCESSING_SECONDS: 0,
      MOCK_OUTPUTS_SET: set,
    } as Config);
    const { requestId } = await p.submit(body, `k-${set}`);
    const arts = await p.artifacts(requestId);
    expect(arts.map((a) => a.name).sort()).toEqual(NAMES);
    expect(arts.find((a) => a.name === 'thumbnail.jpg')).toMatchObject({ kind: 'thumbnail', contentType: 'image/jpeg' });
    for (const a of arts) {
      expect((await readAll(await p.open(a))).equals(readFileSync(`${FIXTURES}${dir}/${a.name}`)), a.name).toBe(true);
    }
  });
});
