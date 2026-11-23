import { pathToFileURL } from 'node:url';
import Fastify, { type FastifyError, type FastifyInstance } from 'fastify';
import { getConfig } from './config.js';
import { closeDb } from './db/client.js';
import { createStorage } from './storage/index.js';
import { registerRoutes } from './routes/index.js';

// Build a fully-wired Fastify instance. Does NOT connect to Postgres — the DB
// pool is created lazily on first query (see db/client.ts), so boot and
// /healthz work without a live database (task requirement 10).
export async function buildServer(config = getConfig()): Promise<FastifyInstance> {
  // Without trustProxy, behind Railway's edge every req.ip is the proxy's
  // address: all clients shared one rate-limit/auth-fail bucket, so 20 bad
  // tokens from anyone locked everyone out.
  //
  // A function, not the number: Fastify >= 5.12 makes a numeric trustProxy
  // fail closed (trusts nothing), because a hop count cannot tell the edge from
  // a direct client. That is safe here only because the container is reachable
  // solely through Railway's edge. proxy-addr calls this with i = 0 for the
  // socket peer, then 1.. walking X-Forwarded-For right to left.
  // ponytail: hop count is measured, not derived (production = 2 on
  // 2026-11-04); re-measure if Railway changes its edge. Upgrade path: trust
  // the edge's CIDR (a string) instead.
  const hops = config.TRUST_PROXY_HOPS;
  const app = Fastify({ logger: true, trustProxy: (_addr: string, i: number) => i < hops });
  installErrorHandler(app);
  const storage = createStorage(config);
  await registerRoutes(app, { config, storage });
  return app;
}

/**
 * Last-resort error handler (spec §10 R10).
 *
 * Anything that escapes a handler used to be serialized by Fastify's default,
 * which echoes `err.message` to the client — a Postgres error carries table and
 * column names, a ZodError carries the whole issue tree. Those describe our
 * schema to anyone who can provoke a 500.
 *
 * So: log the real error server-side, return a generic body. Client errors
 * (4xx) are the caller's own mistake and their messages are Fastify's, not the
 * database's, so they keep their status and a safe message — a 413 that says
 * only "internal_error" would be actively unhelpful.
 *
 * Exported for tests.
 */
export function installErrorHandler(app: FastifyInstance): void {
  app.setErrorHandler((rawErr: unknown, req, reply) => {
    const err = rawErr as FastifyError;
    // Fall back to a status already staged on the reply — some plugins set it
    // before throwing — so a deliberate 4xx never gets laundered into a 500.
    const status =
      err?.statusCode ?? (reply.statusCode >= 400 ? reply.statusCode : 500);

    if (status >= 500) {
      req.log.error({ err, url: req.url, method: req.method }, 'unhandled request error');
      return reply.code(500).send({ error: 'internal_error' });
    }

    req.log.warn(
      { code: err?.code, status, url: req.url, method: req.method },
      'request rejected',
    );

    // A plugin may throw a ready-made response body rather than an Error —
    // @fastify/rate-limit throws exactly that. It is ours, and already safe, so
    // pass it through instead of flattening it to a generic message.
    if (rawErr && typeof rawErr === 'object' && !(rawErr instanceof Error)) {
      return reply.code(status).send(rawErr);
    }

    return reply.code(status).send({
      // Fastify's own machine-readable code (FST_ERR_CTP_BODY_TOO_LARGE, …),
      // falling back to the generic label the routes already use.
      error: err.code ?? 'bad_request',
      message: err.message,
    });
  });
}

/**
 * Install SIGTERM/SIGINT handling: stop accepting connections, let in-flight
 * requests finish, then close the DB pool (spec §10 R10).
 *
 * Order matters — `app.close()` first, `closeDb()` second. Closing the pool
 * while a handler is still mid-query turns a request that was about to succeed
 * into a 500. The hard timer is the backstop for a wedged connection: a deploy
 * that hangs forever is worse than one that drops a straggler, and the platform
 * will SIGKILL us shortly after regardless.
 *
 * Exported for tests.
 */
export function installShutdownHandlers(
  app: FastifyInstance,
  graceMs: number,
  exit: (code: number) => void = process.exit,
): (signal: string) => void {
  let shuttingDown = false;

  const shutdown = (signal: string): void => {
    // A second SIGTERM (impatient orchestrator) must not start a second drain.
    if (shuttingDown) return;
    shuttingDown = true;
    app.log.info(`received ${signal}, draining in-flight requests`);

    const hard = setTimeout(() => {
      app.log.error(`shutdown exceeded ${graceMs}ms, exiting with work in flight`);
      exit(1);
    }, graceMs);
    // Don't let the backstop itself hold the process open once we're done.
    hard.unref();

    void (async () => {
      try {
        await app.close();
        await closeDb();
        clearTimeout(hard);
        app.log.info('shutdown complete');
        exit(0);
      } catch (err) {
        app.log.error({ err }, 'shutdown failed');
        clearTimeout(hard);
        exit(1);
      }
    })();
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
  return shutdown;
}

async function main(): Promise<void> {
  const config = getConfig();
  const app = await buildServer();
  await app.listen({ port: config.PORT, host: '0.0.0.0' });
  installShutdownHandlers(app, config.SHUTDOWN_GRACE_MS);
}

// Run when executed directly (node/tsx src/server.ts), not when imported.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  // Spec §10 R28: anything that escapes is a bug with unknown state behind it.
  // Log it and exit non-zero so Railway restarts a clean process.
  process.on('unhandledRejection', (reason) => {
    console.error('[api] unhandledRejection, exiting:', reason);
    process.exit(1);
  });
  process.on('uncaughtException', (err) => {
    console.error('[api] uncaughtException, exiting:', err);
    process.exit(1);
  });
  main().catch((err) => {
    // eslint-disable-next-line no-console
    console.error(err);
    process.exit(1);
  });
}
