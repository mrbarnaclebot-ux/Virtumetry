import { describe, it, expect } from 'vitest';
import Fastify from 'fastify';
import { loadConfig } from '../src/config.js';
import { signWebhook } from '../src/provider/types.js';
import { webhookRoutes } from '../src/routes/webhooks.js';
import type { Db } from '../src/db/client.js';
import type { StorageDriver } from '../src/storage/index.js';

const SECRET = 'test-webhook-secret';
const URL = '/v1/webhooks/spaitial';

// Any DB access throws: proves rejected deliveries never reach the database.
const noDb = new Proxy({}, {
  get: () => {
    throw new Error('db must not be touched');
  },
}) as unknown as Db;

async function build(secret: string | null = SECRET) {
  const config = loadConfig({
    DATABASE_URL: 'postgres://unused@127.0.0.1:1/unused',
    DEV_AUTH_TOKEN: 'test-dev-token',
    ...(secret ? { SPAITIAL_WEBHOOK_SECRET: secret } : {}),
  });
  const app = Fastify({ logger: false });
  await webhookRoutes(app, { config, storage: {} as StorageDriver, db: noDb });
  return app;
}

// Odd whitespace and key order: only the exact bytes verify.
const raw = Buffer.from('{ "request_id":"req_1",\n  "event" : "world.completed" }');
const ids = { 'x-spaitial-delivery-id': 'wd_1', 'x-spaitial-request-id': 'req_1', 'x-spaitial-event': 'world.completed' };

function post(app: Awaited<ReturnType<typeof build>>, payload: Buffer, headers: Record<string, string>) {
  return app.inject({ method: 'POST', url: URL, payload, headers: { 'content-type': 'application/json', ...headers } });
}

describe('POST /v1/webhooks/spaitial', () => {
  it('401 without a signature, no DB access', async () => {
    const res = await post(await build(), raw, ids);
    expect(res.statusCode).toBe(401);
    expect(res.json()).toEqual({ error: 'invalid_signature' });
  });

  it('401 on a wrong signature', async () => {
    const res = await post(await build(), raw, { ...ids, 'x-spaitial-signature': signWebhook('other', raw) });
    expect(res.statusCode).toBe(401);
    expect(res.body).not.toContain(SECRET);
  });

  it('401 when the secret is unset, even for a valid-looking signature (fail closed)', async () => {
    const res = await post(await build(null), raw, { ...ids, 'x-spaitial-signature': signWebhook(SECRET, raw) });
    expect(res.statusCode).toBe(401);
  });

  it('verifies the exact raw bytes: valid signature reaches header checks (400 missing_headers)', async () => {
    const res = await post(await build(), raw, { 'x-spaitial-signature': signWebhook(SECRET, raw) });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: 'missing_headers' });
    expect(res.body).not.toContain(SECRET);
  });

  it('a re-serialised body no longer verifies', async () => {
    const reser = Buffer.from(JSON.stringify(JSON.parse(raw.toString())));
    const res = await post(await build(), reser, { ...ids, 'x-spaitial-signature': signWebhook(SECRET, raw) });
    expect(res.statusCode).toBe(401);
  });

  it('413 for a body over 256 KiB', async () => {
    const big = Buffer.alloc(256 * 1024 + 1, 0x20);
    const res = await post(await build(), big, { ...ids, 'x-spaitial-signature': signWebhook(SECRET, big) });
    expect(res.statusCode).toBe(413);
  });
});
