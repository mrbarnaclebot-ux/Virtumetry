// D-23 dev loop: drive the committed fixture session through pack → submit →
// track → ready on the REAL dev resources (virtumetry-dev R2 + Neon dev) with
// the MOCK provider ($0). Prints ids, statuses, keys, sizes and timings only —
// never presigned URLs or connection strings.
// Usage: cd backend && npm run fixture:e2e [-- --keep]
import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { eq } from 'drizzle-orm';
import { getConfig } from '../src/config.js';
import { closeDb, getDb } from '../src/db/client.js';
import { captures, jobs, users, worlds } from '../src/db/schema.js';
import { createProvider } from '../src/provider/index.js';
import { sendPush } from '../src/push.js';
import { enqueue } from '../src/queue.js';
import { captureKey, createStorage } from '../src/storage/index.js';
import { runOneJob, type WorkerDeps } from '../src/worker.js';

const FIXTURE_DIR = fileURLToPath(new URL('../test/fixtures/tiny-session/', import.meta.url));
const TIMEOUT_MS = 180_000;
const TERMINAL = new Set(['ready', 'failed', 'cancelled']);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main(): Promise<number> {
  process.env.TRACK_POLL_SECONDS ??= '2';
  process.env.MOCK_PROCESSING_SECONDS ??= '3';
  const config = getConfig();
  // Hard refusals before any write (T-02-34). Errors name the variable only.
  if (config.STORAGE_DRIVER !== 's3') throw new Error('STORAGE_DRIVER refused: must be s3');
  if (config.S3_BUCKET !== 'virtumetry-dev') throw new Error('S3_BUCKET refused: must be virtumetry-dev');
  if (config.PROVIDER_MODE !== 'mock') throw new Error('PROVIDER_MODE refused: must be mock');
  if (!new URL(config.DATABASE_URL).hostname.includes('ep-mute-fog-arwonnkz')) {
    throw new Error('DATABASE_URL refused: not the Neon dev branch');
  }

  const db = getDb();
  const storage = createStorage(config);
  const deps: WorkerDeps = {
    db,
    storage,
    config,
    push: sendPush,
    provider: createProvider(config),
    workerId: 'fixture-e2e',
  };
  const t0 = Date.now();
  const log = (msg: string) => console.log(`[e2e +${((Date.now() - t0) / 1000).toFixed(1)}s] ${msg}`);

  await db.insert(users).values({ appleSub: 'fixture-e2e' }).onConflictDoNothing();
  const [user] = await db.select().from(users).where(eq(users.appleSub, 'fixture-e2e'));

  const files: [string, string][] = [
    ['session.json', 'session.json'],
    ['frames.jsonl', 'frames.jsonl'],
    ...(await fs.readdir(path.join(FIXTURE_DIR, 'frames')))
      .sort()
      .map((n): [string, string] => [`frames/${n}`, path.join('frames', n)]),
  ];
  const frameCount = (await fs.readFile(path.join(FIXTURE_DIR, 'frames.jsonl'), 'utf8'))
    .split('\n')
    .filter((l) => l.trim()).length;

  const worldId = randomUUID();
  const captureId = randomUUID();
  await db.insert(worlds).values({
    id: worldId,
    ownerId: user!.id,
    title: 'fixture e2e',
    status: 'packing',
    approvedMaxCredits: 5000,
  });
  await db.insert(captures).values({ id: captureId, worldId, frameCount, r2FramesPrefix: `captures/${captureId}` });
  for (const [rel, file] of files) {
    await storage.putObject(captureKey(captureId, rel), await fs.readFile(path.join(FIXTURE_DIR, file)));
  }
  log(`world ${worldId} capture ${captureId}: uploaded ${files.length} files (${frameCount} frames)`);
  await enqueue(db, 'pack', worldId, { captureId });

  let status = '';
  let w;
  for (;;) {
    [w] = await db.select().from(worlds).where(eq(worlds.id, worldId));
    if (w!.status !== status) log(`status ${(status = w!.status)}`);
    if (TERMINAL.has(status)) break;
    if (Date.now() - t0 > TIMEOUT_MS) throw new Error(`timed out with world ${worldId} at ${status}`);
    if (!(await runOneJob(deps))) await sleep(500);
  }

  let code = 0;
  if (status === 'ready') {
    const [cap] = await db.select().from(captures).where(eq(captures.id, captureId));
    log(`bundle ${cap!.bundleKey} (${cap!.bundleBytes} bytes)`);
    for (const o of await storage.list(`worlds/${worldId}/`)) log(`asset ${o.key} (${o.size} bytes)`);
    log(`submission key ${w!.submissionKey}, credits ${w!.creditsSpent}`);
  } else {
    log(`FAILED stage=${w!.failureStage} code=${w!.failureCode} message=${w!.failureMessage}`);
    if (w!.failureCode === 'BUDGET_EXCEEDED') {
      log('BUDGET_EXCEEDED = the mock daily cap on dev is used up today (correct behaviour, not a bug)');
    }
    code = 1;
  }

  if (!process.argv.includes('--keep')) {
    await db.update(worlds).set({ deletedAt: new Date(), updatedAt: new Date() }).where(eq(worlds.id, worldId));
    const purgeId = await enqueue(db, 'purge', worldId);
    for (;;) {
      const [j] = await db.select().from(jobs).where(eq(jobs.id, purgeId));
      if (j!.phase === 'done') break;
      if (j!.phase === 'dead') throw new Error(`purge job ${purgeId} died`);
      if (Date.now() - t0 > TIMEOUT_MS + 60_000) throw new Error('purge timed out');
      if (!(await runOneJob(deps))) await sleep(500);
    }
    for (const prefix of [`captures/${captureId}/`, `bundles/${captureId}/`, `worlds/${worldId}/`]) {
      const left = (await storage.list(prefix)).length;
      log(`purged ${prefix}: ${left} objects left`);
      if (left > 0) code = 1;
    }
  }
  return code;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main()
    .then(async (code) => {
      await closeDb();
      process.exit(code);
    })
    .catch(async (err: unknown) => {
      console.error(`[e2e] ${(err instanceof Error ? err.message : String(err)).replace(/\w+:\/\/\S+/g, '[url]')}`);
      await closeDb().catch(() => undefined);
      process.exit(1);
    });
}
