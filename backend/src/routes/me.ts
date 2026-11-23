import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { getDb } from '../db/client.js';
import { users } from '../db/schema.js';
import { quotaStatus } from '../quota.js';
import type { RouteDeps } from './deps.js';

// GET /v1/me/quota — read-only daily-scan allowance for the authed user.
// The capture app calls this BEFORE starting a capture so a user is never told
// they're out of quota only AFTER shooting a full session (the 429-at-create
// failure this fixes). Uses the exact same window logic as POST /v1/worlds
// (quotaStatus / evaluateQuota share windowExpired) so the two never disagree.
export function meRoutes(app: FastifyInstance, deps: RouteDeps): void {
  const { config } = deps;

  app.get('/v1/me/quota', async (req, reply) => {
    if (!req.userId) return reply.code(401).send({ error: 'unauthenticated' });
    const db = getDb();

    const [user] = await db.select().from(users).where(eq(users.id, req.userId)).limit(1);
    if (!user) return reply.code(401).send({ error: 'unknown_user' });

    const status = quotaStatus(
      { dailyScanCount: user.dailyScanCount, quotaResetAt: user.quotaResetAt },
      config.DAILY_SCAN_QUOTA,
    );
    return reply.send({
      scans_remaining: status.scansRemaining,
      // Date | null → Fastify serializes a Date to an ISO-8601 string.
      quota_resets_at: status.quotaResetsAt,
      daily_quota: status.dailyQuota,
    });
  });
}
