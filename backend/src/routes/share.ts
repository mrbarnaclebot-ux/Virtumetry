import { randomBytes } from 'node:crypto';
import { and, desc, eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import type { FastifyInstance } from 'fastify';
import { getDb } from '../db/client.js';
import { shareSlugs, type ShareSlug } from '../db/schema.js';
import type { Config } from '../config.js';
import { hashSharePassword } from '../share-password.js';
import { findOwnedWorld, requireUserId } from './worlds.js';
import type { RouteDeps } from './deps.js';

// Share links (D-15..D-17, D-20, SHARE-01..05).
//
// Owner routes live in the authed scope; public routes (/v1/public/*, /s/:slug)
// are registered before it. A missing WEB_SHARE_ORIGIN / PUBLIC_BASE_URL never
// fails boot (T-05-41): sharing just answers 503 share_unavailable.

const isProdLike = (config: Config) => config.NODE_ENV === 'production' || !!config.RAILWAY_ENVIRONMENT_ID;

/** Can we mint a URL someone outside this machine can open? */
export function shareConfigured(config: Config): boolean {
  return !!config.WEB_SHARE_ORIGIN && (config.PUBLIC_BASE_URL_EXPLICIT || !isProdLike(config));
}

const createBody = z.object({ password: z.string().min(4).max(64).optional() }).strict();
const shareIdParam = z.string().uuid();

export function serializeShare(row: ShareSlug, config: Config) {
  return {
    id: row.id,
    slug: row.slug,
    url: `${config.PUBLIC_BASE_URL}/s/${row.slug}`,
    has_password: row.passwordHash !== null,
    open_count: row.openCount,
    created_at: row.createdAt,
    revoked_at: row.revokedAt,
  };
}

export function shareRoutes(app: FastifyInstance, deps: RouteDeps): void {
  const { config } = deps;

  app.post<{ Params: { id: string } }>('/v1/worlds/:id/shares', async (req, reply) => {
    const userId = requireUserId(req, reply);
    if (!userId) return;
    if (!shareConfigured(config)) return reply.code(503).send({ error: 'share_unavailable' });
    const parsed = createBody.safeParse(req.body ?? {});
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_body' });
    const db = getDb();
    const world = await findOwnedWorld(db, req.params.id, userId);
    if (!world) return reply.code(404).send({ error: 'world_not_found' });
    if (world.status !== 'ready') return reply.code(409).send({ error: 'world_not_ready' });

    const pw = parsed.data.password;
    const [row] = await db
      .insert(shareSlugs)
      .values({
        worldId: world.id,
        // 128 random bits (T-05-11): unguessable, 22 chars.
        slug: randomBytes(16).toString('base64url'),
        passwordHash: pw === undefined ? null : await hashSharePassword(pw),
      })
      .returning();
    return reply.code(201).send(serializeShare(row!, config));
  });

  app.get<{ Params: { id: string } }>('/v1/worlds/:id/shares', async (req, reply) => {
    const userId = requireUserId(req, reply);
    if (!userId) return;
    const db = getDb();
    const world = await findOwnedWorld(db, req.params.id, userId);
    if (!world) return reply.code(404).send({ error: 'world_not_found' });
    const rows = await db
      .select()
      .from(shareSlugs)
      .where(eq(shareSlugs.worldId, world.id))
      .orderBy(desc(shareSlugs.createdAt), desc(shareSlugs.id));
    return reply.send({ shares: rows.map((r) => serializeShare(r, config)) });
  });

  app.delete<{ Params: { id: string; shareId: string } }>(
    '/v1/worlds/:id/shares/:shareId',
    async (req, reply) => {
      const userId = requireUserId(req, reply);
      if (!userId) return;
      if (!shareIdParam.safeParse(req.params.shareId).success) {
        return reply.code(404).send({ error: 'share_not_found' });
      }
      const db = getDb();
      const world = await findOwnedWorld(db, req.params.id, userId);
      if (!world) return reply.code(404).send({ error: 'world_not_found' });
      const [row] = await db
        .update(shareSlugs)
        .set({ revokedAt: sql`coalesce(${shareSlugs.revokedAt}, now())` })
        .where(and(eq(shareSlugs.id, req.params.shareId), eq(shareSlugs.worldId, world.id)))
        .returning({ id: shareSlugs.id });
      if (!row) return reply.code(404).send({ error: 'share_not_found' });
      return reply.code(204).send();
    },
  );
}
