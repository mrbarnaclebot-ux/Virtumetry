import { z } from 'zod';
import type { FastifyInstance } from 'fastify';
import { getDb } from '../db/client.js';
import { devices } from '../db/schema.js';

const body = z.object({ apns_token: z.string().min(1) });

// POST /v1/devices — register/refresh an APNs token (spec §7.1). Upsert keyed
// by token so re-registering the same device is idempotent.
export function devicesRoutes(app: FastifyInstance): void {
  app.post('/v1/devices', async (req, reply) => {
    if (!req.userId) return reply.code(401).send({ error: 'unauthenticated' });
    const parsed = body.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'invalid_body', issues: parsed.error.issues });
    }
    const db = getDb();
    await db
      .insert(devices)
      .values({ userId: req.userId, apnsToken: parsed.data.apns_token })
      .onConflictDoUpdate({
        target: devices.apnsToken,
        set: { userId: req.userId, updatedAt: new Date() },
      });
    return reply.send({ ok: true });
  });
}
