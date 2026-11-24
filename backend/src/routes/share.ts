import { randomBytes } from 'node:crypto';
import cors from '@fastify/cors';
import { and, desc, eq, isNull, sql } from 'drizzle-orm';
import { z } from 'zod';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { getDb, type Db } from '../db/client.js';
import { shareSlugs, worlds, type ShareSlug } from '../db/schema.js';
import type { Config } from '../config.js';
import { FailureThrottle } from '../throttle.js';
import { hashSharePassword, verifySharePassword } from '../share-password.js';
import { ASSET_FIELDS, findOwnedWorld, requireUserId } from './worlds.js';
import type { RouteDeps } from './deps.js';

// Share links (D-15..D-17, D-20, SHARE-01..05).
//
// Owner routes live in the authed scope; public routes (/v1/public/*, /s/:slug)
// are registered before it. A missing WEB_SHARE_ORIGIN / PUBLIC_BASE_URL never
// fails boot (T-05-41): sharing just answers 503 share_unavailable.
//
// Revocation stops NEW opens on the very next request (every public query
// re-checks revoked_at). Asset URLs already handed out stay valid for at most
// PUBLIC_ASSET_TTL_SECONDS (15 min) — accepted residual window, D-17.

/** Presign TTL for assets handed to anonymous visitors (D-17). */
export const PUBLIC_ASSET_TTL_SECONDS = 900;
const SLUG_RE = /^[A-Za-z0-9_-]{22}$/;
const NOT_FOUND = { error: 'share_not_found' } as const;

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

const openBody = z.object({ password: z.string().max(64).optional() }).strict();

/** A share a visitor may open: not revoked, world ready and not deleted. */
async function findLiveShare(db: Db, slug: string) {
  if (!SLUG_RE.test(slug)) return undefined; // never hits the DB (T-05-11)
  const [row] = await db
    .select({ share: shareSlugs, world: worlds })
    .from(shareSlugs)
    .innerJoin(worlds, eq(worlds.id, shareSlugs.worldId))
    .where(
      and(
        eq(shareSlugs.slug, slug),
        isNull(shareSlugs.revokedAt),
        eq(worlds.status, 'ready'),
        isNull(worlds.deletedAt),
      ),
    )
    .limit(1);
  return row;
}

const perIp = (config: Config, max: number, prefix: string) => ({
  rateLimit: {
    max,
    timeWindow: config.RATE_LIMIT_WINDOW_MS,
    keyGenerator: (req: FastifyRequest) => `${prefix}:${req.ip}`,
  },
});

/** Unauthenticated share routes; register BEFORE the authed scope. */
export async function publicShareRoutes(app: FastifyInstance, deps: RouteDeps): Promise<void> {
  const { config, storage } = deps;
  // Wrong passwords per slug (T-05-12), checked before any scrypt work.
  const failures = new FailureThrottle({ max: config.SHARE_FAIL_MAX, windowMs: config.RATE_LIMIT_WINDOW_MS });

  await app.register(
    async (pub) => {
      const origin = config.WEB_SHARE_ORIGIN;
      if (!origin) {
        pub.addHook('onRequest', async (_req, reply) => reply.code(503).send({ error: 'share_unavailable' }));
      } else {
        // Scoped to /v1/public only (T-05-19); no credentials.
        const origins = [origin, ...(config.NODE_ENV === 'production' ? [] : ['http://localhost:8081'])];
        await pub.register(cors, { origin: origins, methods: ['GET', 'POST'] });
      }

      pub.get<{ Params: { slug: string } }>(
        '/shares/:slug',
        { config: perIp(config, config.RATE_LIMIT_PUBLIC_MAX, 'pub') },
        async (req, reply) => {
          const live = await findLiveShare(getDb(), req.params.slug);
          if (!live) return reply.code(404).send(NOT_FOUND);
          return reply.send({ title: live.world.title, needs_password: live.share.passwordHash !== null });
        },
      );

      pub.post<{ Params: { slug: string } }>(
        '/shares/:slug/open',
        { config: perIp(config, config.RATE_LIMIT_SHARE_OPEN_MAX, 'open') },
        async (req, reply) => {
          const db = getDb();
          const { slug } = req.params;
          const live = await findLiveShare(db, slug);
          if (!live) return reply.code(404).send(NOT_FOUND);
          const parsed = openBody.safeParse(req.body ?? {});
          if (!parsed.success) return reply.code(400).send({ error: 'invalid_body' });

          const hash = live.share.passwordHash;
          if (hash !== null) {
            if (failures.isBlocked(slug)) {
              return reply.code(429).send({ error: 'rate_limited', retry_after: failures.retryAfterSeconds(slug) });
            }
            const pw = parsed.data.password;
            if (pw === undefined) return reply.code(401).send({ error: 'password_required' });
            if (!(await verifySharePassword(pw, hash))) {
              failures.record(slug);
              return reply.code(401).send({ error: 'wrong_password' });
            }
            failures.reset(slug);
          }

          // Atomic count; re-checks revoked_at so a revoke racing this open wins.
          const [counted] = await db
            .update(shareSlugs)
            .set({ openCount: sql`${shareSlugs.openCount} + 1`, lastOpenedAt: sql`now()` })
            .where(and(eq(shareSlugs.id, live.share.id), isNull(shareSlugs.revokedAt)))
            .returning({ id: shareSlugs.id });
          if (!counted) return reply.code(404).send(NOT_FOUND);

          const assets: Record<string, string> = {};
          for (const [field, out] of ASSET_FIELDS) {
            const key = live.world[field];
            if (key && field !== 'thumbnailKey') {
              assets[out] = await storage.presignDownload(key, PUBLIC_ASSET_TTL_SECONDS);
            }
          }
          return reply.send({
            title: live.world.title,
            floorplan_meta: live.world.floorplanMeta ?? null,
            assets,
          });
        },
      );
    },
    { prefix: '/v1/public' },
  );
}
