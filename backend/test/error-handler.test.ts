import { describe, it, expect } from 'vitest';
import Fastify from 'fastify';
import { z } from 'zod';
import { installErrorHandler } from '../src/server.js';
import { listQuery } from '../src/routes/worlds.js';

// setErrorHandler + query validation (spec §10 R10). No DB, no network: the
// handler is installed on a bare Fastify instance with routes that throw the
// shapes production can actually produce.

function appWith(register: (app: ReturnType<typeof Fastify>) => void) {
  const app = Fastify({ logger: false });
  installErrorHandler(app);
  register(app);
  return app;
}

describe('installErrorHandler', () => {
  it('turns a Postgres-shaped error into a generic 500 with no internals', async () => {
    const app = appWith((a) =>
      a.get('/boom', async () => {
        // Shaped like a node-postgres error: these leak schema if echoed.
        const err = Object.assign(
          new Error('relation "worlds" does not exist'),
          { code: '42P01', table: 'worlds', column: 'client_request_id' },
        );
        throw err;
      }),
    );

    const res = await app.inject({ method: 'GET', url: '/boom' });
    expect(res.statusCode).toBe(500);
    expect(res.json()).toEqual({ error: 'internal_error' });

    const body = res.body;
    expect(body).not.toContain('worlds');
    expect(body).not.toContain('42P01');
    expect(body).not.toContain('client_request_id');
    expect(body).not.toContain('does not exist');
  });

  it('does not leak Zod issue trees from an uncaught .parse()', async () => {
    const app = appWith((a) =>
      a.get('/zod', async () => {
        z.object({ limit: z.number() }).parse({ limit: 'nope' });
        return { ok: true };
      }),
    );

    const res = await app.inject({ method: 'GET', url: '/zod' });
    expect(res.statusCode).toBe(500);
    expect(res.json()).toEqual({ error: 'internal_error' });
    expect(res.body).not.toContain('invalid_type');
    expect(res.body).not.toContain('limit');
  });

  it('keeps a client 4xx status and its (safe) message', async () => {
    const app = appWith((a) =>
      a.post('/small', { bodyLimit: 16 }, async () => ({ ok: true })),
    );

    const res = await app.inject({
      method: 'POST',
      url: '/small',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify({ padding: 'x'.repeat(256) }),
    });

    expect(res.statusCode).toBe(413);
    // Fastify's own code, not a database's.
    expect(res.json().error).toBe('FST_ERR_CTP_BODY_TOO_LARGE');
  });

  it('a route that returns normally is untouched', async () => {
    const app = appWith((a) => a.get('/ok', async () => ({ hello: 'world' })));
    const res = await app.inject({ method: 'GET', url: '/ok' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ hello: 'world' });
  });
});

describe('GET /v1/worlds list query validation', () => {
  it('defaults limit/offset when absent', () => {
    const parsed = listQuery.safeParse({});
    expect(parsed.success && parsed.data).toEqual({ limit: 20, offset: 0 });
  });

  it('coerces the numeric strings a real query string produces', () => {
    const parsed = listQuery.safeParse({ limit: '50', offset: '10' });
    expect(parsed.success && parsed.data).toEqual({ limit: 50, offset: 10 });
  });

  it.each([
    ['non-numeric limit', { limit: 'abc' }],
    ['limit below the floor', { limit: '0' }],
    ['limit above the ceiling', { limit: '101' }],
    ['negative offset', { offset: '-1' }],
    ['fractional limit', { limit: '1.5' }],
  ])('rejects %s instead of throwing a 500', (_label, query) => {
    // Previously `.parse` — each of these threw a ZodError out of the handler.
    expect(listQuery.safeParse(query).success).toBe(false);
  });
});
