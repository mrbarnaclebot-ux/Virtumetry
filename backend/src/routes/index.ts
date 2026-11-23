import rateLimit from '@fastify/rate-limit';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { makeAuthPreHandler } from '../auth.js';
import { FailureThrottle } from '../throttle.js';
import { registerDevStorageRoutes } from '../storage/index.js';
import { healthRoutes } from './health.js';
import { worldsRoutes } from './worlds.js';
import { devicesRoutes } from './devices.js';
import { accountRoutes } from './account.js';
import { meRoutes } from './me.js';
import type { RouteDeps } from './deps.js';

/**
 * Rate-limit bucket key: the authenticated user when we have one, else the IP.
 * Per-user is what we actually want to bound — one user behind a corporate NAT
 * must not be able to exhaust the budget of everyone sharing that egress.
 */
export function rateLimitKey(req: FastifyRequest): string {
  return req.userId ? `user:${req.userId}` : `ip:${req.ip}`;
}

export async function registerRoutes(
  app: FastifyInstance,
  deps: RouteDeps,
): Promise<void> {
  const { config } = deps;

  // Rate limiting (spec §10 R10).
  //
  // Runs at the preHandler stage, NOT the default onRequest, because the key is
  // the authenticated user id and auth must have run first. That is also why the
  // auth hook below is an onRequest hook: Fastify runs every onRequest hook
  // (including a child scope's) before any preHandler, so this ordering holds
  // without depending on registration order between scopes.
  //
  // The in-memory store is deliberate — the api runs as a SINGLE replica (see
  // README). A shared store would mean a Redis dependency bought for nothing.
  await app.register(rateLimit, {
    global: true,
    hook: 'preHandler',
    timeWindow: config.RATE_LIMIT_WINDOW_MS,
    // Authenticated callers get the per-user budget; anonymous traffic (health,
    // dev storage) is bounded per IP, which is looser because one IP is
    // legitimately many devices.
    max: (req: FastifyRequest) =>
      req.userId ? config.RATE_LIMIT_MAX : config.RATE_LIMIT_IP_MAX,
    keyGenerator: rateLimitKey,
    errorResponseBuilder: (req, context) => {
      req.log.warn({ url: req.url, ip: req.ip, userId: req.userId }, 'rate limit exceeded');
      // `statusCode` is NOT decoration: the plugin THROWS this object, and an
      // error without a statusCode is a 500 to Fastify. Omitting it turns every
      // rate-limit rejection into "internal server error".
      return { statusCode: 429, error: 'rate_limited', retry_after: context.after };
    },
  });

  // Unauthenticated: liveness + (dev-only) local storage.
  healthRoutes(app);
  registerDevStorageRoutes(app, deps.storage);

  // Failed-auth throttle, shared by every authenticated route. Auth failures
  // never reach the limiter above (the auth hook short-circuits first), and they
  // deserve a much tighter bound than ordinary traffic anyway — see throttle.ts.
  const authFailures = new FailureThrottle({
    max: config.AUTH_FAIL_MAX,
    windowMs: config.RATE_LIMIT_WINDOW_MS,
  });

  // Authenticated scope — auth applies to everything registered here.
  await app.register(async (authed) => {
    authed.addHook('onRequest', makeAuthPreHandler(config, authFailures));
    worldsRoutes(authed, deps);
    devicesRoutes(authed);
    accountRoutes(authed);
    meRoutes(authed, deps);
  });
}
