import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import pg from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import type { Db } from '../../src/db/client.js';
import * as schema from '../../src/db/schema.js';
import { MIGRATIONS_FOLDER } from '../../src/migrate.js';

// Throwaway schema built from the REAL committed migration SQL (RESEARCH
// Pattern 5), so integration tests never drift from production DDL.
//
// search_path is set by a pool 'connect' hook (first query on every new
// connection), not the `options` startup parameter, which Neon's pooler rejects.

export async function createTestSchema(
  url: string,
  opts: { max?: number } = {},
): Promise<{ pool: pg.Pool; db: Db; schemaName: string; drop(): Promise<void> }> {
  const schemaName = `virtumetry_it_${randomUUID().replace(/-/g, '').slice(0, 12)}`;
  const pool = new pg.Pool({ connectionString: url, max: opts.max ?? 2 });
  pool.on('connect', (client) => {
    client
      .query(`SET search_path TO "${schemaName}"`)
      // Loud: a silent failure would leak queries into public.
      .catch((err: unknown) => console.error(`[pg-schema] SET search_path failed: ${String(err)}`));
  });
  await pool.query(`CREATE SCHEMA "${schemaName}"`);

  const journal = JSON.parse(
    await readFile(path.join(MIGRATIONS_FOLDER, 'meta', '_journal.json'), 'utf8'),
  ) as { entries: { idx: number; tag: string }[] };
  for (const { tag } of [...journal.entries].sort((a, b) => a.idx - b.idx)) {
    const ddl = (await readFile(path.join(MIGRATIONS_FOLDER, `${tag}.sql`), 'utf8')).replaceAll(
      '"public".',
      `"${schemaName}".`,
    );
    for (const stmt of ddl.split('--> statement-breakpoint')) {
      if (stmt.trim()) await pool.query(stmt);
    }
  }

  const db = drizzle(pool, { schema }) as unknown as Db;
  return {
    pool,
    db,
    schemaName,
    async drop() {
      await pool.query(`DROP SCHEMA IF EXISTS "${schemaName}" CASCADE`).catch(() => undefined);
      await pool.end();
    },
  };
}
