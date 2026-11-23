import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startPipeline, type Pipeline } from '../helpers/pipeline.js';

// ROADMAP SC2 / D-22: fixture scan → pack → submit → track → import → ready
// through the mock, outputs re-hosted in OUR storage. Run via
// `node --env-file=.env scripts/test-pg.mjs test/integration/pipeline.pg.test.ts`.

const url = process.env.TEST_DATABASE_URL;

describe.skipIf(!url)('pipeline end to end (mock provider, real Postgres)', () => {
  let p: Pipeline;

  beforeAll(async () => {
    p = await startPipeline();
  }, 60_000);

  afterAll(async () => {
    await p?.close();
  });

  const ledger = async (worldId: string) =>
    (
      await p.pool.query('SELECT amount, kind, provider_mode FROM credit_events WHERE world_id = $1', [worldId])
    ).rows as { amount: number; kind: string; provider_mode: string }[];

  it('happy: fixture scan reaches ready with every output re-hosted', async () => {
    const submitsBefore = p.provider.calls.submit.length;
    const { worldId, captureId, frameCount } = await p.seedScan();
    const w = await p.drain({ worldId });

    expect(w.status).toBe('ready');
    expect(w.failureStage).toBeNull();
    expect(w.charged).toBe(true);
    expect(w.creditsSpent).toBe(900 + frameCount);
    expect(w.providerRequestId).toBeTruthy();
    expect(w.submissionKey).toBeTruthy();
    const bundleKey = `bundles/${captureId}/capture_bundle.zip`;
    const body = w.submitBody as { input: { zip: { zip_url: string } } };
    expect(body.input.zip.zip_url.endsWith(bundleKey)).toBe(true);

    const [cap] = (await p.pool.query('SELECT bundle_key, bundle_bytes FROM captures WHERE id = $1', [captureId]))
      .rows as { bundle_key: string; bundle_bytes: string }[];
    expect(cap!.bundle_key).toBe(bundleKey);
    expect(Number(cap!.bundle_bytes)).toBe(await p.storage.objectSize(bundleKey));

    const prefix = `worlds/${worldId}/v1/`;
    const names = (await p.storage.list(prefix)).map((o) => o.key.slice(prefix.length)).sort();
    expect(names).toEqual(['cameras.json', 'collider.ply', 'floorplan.json', 'floorplan.png', 'splat.ply']);
    expect((w.floorplanMeta as { version?: number }).version).toBe(1);
    expect(w.splatKey).toBe(`${prefix}splat.ply`);
    expect(w.colliderKey).toBe(`${prefix}collider.ply`);
    expect(w.floorplanKey).toBe(`${prefix}floorplan.png`);
    expect(w.camerasKey).toBe(`${prefix}cameras.json`);

    expect(p.provider.calls.submit.length - submitsBefore).toBe(1);
    const events = await ledger(worldId);
    expect(events).toEqual([{ amount: 900 + frameCount, kind: 'reserve', provider_mode: 'mock' }]);

    const jobs = (await p.pool.query('SELECT kind, phase, attempts FROM jobs WHERE world_id = $1', [worldId]))
      .rows as { kind: string; phase: string; attempts: number }[];
    for (const kind of ['pack', 'submit', 'track']) {
      expect(jobs.find((j) => j.kind === kind)?.phase).toBe('done');
    }
    expect(jobs.find((j) => j.kind === 'track')!.attempts).toBeLessThanOrEqual(1);
  }, 30_000);
});
