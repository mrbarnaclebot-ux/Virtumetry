import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Fastify from 'fastify';
import { eq } from 'drizzle-orm';
import { loadConfig } from '../../src/config.js';
import { captures, users, worlds, type World } from '../../src/db/schema.js';
import { enqueue } from '../../src/queue.js';
import { createMockProvider, type MockScenario } from '../../src/provider/mock.js';
import { createLocalStorage, registerDevStorageRoutes } from '../../src/storage/local.js';
import { captureKey } from '../../src/storage/index.js';
import { runOneJob, type WorkerDeps } from '../../src/worker.js';
import { createTestSchema } from './pg-schema.js';

// Reusable end-to-end harness (02-05/06/07): throwaway pg schema + local storage
// in a temp dir served over real HTTP (/dev-storage honours Range, so the mock's
// bundle check reads our presigned URL) + mock provider + an in-process drain.

const FIXTURE_DIR = fileURLToPath(new URL('../fixtures/tiny-session/', import.meta.url));
const TERMINAL = new Set(['ready', 'failed', 'cancelled']);
export const TEST_WEBHOOK_SECRET = 'test-webhook-secret';

async function readFixture(): Promise<Map<string, Buffer>> {
  const files = new Map<string, Buffer>();
  for (const rel of ['session.json', 'frames.jsonl']) {
    files.set(rel, await fs.readFile(path.join(FIXTURE_DIR, rel)));
  }
  for (const name of (await fs.readdir(path.join(FIXTURE_DIR, 'frames'))).sort()) {
    files.set(`frames/${name}`, await fs.readFile(path.join(FIXTURE_DIR, 'frames', name)));
  }
  return files;
}

export async function startPipeline(
  opts: {
    scenario?: MockScenario;
    processingSeconds?: number;
    retryAfterS?: number;
    trackPollSeconds?: number;
    daily?: number;
    monthly?: number;
  } = {},
) {
  const url = process.env.TEST_DATABASE_URL;
  if (!url) throw new Error('startPipeline needs TEST_DATABASE_URL (run via scripts/test-pg.mjs)');
  const schema = await createTestSchema(url, { max: 10 });
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'virtumetry-pipeline-'));

  // The route only reads/writes files in `dir`; the driver handed to the worker
  // is built after listen() so its presigned URLs carry the real port.
  const app = Fastify({ logger: false });
  registerDevStorageRoutes(
    app,
    createLocalStorage({ LOCAL_STORAGE_DIR: dir, PUBLIC_BASE_URL: 'http://127.0.0.1' } as never),
  );
  await app.listen({ host: '127.0.0.1', port: 0 });
  const port = (app.server.address() as { port: number }).port;

  const config = loadConfig({
    DATABASE_URL: 'postgres://unused@127.0.0.1:1/unused',
    STORAGE_DRIVER: 'local',
    LOCAL_STORAGE_DIR: dir,
    PUBLIC_BASE_URL: `http://127.0.0.1:${port}`,
    DEV_AUTH_TOKEN: 'test-dev-token',
    TRACK_POLL_SECONDS: String(opts.trackPollSeconds ?? 0),
    DAILY_CREDIT_BUDGET: String(opts.daily ?? 100_000),
    MONTHLY_CREDIT_BUDGET: String(opts.monthly ?? 100_000),
    SPAITIAL_WEBHOOK_SECRET: TEST_WEBHOOK_SECRET,
  });
  const storage = createLocalStorage(config);

  const ctx = {
    db: schema.db,
    pool: schema.pool,
    storage,
    config,
    /** Set by webhook tests (02-06) to receive the mock's signed deliveries. */
    onWebhook: undefined as undefined | ((raw: Buffer, headers: Record<string, string>) => Promise<unknown>),
  };
  const provider = createMockProvider({
    scenario: opts.scenario,
    processingSeconds: opts.processingSeconds ?? 1,
    retryAfterS: opts.retryAfterS ?? 0,
    webhookSecret: TEST_WEBHOOK_SECRET,
    deliver: (raw, h) => (ctx.onWebhook ? ctx.onWebhook(raw, h) : Promise.resolve()),
  });
  const deps: WorkerDeps = {
    db: schema.db,
    storage,
    config,
    provider,
    push: async () => undefined,
    workerId: 'it-worker',
  } as WorkerDeps;

  const getWorld = async (worldId: string): Promise<World> => {
    const [w] = await schema.db.select().from(worlds).where(eq(worlds.id, worldId));
    if (!w) throw new Error(`world ${worldId} missing`);
    return w;
  };

  return Object.assign(ctx, {
    provider,
    deps,
    app,
    getWorld,

    /** Seed a fixture scan at status 'packing' with its pack job queued. */
    async seedScan(o: { approvedMaxCredits?: number | null; mutate?: (files: Map<string, Buffer>) => void } = {}) {
      const files = await readFixture();
      o.mutate?.(files);
      const frameCount = (files.get('frames.jsonl') ?? Buffer.alloc(0))
        .toString('utf8')
        .split('\n')
        .filter((l) => l.trim()).length;
      const userId = randomUUID();
      const worldId = randomUUID();
      const captureId = randomUUID();
      await schema.db.insert(users).values({ id: userId, appleSub: `sub-${userId}` });
      await schema.db.insert(worlds).values({
        id: worldId,
        ownerId: userId,
        title: 'Fixture room',
        status: 'packing',
        approvedMaxCredits: o.approvedMaxCredits === undefined ? 5000 : o.approvedMaxCredits,
      });
      await schema.db
        .insert(captures)
        .values({ id: captureId, worldId, frameCount, r2FramesPrefix: `captures/${captureId}` });
      for (const [rel, buf] of files) await storage.putObject(captureKey(captureId, rel), buf);
      await enqueue(schema.db, 'pack', worldId, { captureId });
      return { worldId, captureId, frameCount };
    },

    /** Run jobs until the world is terminal (or `until` holds). */
    async drain(o: { worldId: string; until?: (w: World) => boolean; timeoutMs?: number }): Promise<World> {
      // 60 s default: Neon dev round trips make the happy path ~20 s end to end.
      const deadline = Date.now() + (o.timeoutMs ?? 60_000);
      for (;;) {
        const w = await getWorld(o.worldId);
        if (TERMINAL.has(w.status) || o.until?.(w)) return w;
        if (Date.now() > deadline) throw new Error(`drain timed out; world ${o.worldId} is ${w.status}`);
        if (!(await runOneJob(deps))) await new Promise((r) => setTimeout(r, 50));
      }
    },

    async close() {
      await app.close();
      await schema.drop();
      await fs.rm(dir, { recursive: true, force: true });
    },
  });
}

export type Pipeline = Awaited<ReturnType<typeof startPipeline>>;
