import { sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { getDb } from '../db/client.js';
import type { StorageDriver } from '../storage/index.js';

/** A missing object means the bucket exists and the credentials work. */
function isNotFound(err: unknown): boolean {
  const e = err as { name?: string; code?: string; $metadata?: { httpStatusCode?: number } };
  return e?.$metadata?.httpStatusCode === 404 || e?.name === 'NotFound' || e?.code === 'ENOENT';
}

export function healthRoutes(app: FastifyInstance, deps: { storage: StorageDriver }): void {
  // Liveness. No auth, no DB dependency — answers 200 even when Postgres is
  // unreachable so the platform can tell "process up" from "database down".
  app.get('/healthz', async () => ({ status: 'ok' }));

  // Readiness: a real DB read of the migrator's bookkeeping table plus a
  // storage HEAD. Errors are logged, never echoed (they can contain hosts).
  app.get('/readyz', async (req, reply) => {
    try {
      const res = await getDb().execute(
        sql`select count(*)::int as n from drizzle.__drizzle_migrations`,
      );
      const migrations = Number((res.rows[0] as { n?: unknown } | undefined)?.n ?? 0);
      try {
        await deps.storage.objectSize('readyz/sentinel');
      } catch (err) {
        if (!isNotFound(err)) throw err;
      }
      return { status: 'ready', migrations };
    } catch (err) {
      req.log.error({ err }, 'readyz failed');
      return reply.code(503).send({ status: 'unavailable' });
    }
  });
}
