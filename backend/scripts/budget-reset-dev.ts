// D-24: clear today's MOCK spend on the Neon dev branch when the dev budget runs out.
// Touches only credit_events rows with provider_mode = 'mock' created in the
// current UTC day (same boundary as budget.ts). Live rows are never deleted.
// Prints the deleted row count only — never the connection string.
// Usage: cd backend && npm run budget:reset-dev
import { pathToFileURL } from 'node:url';
import pg from 'pg';
import { sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import type { Db } from '../src/db/client.js';
import { assertDevDb } from './dev-guard.mjs';

/** Delete today's (UTC) mock credit_events rows. Returns the deleted count. */
export async function resetTodayMockSpend(db: Pick<Db, 'execute'>): Promise<number> {
  const res = (await db.execute(sql`
    DELETE FROM credit_events
    WHERE provider_mode = 'mock'
      AND created_at >= (date_trunc('day', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC')
  `)) as unknown as { rowCount: number | null };
  return res.rowCount ?? 0;
}

async function main(): Promise<void> {
  // Every refusal happens before any DB connection.
  if (process.env.NODE_ENV === 'production') throw new Error('NODE_ENV=production refused');
  const url = assertDevDb('MIGRATE_DATABASE_URL');
  const pool = new pg.Pool({ connectionString: url, max: 1 });
  try {
    const n = await resetTodayMockSpend(drizzle(pool) as unknown as Db);
    console.log(`deleted ${n} mock credit_events row(s) from today (UTC)`);
  } finally {
    await pool.end();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().then(
    () => process.exit(0),
    (err: unknown) => {
      console.error(`[budget:reset-dev] ${(err instanceof Error ? err.message : String(err)).replace(/\w+:\/\/\S+/g, '[url]')}`);
      process.exit(1);
    },
  );
}
