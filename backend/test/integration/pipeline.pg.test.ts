import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startPipeline, type Pipeline } from '../helpers/pipeline.js';
import { runOneJob } from '../../src/worker.js';

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
  }, 90_000);

  it('validate: a session missing a frame fails as failed/validate, 0 credits, 0 submits', async () => {
    const submitsBefore = p.provider.calls.submit.length;
    const { worldId } = await p.seedScan({ mutate: (f) => void f.delete('frames/000007.jpg') });
    const w = await p.drain({ worldId });
    expect(w.status).toBe('failed');
    expect(w.failureStage).toBe('validate');
    expect(w.failureCode).toBeTruthy();
    expect(p.provider.calls.submit.length - submitsBefore).toBe(0);
    expect(await ledger(worldId)).toEqual([]);
  }, 90_000);

  it('NOT_APPROVED: no approved ceiling is refused before any submit', async () => {
    const submitsBefore = p.provider.calls.submit.length;
    const { worldId } = await p.seedScan({ approvedMaxCredits: null });
    const w = await p.drain({ worldId });
    expect(w.status).toBe('failed');
    expect(w.failureStage).toBe('submit');
    expect(w.failureCode).toBe('NOT_APPROVED');
    expect(p.provider.calls.submit.length - submitsBefore).toBe(0);
    expect(await ledger(worldId)).toEqual([]);
  }, 90_000);
});

describe.skipIf(!url)('CR-03: soft-deleted worlds (real Postgres)', () => {
  let p: Pipeline;
  beforeAll(async () => {
    p = await startPipeline();
  }, 60_000);
  afterAll(async () => {
    await p?.close();
  });

  const softDelete = (worldId: string) => p.pool.query('UPDATE worlds SET deleted_at = now() WHERE id = $1', [worldId]);
  /** Run jobs until the world has no live job left. */
  const settle = async (worldId: string) => {
    for (let i = 0; i < 500; i++) {
      const { rows } = await p.pool.query("SELECT 1 FROM jobs WHERE world_id = $1 AND phase IN ('queued','running')", [worldId]);
      if (rows.length === 0) return p.getWorld(worldId);
      if (!(await runOneJob(p.deps))) await new Promise((r) => setTimeout(r, 50));
    }
    throw new Error('settle: jobs never finished');
  };

  it('deleted while packing: the bundle written after the purge is removed, no submit', async () => {
    const { worldId, captureId } = await p.seedScan();
    const limits = p.provider.limits.bind(p.provider);
    p.provider.limits = async () => {
      await softDelete(worldId); // lands after the handler's start check
      return limits();
    };
    try {
      await settle(worldId);
    } finally {
      p.provider.limits = limits;
    }
    expect(await p.storage.list(`bundles/${captureId}/`)).toEqual([]);
    const { rows } = await p.pool.query("SELECT 1 FROM jobs WHERE world_id = $1 AND kind = 'submit'", [worldId]);
    expect(rows).toEqual([]);
  }, 90_000);

  it('deleted while processing: provider request cancelled, nothing imported', async () => {
    const submitsBefore = p.provider.calls.submit.length;
    const { worldId } = await p.seedScan();
    const w0 = await p.drain({ worldId, until: (w) => w.status === 'processing' });
    expect(p.provider.calls.submit.length - submitsBefore).toBe(1);
    await softDelete(worldId);
    const w = await settle(worldId);
    expect(w.status).toBe('processing');
    expect((await p.provider.status(w0.providerRequestId!)).status).toBe('CANCELLED');
    expect(await p.storage.list(`worlds/${worldId}/`)).toEqual([]);
  }, 90_000);

  it('deleted mid-import: re-hosted outputs are purged and the world never turns ready', async () => {
    const { worldId } = await p.seedScan();
    const open = p.provider.open.bind(p.provider);
    let first = true;
    p.provider.open = async (a) => {
      if (first) {
        first = false;
        await softDelete(worldId);
      }
      return open(a);
    };
    try {
      const w = await settle(worldId);
      expect(w.status).toBe('importing');
      expect(w.splatKey).toBeNull();
    } finally {
      p.provider.open = open;
    }
    expect(await p.storage.list(`worlds/${worldId}/`)).toEqual([]);
  }, 90_000);
});

describe.skipIf(!url)('pipeline budget refusal (real Postgres)', () => {
  let p: Pipeline;
  beforeAll(async () => {
    p = await startPipeline({ daily: 100 });
  }, 60_000);
  afterAll(async () => {
    await p?.close();
  });

  it('BUDGET_EXCEEDED: over the daily budget fails before any submit, nothing reserved', async () => {
    const { worldId } = await p.seedScan();
    const w = await p.drain({ worldId });
    expect(w.status).toBe('failed');
    expect(w.failureStage).toBe('submit');
    expect(w.failureCode).toBe('BUDGET_EXCEEDED');
    expect(w.failureMessage).toContain('daily');
    expect(p.provider.calls.submit.length).toBe(0);
    const rows = (await p.pool.query('SELECT 1 FROM credit_events WHERE world_id = $1', [worldId])).rows;
    expect(rows).toEqual([]);
  }, 90_000);
});
