import { randomUUID } from 'node:crypto';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { eq } from 'drizzle-orm';
import { startPipeline, type Pipeline } from '../helpers/pipeline.js';
import { captures, shareSlugs, users, worlds } from '../../src/db/schema.js';
import { enqueue } from '../../src/queue.js';
import { reapStaleUploads, runOneJob } from '../../src/worker.js';

// ROADMAP SC4 / D-17 / LIB-03: deleting a scan removes its DB rows, its storage
// objects and asks the provider (mock) to delete its copy — once, idempotently.
// Throwaway schema + local storage (D-14).

const url = process.env.TEST_DATABASE_URL;

describe.skipIf(!url)('purge cascade (mock provider, real Postgres)', () => {
  let p: Pipeline;

  beforeAll(async () => {
    p = await startPipeline();
  }, 60_000);

  afterAll(async () => {
    await p?.close();
  });

  const count = async (table: string, worldId: string) =>
    (await p.pool.query(`SELECT 1 FROM ${table} WHERE ${table === 'worlds' ? 'id' : 'world_id'} = $1`, [worldId]))
      .rowCount;

  /** Same statements as DELETE /v1/worlds/:id: soft delete + enqueue purge in one tx. */
  const deleteScan = (worldId: string) =>
    p.db.transaction(async (tx) => {
      await tx.update(worlds).set({ deletedAt: new Date(), updatedAt: new Date() }).where(eq(worlds.id, worldId));
      return enqueue(tx, 'purge', worldId);
    });

  /** Run every claimable job (retries made claimable immediately). */
  const runAll = async () => {
    for (let i = 0; i < 200; i++) {
      await p.pool.query("UPDATE jobs SET run_after = now() WHERE phase = 'queued'");
      if (!(await runOneJob(p.deps))) return;
    }
    throw new Error('runAll: jobs never settled');
  };

  /** A bare world (+ capture with frames) that never reached the provider. */
  const bareWorld = async (o: { status?: string; old?: boolean } = {}) => {
    const userId = randomUUID();
    const worldId = randomUUID();
    const captureId = randomUUID();
    await p.db.insert(users).values({ id: userId, appleSub: `sub-${userId}` });
    await p.db.insert(worlds).values({
      id: worldId,
      ownerId: userId,
      title: 'Bare room',
      status: o.status ?? 'uploading',
      ...(o.old ? { createdAt: new Date(Date.now() - 48 * 3600_000) } : {}),
    });
    await p.db.insert(captures).values({ id: captureId, worldId, frameCount: 1, r2FramesPrefix: `captures/${captureId}` });
    await p.storage.putObject(`captures/${captureId}/frames/f1.jpg`, Buffer.from('jpg'));
    return { worldId, captureId };
  };

  it('ready world: rows, storage and provider copy all gone; ledger kept with world_id NULL', async () => {
    const { worldId, captureId } = await p.seedScan();
    const w = await p.drain({ worldId });
    expect(w.status).toBe('ready');
    const rid = w.providerRequestId!;
    await p.db.insert(shareSlugs).values({ worldId, slug: `s-${randomUUID()}` });
    const ledgerIds = (
      await p.pool.query('SELECT id FROM credit_events WHERE submission_key = $1', [w.submissionKey])
    ).rows.map((r: { id: string }) => r.id);
    expect(ledgerIds.length).toBeGreaterThan(0);
    const before = p.provider.calls.deleteWorld.length;

    await deleteScan(worldId);
    await runAll();

    for (const t of ['worlds', 'captures', 'jobs', 'share_slugs']) expect(await count(t, worldId)).toBe(0);
    const ledger = (await p.pool.query('SELECT id, world_id FROM credit_events WHERE id = ANY($1)', [ledgerIds]))
      .rows as { id: string; world_id: string | null }[];
    expect(ledger.length).toBe(ledgerIds.length);
    expect(ledger.every((r) => r.world_id === null)).toBe(true);
    for (const prefix of [`worlds/${worldId}/`, `captures/${captureId}/`, `bundles/${captureId}/`]) {
      expect(await p.storage.list(prefix)).toEqual([]);
    }
    expect(p.provider.calls.deleteWorld.slice(before)).toEqual([rid]);
  }, 90_000);

  it('retry after a storage failure post-deleteWorld: 404 tolerated, hard delete completes', async () => {
    const { worldId } = await p.seedScan();
    const w = await p.drain({ worldId });
    const rid = w.providerRequestId!;
    const before = p.provider.calls.deleteWorld.length;

    const list = p.storage.list.bind(p.storage);
    let failed = false;
    p.storage.list = async (prefix) => {
      if (!failed) {
        failed = true;
        throw new Error('scripted storage failure');
      }
      return list(prefix);
    };
    try {
      await deleteScan(worldId);
      await runAll();
    } finally {
      p.storage.list = list;
    }

    expect(failed).toBe(true);
    expect(p.provider.calls.deleteWorld.slice(before)).toEqual([rid, rid]);
    for (const t of ['worlds', 'captures', 'jobs']) expect(await count(t, worldId)).toBe(0);
  }, 90_000);

  it('never-submitted world: no provider call, rows and frames gone', async () => {
    const { worldId, captureId } = await bareWorld();
    const before = p.provider.calls.deleteWorld.length;
    await deleteScan(worldId);
    await runAll();
    expect(p.provider.calls.deleteWorld.length).toBe(before);
    for (const t of ['worlds', 'captures', 'jobs']) expect(await count(t, worldId)).toBe(0);
    expect(await p.storage.list(`captures/${captureId}/`)).toEqual([]);
  }, 60_000);

  it('framesOnly reaper purge: row kept, not soft-deleted, no provider call', async () => {
    const { worldId, captureId } = await bareWorld({ old: true });
    const before = p.provider.calls.deleteWorld.length;
    expect(await reapStaleUploads(p.db)).toContain(worldId);
    await runAll();
    const [row] = await p.db.select().from(worlds).where(eq(worlds.id, worldId));
    expect(row?.status).toBe('failed');
    expect(row?.deletedAt).toBeNull();
    expect(await count('captures', worldId)).toBe(1);
    expect(await p.storage.list(`captures/${captureId}/`)).toEqual([]);
    expect(p.provider.calls.deleteWorld.length).toBe(before);
  }, 60_000);

  it('purge of a world that is not soft-deleted: storage purged, row never hard-deleted', async () => {
    const { worldId, captureId } = await bareWorld({ status: 'failed' });
    await p.storage.putObject(`worlds/${worldId}/v1/thumbnail.jpg`, Buffer.from('jpg'));
    await enqueue(p.db, 'purge', worldId);
    await runAll();
    expect(await p.storage.list(`worlds/${worldId}/`)).toEqual([]);
    expect(await p.storage.list(`captures/${captureId}/`)).toEqual([]);
    expect(await count('worlds', worldId)).toBe(1);
    expect(await count('captures', worldId)).toBe(1);
  }, 60_000);
});
