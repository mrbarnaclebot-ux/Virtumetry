import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { and, eq, like } from 'drizzle-orm';
import { createTestSchema } from '../helpers/pg-schema.js';
import { users, worlds } from '../../src/db/schema.js';
import { createLocalStorage } from '../../src/storage/local.js';
import type { StorageDriver } from '../../src/storage/index.js';
import { resetSeeds, seedLibrary, THUMBNAIL_FIXTURE } from '../../scripts/seed-library.js';

// D-22 seed:library. Seed logic runs on a throwaway schema + local storage
// (D-14); the script itself is only exercised through its guards, which refuse
// before any DB connection, so it never touches the real dev DB here.

const url = process.env.TEST_DATABASE_URL;
const BACKEND = fileURLToPath(new URL('../..', import.meta.url));

describe.skipIf(!url)('seedLibrary / resetSeeds (real Postgres, local storage)', () => {
  let schema: Awaited<ReturnType<typeof createTestSchema>>;
  let storage: StorageDriver;
  let dir: string;
  let thumbnailBytes: Buffer;
  const ownerId = randomUUID();

  beforeAll(async () => {
    schema = await createTestSchema(url!, { max: 2 });
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'virtumetry-seed-'));
    storage = createLocalStorage({ LOCAL_STORAGE_DIR: dir, PUBLIC_BASE_URL: 'http://127.0.0.1' } as never);
    thumbnailBytes = await fs.readFile(THUMBNAIL_FIXTURE);
    await schema.db.insert(users).values({ id: ownerId, appleSub: `ba:${randomUUID()}` });
  }, 60_000);

  afterAll(async () => {
    await schema?.drop();
    if (dir) await fs.rm(dir, { recursive: true, force: true });
  });

  const seeds = () =>
    schema.db
      .select()
      .from(worlds)
      .where(and(eq(worlds.ownerId, ownerId), like(worlds.clientRequestId, 'seed:%')));

  it('inserts the 5 library states, ready one with a stored thumbnail', async () => {
    await seedLibrary({ db: schema.db, storage, ownerUserId: ownerId, thumbnailBytes });
    const rows = (await seeds()).sort((a, b) => a.clientRequestId!.localeCompare(b.clientRequestId!));
    expect(rows.map((r) => [r.clientRequestId, r.status])).toEqual([
      ['seed:1', 'uploading'],
      ['seed:2', 'processing'],
      ['seed:3', 'ready'],
      ['seed:4', 'failed'],
      ['seed:5', 'cancelled'],
    ]);
    expect(rows[0]!.progress).toBe(40);
    expect(rows[1]!.progress).toBe(60);
    expect(rows[1]!.phase).toBeTruthy();
    const ready = rows[2]!;
    expect(ready.thumbnailKey?.startsWith(`worlds/${ready.id}/`)).toBe(true);
    expect(await storage.getObject(ready.thumbnailKey!)).toEqual(thumbnailBytes);
    expect(rows[3]).toMatchObject({ failureStage: 'processing', failureCode: 'WORLD_GENERATION_FAILED', charged: false });
  });

  it('re-running (reset + seed) never duplicates and purges old thumbnails', async () => {
    const oldReady = (await seeds()).find((r) => r.status === 'ready')!;
    await resetSeeds(schema.db, storage, ownerId);
    await seedLibrary({ db: schema.db, storage, ownerUserId: ownerId, thumbnailBytes });
    expect(await seeds()).toHaveLength(5);
    expect(await storage.list(`worlds/${oldReady.id}/`)).toEqual([]);
  });

  it('resetSeeds removes only seed worlds of that owner', async () => {
    const [keep] = await schema.db
      .insert(worlds)
      .values({ ownerId, title: 'Real scan', status: 'ready', clientRequestId: randomUUID() })
      .returning();
    const ready = (await seeds()).find((r) => r.status === 'ready')!;
    expect(await resetSeeds(schema.db, storage, ownerId)).toBe(5);
    expect(await seeds()).toHaveLength(0);
    expect(await storage.list(`worlds/${ready.id}/`)).toEqual([]);
    const [still] = await schema.db.select().from(worlds).where(eq(worlds.id, keep!.id));
    expect(still?.title).toBe('Real scan');
  });
});

describe('seed:library script guards (no DB connection)', () => {
  const DEV_LOOKING = 'postgres://u:p@ep-mute-fog-arwonnkz.us-east-2.aws.neon.tech/db';
  const EMAIL = 'seed-owner@example.com';

  function run(env: Record<string, string>) {
    const r = spawnSync(process.execPath, ['--import', 'tsx', 'scripts/seed-library.ts'], {
      cwd: BACKEND,
      env: {
        PATH: process.env.PATH ?? '',
        ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}),
        ...env,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
      encoding: 'utf8',
      timeout: 60_000,
    });
    const out = `${r.stdout}${r.stderr}`;
    expect(out).not.toContain(EMAIL);
    return { code: r.status, stderr: r.stderr, out };
  }

  it('refuses S3_BUCKET=virtumetry-prod', () => {
    const r = run({ MIGRATE_DATABASE_URL: DEV_LOOKING, S3_BUCKET: 'virtumetry-prod', OWNER_EMAIL: EMAIL });
    expect(r.code).not.toBe(0);
    expect(r.stderr).toContain('S3_BUCKET');
  }, 70_000);

  it('refuses a non-dev database host without printing it', () => {
    const r = run({
      MIGRATE_DATABASE_URL: 'postgres://u:p@ep-other-123.us-west-2.aws.neon.tech/db',
      S3_BUCKET: 'virtumetry-dev',
      OWNER_EMAIL: EMAIL,
    });
    expect(r.code).not.toBe(0);
    expect(r.stderr).toContain('MIGRATE_DATABASE_URL');
    expect(r.out).not.toContain('ep-other-123');
  }, 70_000);

  it('refuses when OWNER_EMAIL is unset', () => {
    const r = run({ MIGRATE_DATABASE_URL: DEV_LOOKING, S3_BUCKET: 'virtumetry-dev' });
    expect(r.code).not.toBe(0);
    expect(r.stderr).toContain('OWNER_EMAIL');
  }, 70_000);

  it('refuses NODE_ENV=production', () => {
    const r = run({ NODE_ENV: 'production', MIGRATE_DATABASE_URL: DEV_LOOKING, S3_BUCKET: 'virtumetry-dev', OWNER_EMAIL: EMAIL });
    expect(r.code).not.toBe(0);
    expect(r.stderr).toContain('NODE_ENV');
  }, 70_000);
});
