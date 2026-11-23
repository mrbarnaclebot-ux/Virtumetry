import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import { getConfig } from '../config.js';
import * as schema from './schema.js';

// Lazy pool — the pool is created on first getDb() call, NOT at import or
// server boot. This lets /healthz and the process start without a live
// Postgres (spec §14 / task requirement 10).

let pool: pg.Pool | undefined;
let db: NodePgDatabase<typeof schema> | undefined;

/**
 * Pool options (spec §10 R28). All client-side, on purpose: DATABASE_URL is
 * Neon's pgbouncer pooler in transaction mode. pg sends `statement_timeout` as
 * a StartupMessage parameter, which stock pgbouncer refuses ("unsupported
 * startup parameter") or at best ignores, and a session-level SET leaks across
 * pooled backends (HANDOFF pooler incident). A server-side ceiling belongs on
 * the role instead (ALTER ROLE ... SET statement_timeout), applied over the
 * direct host.
 */
export const POOL_OPTIONS = {
  // Neon cold start from scale-to-zero is a few seconds; 10 s is generous.
  connectionTimeoutMillis: 10_000,
  // Client-side read timeout: a half-open socket fails the query instead of
  // hanging the worker forever. The longest legitimate query is a short
  // advisory-lock wait in budget.ts, far under this.
  query_timeout: 30_000,
  // TCP keepalive so a silently dropped connection is noticed while idle.
  keepAlive: true,
} as const;

/**
 * Pin `sslmode=verify-full` semantics (spec §10 R33).
 *
 * pg 8 already treats prefer/require/verify-ca as aliases of verify-full (full
 * certificate + hostname check) but warns at boot that pg 9 will switch to
 * libpq semantics, where `require` encrypts WITHOUT verifying the server. Neon
 * hands out `sslmode=require` URLs, so rewriting the mode here keeps today's
 * exact behaviour, keeps it across the pg 9 upgrade, and silences the warning,
 * without touching the env var. A URL that opts into libpq semantics
 * (uselibpqcompat) or disables/relaxes TLS is left as written.
 */
export function withVerifyFullSslMode(url: string): string {
  if (/[?&]uselibpqcompat=/i.test(url)) return url;
  return url.replace(/([?&])sslmode=(prefer|require|verify-ca)(?=&|#|$)/, '$1sslmode=verify-full');
}

export function getPool(): pg.Pool {
  if (!pool) {
    pool = new pg.Pool({
      connectionString: withVerifyFullSslMode(getConfig().DATABASE_URL),
      ...POOL_OPTIONS,
    });
    // An idle client dropped by the server (Neon suspend, pooler restart)
    // emits 'error' on the pool; with no listener that kills the process. The
    // pool already discards the broken client, so logging is all that's left.
    pool.on('error', (err) => {
      console.error(`[db] idle client error (discarded): ${String(err)}`);
    });
  }
  return pool;
}

export function getDb(): NodePgDatabase<typeof schema> {
  if (!db) {
    db = drizzle(getPool(), { schema });
  }
  return db;
}

export type Db = NodePgDatabase<typeof schema>;

export async function closeDb(): Promise<void> {
  if (pool) {
    await pool.end();
    pool = undefined;
    db = undefined;
  }
}
