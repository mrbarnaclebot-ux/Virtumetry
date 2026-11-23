import { describe, it, expect, vi, beforeEach } from 'vitest';
import Fastify from 'fastify';

const execute = vi.fn();
vi.mock('../src/db/client.js', () => ({ getDb: () => ({ execute }) }));

import { healthRoutes } from '../src/routes/health.js';
import type { StorageDriver } from '../src/storage/index.js';

let storageError: unknown;
const storage = {
  kind: 's3',
  objectSize: async () => {
    throw storageError;
  },
} as unknown as StorageDriver;

const notFound = Object.assign(new Error('NotFound'), {
  name: 'NotFound',
  $metadata: { httpStatusCode: 404 },
});

function app() {
  const a = Fastify({ logger: false });
  healthRoutes(a, { storage });
  return a;
}

beforeEach(() => {
  execute.mockReset();
  storageError = notFound;
});

describe('/readyz', () => {
  it('200 ready with the migration count when DB resolves and storage says not-found', async () => {
    execute.mockResolvedValue({ rows: [{ n: 1 }] });
    const res = await app().inject({ method: 'GET', url: '/readyz' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: 'ready', migrations: 1 });
  });

  it('treats a local-driver ENOENT as storage OK', async () => {
    execute.mockResolvedValue({ rows: [{ n: 1 }] });
    storageError = Object.assign(new Error('missing'), { code: 'ENOENT' });
    const res = await app().inject({ method: 'GET', url: '/readyz' });
    expect(res.statusCode).toBe(200);
  });

  it('503 with a fixed body when the DB query rejects', async () => {
    execute.mockRejectedValue(new Error('connect ECONNREFUSED ep-secret-host.neon.tech'));
    const res = await app().inject({ method: 'GET', url: '/readyz' });
    expect(res.statusCode).toBe(503);
    expect(res.json()).toEqual({ status: 'unavailable' });
    expect(res.body).not.toMatch(/ECONNREFUSED|neon|secret/);
  });

  it('503 when storage throws a non-404 error (403)', async () => {
    execute.mockResolvedValue({ rows: [{ n: 1 }] });
    storageError = Object.assign(new Error('AccessDenied'), {
      name: 'AccessDenied',
      $metadata: { httpStatusCode: 403 },
    });
    const res = await app().inject({ method: 'GET', url: '/readyz' });
    expect(res.statusCode).toBe(503);
    expect(res.json()).toEqual({ status: 'unavailable' });
  });

  it('/healthz stays 200 with a failing DB', async () => {
    execute.mockRejectedValue(new Error('down'));
    const res = await app().inject({ method: 'GET', url: '/healthz' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: 'ok' });
  });
});
