import { and, eq, isNull } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { getDb } from '../db/client.js';
import { devices, users, worlds } from '../db/schema.js';
import { enqueue } from '../queue.js';

// DELETE /v1/account — full account deletion (App Store requirement, spec §13).
// Soft-deletes the user's worlds and enqueues a purge for each, deletes the
// user's device tokens, and marks the user deleted. Provider-side deletion is
// handled by the purge worker (Stage 2).
export function accountRoutes(app: FastifyInstance): void {
  app.delete('/v1/account', async (req, reply) => {
    if (!req.userId) return reply.code(401).send({ error: 'unauthenticated' });
    const userId = req.userId;
    const db = getDb();

    const now = new Date();
    const live = await db
      .select({ id: worlds.id })
      .from(worlds)
      .where(and(eq(worlds.ownerId, userId), isNull(worlds.deletedAt)));

    // Each soft delete + its purge job in one transaction (spec §10 R27): a
    // crash between them hid a world whose assets were then never purged (§13).
    for (const w of live) {
      await db.transaction(async (tx) => {
        await tx.update(worlds).set({ deletedAt: now }).where(eq(worlds.id, w.id));
        await enqueue(tx, 'purge', w.id);
      });
    }

    await db.delete(devices).where(eq(devices.userId, userId));
    await db.update(users).set({ deletedAt: now }).where(eq(users.id, userId));

    return reply.send({ ok: true, worlds_purged: live.length });
  });
}
