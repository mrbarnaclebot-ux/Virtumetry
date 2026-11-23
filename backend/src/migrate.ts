import { pathToFileURL, fileURLToPath } from 'node:url';
import { sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import pg from 'pg';
import { getConfig } from './config.js';
import { withVerifyFullSslMode } from './db/client.js';

// Programmatic migrator (spec §10 R10).
//
// The deploy image prunes devDependencies, so `drizzle-kit migrate` does not
// exist in production — migrations were applied by hand from a laptop, which
// meant code could (and did) ship ahead of its schema. This runs the SAME
// committed SQL files through drizzle-orm's own migrator, which needs no CLI and
// no dev toolchain.
//
// Deliberately NOT wired into server/worker boot. Both services scale to more
// than one replica and both would race the same DDL on every deploy; a migration
// is a RELEASE step, not a startup side effect. Railway runs it once as the api
// service's pre-deploy command (see README "Migrations").

/**
 * Advisory-lock key held for the whole migration. Even as a single pre-deploy
 * step this matters: a retried deploy, or an operator running it by hand at the
 * same time, would otherwise have two sessions applying the same DDL. The second
 * holder blocks until the first finishes and then finds nothing pending.
 *
 * Distinct from budget.ts's BUDGET_LOCK_KEY — advisory locks share one namespace.
 */
export const MIGRATION_LOCK_KEY = 0x7645_4d47; // "VtMG"

/**
 * The committed `drizzle/` folder, resolved relative to THIS module so it works
 * from `src/` under tsx and from `dist/` in the image (the Dockerfile copies
 * `backend/drizzle` to `/app/drizzle`, a sibling of `/app/dist`).
 */
export const MIGRATIONS_FOLDER = fileURLToPath(new URL('../drizzle', import.meta.url));

/**
 * Apply every pending migration, serialized by a Postgres advisory lock.
 *
 * Uses a single dedicated `pg.Client` rather than the app pool: `pg_advisory_lock`
 * is SESSION scoped, so a pooled connection could hand the lock and the DDL to
 * different backends. Ending the client releases the lock even if we throw.
 */
export async function runMigrations(connectionString: string): Promise<void> {
  const client = new pg.Client({ connectionString: withVerifyFullSslMode(connectionString) });
  await client.connect();
  try {
    const db = drizzle(client);
    await db.execute(sql`SELECT pg_advisory_lock(${MIGRATION_LOCK_KEY})`);
    await migrate(db, { migrationsFolder: MIGRATIONS_FOLDER });
  } finally {
    // Ends the session, which drops the advisory lock with it.
    await client.end();
  }
}

async function main(): Promise<void> {
  const config = getConfig();
  console.log(`[migrate] applying migrations from ${MIGRATIONS_FOLDER}`);
  if (!config.MIGRATE_DATABASE_URL) {
    console.warn(
      '[migrate] WARNING: MIGRATE_DATABASE_URL is not set, falling back to DATABASE_URL. ' +
        'If that is the pgbouncer pooler, the advisory lock does NOT serialize ' +
        'concurrent migrators (HANDOFF pooler incident). Set MIGRATE_DATABASE_URL ' +
        'to the direct (non -pooler) Neon host.',
    );
  }
  await runMigrations(config.MIGRATE_DATABASE_URL ?? config.DATABASE_URL);
  console.log('[migrate] up to date');
}

// Run when executed directly (node dist/migrate.js), not when imported.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().then(
    () => process.exit(0),
    (err: unknown) => {
      // A failed migration must fail the RELEASE — exit non-zero so Railway's
      // pre-deploy step aborts the rollout instead of starting mismatched code.
      console.error('[migrate] FAILED:', err);
      process.exit(1);
    },
  );
}
