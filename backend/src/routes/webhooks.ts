import type { FastifyInstance, FastifyRequest } from 'fastify';
import { sql } from 'drizzle-orm';
import { getDb, type Db } from '../db/client.js';
import { webhookDeliveries } from '../db/schema.js';
import { verifyWebhookSignature } from '../provider/types.js';
import type { RouteDeps } from './deps.js';

function header(req: FastifyRequest, name: string): string | undefined {
  const v = req.headers[name];
  return typeof v === 'string' && v ? v : undefined;
}

/**
 * POST /v1/webhooks/spaitial (D-20, PROC-06). Unauthenticated: the HMAC over the
 * exact raw bytes IS the auth, checked before any DB access (fail closed when the
 * secret is unset). Deduped on delivery id. Nudge only: it pulls the world's
 * queued track job forward; `track` stays the single writer of world state, so
 * the body is never parsed.
 */
export async function webhookRoutes(app: FastifyInstance, deps: RouteDeps & { db?: Db }): Promise<void> {
  const { config } = deps;
  await app.register(async (scope) => {
    // Child scope: raw Buffer for any content type, without touching the rest of
    // the API's JSON parsing (parsers are encapsulated per scope).
    scope.removeAllContentTypeParsers();
    scope.addContentTypeParser('*', { parseAs: 'buffer', bodyLimit: 256 * 1024 }, (_req, body, done) => {
      done(null, body);
    });

    scope.post('/v1/webhooks/spaitial', {
      config: {
        rateLimit: {
          max: config.RATE_LIMIT_WEBHOOK_MAX,
          timeWindow: config.RATE_LIMIT_WINDOW_MS,
          keyGenerator: (req: FastifyRequest) => `wh:${req.ip}`,
        },
      },
    }, async (req, reply) => {
      const raw = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
      if (!verifyWebhookSignature(config.SPAITIAL_WEBHOOK_SECRET, raw, header(req, 'x-spaitial-signature'))) {
        return reply.code(401).send({ error: 'invalid_signature' });
      }
      const deliveryId = header(req, 'x-spaitial-delivery-id');
      const requestId = header(req, 'x-spaitial-request-id');
      const event = header(req, 'x-spaitial-event') ?? null;
      if (!deliveryId || !requestId) return reply.code(400).send({ error: 'missing_headers' });

      const db = deps.db ?? getDb();
      const inserted = await db
        .insert(webhookDeliveries)
        .values({ deliveryId, requestId, event })
        .onConflictDoNothing()
        .returning({ deliveryId: webhookDeliveries.deliveryId });
      req.log.info({ deliveryId, event, duplicate: inserted.length === 0 }, 'spaitial webhook');
      if (inserted.length === 0) return { ok: true, duplicate: true };

      await db.execute(sql`
        UPDATE jobs SET run_after = now(), updated_at = now()
        WHERE kind = 'track' AND phase = 'queued'
          AND world_id IN (SELECT id FROM worlds WHERE provider_request_id = ${requestId})`);
      return { ok: true };
    });
  });
}
