// D-22: fill the owner's DEV library with one scan in every state, so the phone
// shows every row variant. Neon dev branch + virtumetry-dev only.
// Seed rows are marked client_request_id 'seed:N'; nothing else is touched.
// Prints counts and world ids only — never the email or connection string.
// Usage: cd backend && npm run seed:library            (reset + seed)
//                      npm run seed:library -- --reset (remove seeds only)
//   OWNER_EMAIL from env; the account must exist (npm run owner:create).
import { readFile } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import pg from 'pg';
import { and, eq, inArray, like } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import * as schema from '../src/db/schema.js';
import { user, worlds } from '../src/db/schema.js';
import type { Db } from '../src/db/client.js';
import { getConfig } from '../src/config.js';
import { upsertUserBySub } from '../src/db/users.js';
import { createStorage, worldAssetKey, type StorageDriver } from '../src/storage/index.js';
import { purgePrefix } from '../src/worker.js';
import { assertDevBucket, assertDevDb } from './dev-guard.mjs';

export const THUMBNAIL_FIXTURE = fileURLToPath(new URL('../test/fixtures/tiny-session/frames/000001.jpg', import.meta.url));

/** Remove every 'seed:%' world of this owner (rows + thumbnails). Returns the count. */
export async function resetSeeds(db: Db, storage: StorageDriver, ownerUserId: string): Promise<number> {
  const seeds = await db
    .select({ id: worlds.id })
    .from(worlds)
    .where(and(eq(worlds.ownerId, ownerUserId), like(worlds.clientRequestId, 'seed:%')));
  if (seeds.length === 0) return 0;
  for (const s of seeds) await purgePrefix(storage, `worlds/${s.id}/`);
  // Seed worlds never get captures/jobs/slugs/credit events, so the row is all there is.
  await db.delete(worlds).where(inArray(worlds.id, seeds.map((s) => s.id)));
  return seeds.length;
}

/** Insert the 5 seed worlds (call resetSeeds first). Returns their ids in order. */
export async function seedLibrary(o: {
  db: Db;
  storage: StorageDriver;
  ownerUserId: string;
  thumbnailBytes: Buffer;
}): Promise<string[]> {
  const base = { ownerId: o.ownerUserId };
  const rows: (typeof worlds.$inferInsert)[] = [
    { ...base, clientRequestId: 'seed:1', title: 'Living room', status: 'uploading', progress: 40 },
    { ...base, clientRequestId: 'seed:2', title: 'Kitchen', status: 'processing', phase: 'processing', progress: 60 },
    { ...base, clientRequestId: 'seed:3', title: 'Bedroom', status: 'ready', charged: true },
    {
      ...base,
      clientRequestId: 'seed:4',
      title: 'Hallway',
      status: 'failed',
      failureStage: 'processing',
      failureCode: 'WORLD_GENERATION_FAILED',
      charged: false,
    },
    { ...base, clientRequestId: 'seed:5', title: 'Garage', status: 'cancelled' },
  ];
  const ids: string[] = [];
  for (const row of rows) {
    const [w] = await o.db.insert(worlds).values(row).returning({ id: worlds.id });
    ids.push(w!.id);
  }
  const readyId = ids[2]!;
  const key = worldAssetKey(readyId, 1, 'thumbnail.jpg');
  await o.storage.putObject(key, o.thumbnailBytes);
  await o.db.update(worlds).set({ thumbnailKey: key }).where(eq(worlds.id, readyId));
  return ids;
}

async function main(): Promise<void> {
  // Every refusal happens before any DB connection.
  if (process.env.NODE_ENV === 'production') throw new Error('NODE_ENV=production refused');
  const url = assertDevDb('MIGRATE_DATABASE_URL');
  assertDevBucket();
  const email = process.env.OWNER_EMAIL?.trim().toLowerCase();
  if (!email) throw new Error('OWNER_EMAIL is not set');
  const config = getConfig();
  if (config.STORAGE_DRIVER !== 's3') throw new Error('STORAGE_DRIVER refused: must be s3 (virtumetry-dev)');
  const resetOnly = process.argv.includes('--reset');

  const pool = new pg.Pool({ connectionString: url, max: 1 });
  try {
    const db = drizzle(pool, { schema }) as unknown as Db;
    const [owner] = await db.select().from(user).where(eq(user.email, email));
    if (!owner) throw new Error('owner account not found: run npm run owner:create first');
    const appUser = await upsertUserBySub(db, `ba:${owner.id}`, owner.email);
    const storage = createStorage(config);

    const removed = await resetSeeds(db, storage, appUser.id);
    console.log(`removed ${removed} seed world(s)`);
    if (resetOnly) return;
    const ids = await seedLibrary({ db, storage, ownerUserId: appUser.id, thumbnailBytes: await readFile(THUMBNAIL_FIXTURE) });
    console.log(`seeded ${ids.length} world(s): ${ids.join(', ')}`);
  } finally {
    await pool.end();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().then(
    () => process.exit(0),
    (err: unknown) => {
      // Our errors name variables only; scrub URLs from anything else (driver errors).
      console.error(`[seed:library] ${(err instanceof Error ? err.message : String(err)).replace(/\w+:\/\/\S+/g, '[url]')}`);
      process.exit(1);
    },
  );
}
