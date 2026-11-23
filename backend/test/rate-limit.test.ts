import { describe, it, expect } from 'vitest';
import Fastify, { type FastifyRequest } from 'fastify';
import rateLimit from '@fastify/rate-limit';
import { FailureThrottle } from '../src/throttle.js';
import { rateLimitKey } from '../src/routes/index.js';
import { loadConfig } from '../src/config.js';

// Rate limiting + failed-auth throttle (spec §10 R10). No DB, no network.

const baseEnv = {
  DATABASE_URL: 'postgres://localhost:5432/virtspace',
  DEV_AUTH_TOKEN: 'devtoken',
};

describe('FailureThrottle', () => {
  const at = (t: number) => ({ max: 3, windowMs: 1000, now: () => t });

  it('blocks only once max failures land inside the window', () => {
    let t = 0;
    const th = new FailureThrottle({ max: 3, windowMs: 1000, now: () => t });
    expect(th.isBlocked('ip')).toBe(false);
    th.record('ip');
    th.record('ip');
    expect(th.isBlocked('ip')).toBe(false);
    th.record('ip');
    expect(th.isBlocked('ip')).toBe(true);
  });

  it('forgets failures that age out of the window', () => {
    let t = 0;
    const th = new FailureThrottle({ max: 3, windowMs: 1000, now: () => t });
    th.record('ip');
    th.record('ip');
    th.record('ip');
    expect(th.isBlocked('ip')).toBe(true);

    t = 1001; // the whole window has slid past
    expect(th.isBlocked('ip')).toBe(false);
    expect(th.size).toBe(0); // and the key is reclaimed, not leaked
  });

  it('a successful auth clears the history', () => {
    const th = new FailureThrottle(at(0));
    th.record('ip');
    th.record('ip');
    th.reset('ip');
    th.record('ip');
    expect(th.isBlocked('ip')).toBe(false);
  });

  it('tracks keys independently', () => {
    const th = new FailureThrottle(at(0));
    th.record('a');
    th.record('a');
    th.record('a');
    expect(th.isBlocked('a')).toBe(true);
    expect(th.isBlocked('b')).toBe(false);
  });

  it('reports a retry-after of at least one second', () => {
    let t = 0;
    const th = new FailureThrottle({ max: 1, windowMs: 5000, now: () => t });
    th.record('ip');
    t = 1000;
    expect(th.retryAfterSeconds('ip')).toBe(4);
    t = 4999;
    expect(th.retryAfterSeconds('ip')).toBe(1); // never rounds down to 0
  });
});

describe('rate limit configuration', () => {
  it('defaults leave the iOS 3 s Library poll far below the per-user cap', () => {
    const cfg = loadConfig({ ...baseEnv } as NodeJS.ProcessEnv);
    // GET /v1/worlds every 3 s = 20 requests per 60 s window.
    const pollsPerWindow = cfg.RATE_LIMIT_WINDOW_MS / 3000;
    expect(pollsPerWindow).toBe(20);
    expect(cfg.RATE_LIMIT_MAX).toBeGreaterThanOrEqual(pollsPerWindow * 10);
  });

  it('POST /v1/worlds is capped far tighter than the general per-user limit', () => {
    const cfg = loadConfig({ ...baseEnv } as NodeJS.ProcessEnv);
    expect(cfg.RATE_LIMIT_CREATE_MAX).toBeLessThan(cfg.RATE_LIMIT_MAX);
    // A world create can become a billable generation; the daily quota is 10.
    expect(cfg.RATE_LIMIT_CREATE_MAX).toBeLessThanOrEqual(20);
  });

  it('every bucket is overridable from the environment', () => {
    const cfg = loadConfig({
      ...baseEnv,
      RATE_LIMIT_MAX: '7',
      RATE_LIMIT_IP_MAX: '9',
      RATE_LIMIT_CREATE_MAX: '2',
      RATE_LIMIT_WINDOW_MS: '1000',
      AUTH_FAIL_MAX: '3',
    } as NodeJS.ProcessEnv);
    expect(cfg.RATE_LIMIT_MAX).toBe(7);
    expect(cfg.RATE_LIMIT_IP_MAX).toBe(9);
    expect(cfg.RATE_LIMIT_CREATE_MAX).toBe(2);
    expect(cfg.RATE_LIMIT_WINDOW_MS).toBe(1000);
    expect(cfg.AUTH_FAIL_MAX).toBe(3);
  });
});

describe('@fastify/rate-limit buckets', () => {
  /**
   * Mirrors the production wiring in src/routes/index.ts: ONE global limiter at
   * the preHandler stage keyed user-or-IP, auth as an onRequest hook so the key
   * is available, and a route-level override on POST /v1/worlds.
   */
  async function makeApp(opts: { ipMax: number; userMax: number; createMax: number }) {
    const app = Fastify({ logger: false });
    await app.register(rateLimit, {
      global: true,
      hook: 'preHandler',
      timeWindow: 60_000,
      max: (req) => (req.userId ? opts.userMax : opts.ipMax),
      keyGenerator: rateLimitKey,
      // statusCode is required — the plugin throws this object, and an error
      // without one is a 500 to Fastify. See the regression test below.
      errorResponseBuilder: () => ({ statusCode: 429, error: 'rate_limited' }),
    });

    // Unauthenticated route — falls into the IP bucket.
    app.get('/healthz', async () => ({ status: 'ok' }));

    await app.register(async (authed) => {
      // Stand-in for the auth hook; onRequest, exactly as in production.
      authed.addHook('onRequest', async (req) => {
        req.userId = (req.headers['x-test-user'] as string) ?? 'u-1';
      });
      authed.get('/v1/worlds', async () => ({ worlds: [] }));
      authed.post(
        '/v1/worlds',
        {
          config: {
            rateLimit: {
              max: opts.createMax,
              timeWindow: 60_000,
              keyGenerator: (req: FastifyRequest) => `create:${req.userId ?? req.ip}`,
            },
          },
        },
        async () => ({ ok: true }),
      );
    });

    return app;
  }

  it('lets a user poll GET /v1/worlds well past the create limit', async () => {
    const app = await makeApp({ ipMax: 1000, userMax: 100, createMax: 2 });
    for (let i = 0; i < 25; i++) {
      const res = await app.inject({ method: 'GET', url: '/v1/worlds' });
      expect(res.statusCode, `poll ${i}`).toBe(200);
    }
  });

  it('applies the tighter bucket to POST /v1/worlds only', async () => {
    const app = await makeApp({ ipMax: 1000, userMax: 100, createMax: 2 });

    expect((await app.inject({ method: 'POST', url: '/v1/worlds' })).statusCode).toBe(200);
    expect((await app.inject({ method: 'POST', url: '/v1/worlds' })).statusCode).toBe(200);
    const blocked = await app.inject({ method: 'POST', url: '/v1/worlds' });
    expect(blocked.statusCode).toBe(429);
    expect(blocked.json().error).toBe('rate_limited');

    // The GET bucket is untouched by the create flood.
    expect((await app.inject({ method: 'GET', url: '/v1/worlds' })).statusCode).toBe(200);
  });

  it('keys the general bucket per user, not globally', async () => {
    const app = await makeApp({ ipMax: 1000, userMax: 2, createMax: 10 });

    const a = { 'x-test-user': 'user-a' };
    expect((await app.inject({ url: '/v1/worlds', headers: a })).statusCode).toBe(200);
    expect((await app.inject({ url: '/v1/worlds', headers: a })).statusCode).toBe(200);
    expect((await app.inject({ url: '/v1/worlds', headers: a })).statusCode).toBe(429);

    // A different user has their own budget.
    const b = { 'x-test-user': 'user-b' };
    expect((await app.inject({ url: '/v1/worlds', headers: b })).statusCode).toBe(200);
  });

  it('bounds unauthenticated traffic per IP', async () => {
    const app = await makeApp({ ipMax: 2, userMax: 1000, createMax: 1000 });
    expect((await app.inject({ url: '/healthz' })).statusCode).toBe(200);
    expect((await app.inject({ url: '/healthz' })).statusCode).toBe(200);
    expect((await app.inject({ url: '/healthz' })).statusCode).toBe(429);

    // An authenticated user has a separate, per-user budget and is unaffected.
    const res = await app.inject({ url: '/v1/worlds', headers: { 'x-test-user': 'a' } });
    expect(res.statusCode).toBe(200);
  });
});

describe('errorResponseBuilder must carry statusCode', () => {
  // Regression: @fastify/rate-limit THROWS whatever errorResponseBuilder
  // returns. An object without `statusCode` is a 500 to Fastify, so omitting it
  // silently converts every rate-limit rejection into "internal server error" —
  // the limit still counts, but the client is told the server is broken.
  async function appWithBuilder(builder?: (req: FastifyRequest, ctx: { after: string }) => object) {
    const app = Fastify({ logger: false });
    await app.register(rateLimit, {
      global: true,
      hook: 'preHandler',
      timeWindow: 60_000,
      max: 1,
      keyGenerator: () => 'k',
      ...(builder ? { errorResponseBuilder: builder } : {}),
    });
    app.get('/x', async () => ({ ok: true }));
    await app.inject({ url: '/x' }); // consume the single allowance
    return app.inject({ url: '/x' });
  }

  it('omitting statusCode yields a misleading 500', async () => {
    const res = await appWithBuilder(() => ({ error: 'rate_limited' }));
    expect(res.statusCode).toBe(500);
  });

  it('including statusCode yields a correct 429 with our body', async () => {
    const res = await appWithBuilder((_req, ctx) => ({
      statusCode: 429,
      error: 'rate_limited',
      retry_after: ctx.after,
    }));
    expect(res.statusCode).toBe(429);
    expect(res.json().error).toBe('rate_limited');
  });
});

describe('rateLimitKey', () => {
  it('prefers the authenticated user so one NAT is not one bucket', () => {
    expect(rateLimitKey({ userId: 'u-1', ip: '1.2.3.4' } as FastifyRequest)).toBe('user:u-1');
  });

  it('falls back to the IP when unauthenticated', () => {
    expect(rateLimitKey({ ip: '1.2.3.4' } as FastifyRequest)).toBe('ip:1.2.3.4');
  });
});

describe('client IP behind the edge proxy (TRUST_PROXY_HOPS)', () => {
  // Regression: without trustProxy every request behind Railway's edge had the
  // proxy's req.ip, so all clients shared ONE auth-fail and per-IP bucket. Built
  // through the real buildServer so the production Fastify options are tested.
  const PROXY = '10.0.0.1';
  const via = (client: string) => ({
    remoteAddress: PROXY,
    headers: { 'x-forwarded-for': client, authorization: 'Bearer wrong' },
  });

  async function makeServer(env: Record<string, string> = {}) {
    const { buildServer } = await import('../src/server.js');
    return buildServer(
      loadConfig({ ...baseEnv, AUTH_FAIL_MAX: '2', RATE_LIMIT_IP_MAX: '2', ...env } as NodeJS.ProcessEnv),
    );
  }

  it('gives each forwarded client its own auth-fail bucket', async () => {
    const app = await makeServer();
    const a = via('203.0.113.1');
    expect((await app.inject({ url: '/v1/worlds', ...a })).statusCode).toBe(401);
    expect((await app.inject({ url: '/v1/worlds', ...a })).statusCode).toBe(401);
    expect((await app.inject({ url: '/v1/worlds', ...a })).statusCode).toBe(429);

    // Same proxy, different client: not locked out by client A's failures.
    const b = via('203.0.113.2');
    expect((await app.inject({ url: '/v1/worlds', ...b })).statusCode).toBe(401);
    await app.close();
  });

  it('gives each forwarded client its own per-IP rate-limit bucket', async () => {
    const app = await makeServer();
    const a = { remoteAddress: PROXY, headers: { 'x-forwarded-for': '203.0.113.1' } };
    expect((await app.inject({ url: '/healthz', ...a })).statusCode).toBe(200);
    expect((await app.inject({ url: '/healthz', ...a })).statusCode).toBe(200);
    expect((await app.inject({ url: '/healthz', ...a })).statusCode).toBe(429);

    const b = { remoteAddress: PROXY, headers: { 'x-forwarded-for': '203.0.113.2' } };
    expect((await app.inject({ url: '/healthz', ...b })).statusCode).toBe(200);
    await app.close();
  });

  it('trusts only the configured hop, so a client cannot pick its own bucket', async () => {
    const app = await makeServer();
    app.get('/ip', async (req) => ({ ip: req.ip }));
    // The leftmost entry is whatever the client sent; the edge appends the real one.
    const res = await app.inject({
      url: '/ip',
      remoteAddress: PROXY,
      headers: { 'x-forwarded-for': '6.6.6.6, 203.0.113.1' },
    });
    expect(res.json().ip).toBe('203.0.113.1');
    await app.close();
  });

  it('TRUST_PROXY_HOPS=0 falls back to the socket address', async () => {
    expect(loadConfig({ ...baseEnv } as NodeJS.ProcessEnv).TRUST_PROXY_HOPS).toBe(1);
    const app = await makeServer({ TRUST_PROXY_HOPS: '0' });
    app.get('/ip', async (req) => ({ ip: req.ip }));
    const res = await app.inject({
      url: '/ip',
      remoteAddress: PROXY,
      headers: { 'x-forwarded-for': '203.0.113.1' },
    });
    expect(res.json().ip).toBe(PROXY);
    await app.close();
  });
});
