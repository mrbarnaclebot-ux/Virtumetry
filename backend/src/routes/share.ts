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

/** 6+ chars (WR-04): with SHARE_FAIL_MAX guesses per window, a 4-digit PIN fell in under a day. */
export const SHARE_PASSWORD_MIN = 6;
const createBody = z.object({ password: z.string().min(SHARE_PASSWORD_MIN).max(64).optional() }).strict();
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
            // WR-04: reserve the attempt before the async verify, so parallel guesses can't all pass the check.
            failures.record(slug);
            if (!(await verifySharePassword(pw, hash))) return reply.code(401).send({ error: 'wrong_password' });
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

  // Link-preview landing (D-20). Root path, no CORS; never counts an open.
  app.get<{ Params: { slug: string } }>(
    '/s/:slug',
    { config: perIp(config, config.RATE_LIMIT_LANDING_MAX, 'land') },
    async (req, reply) => {
      reply.header('X-Robots-Tag', 'noindex, nofollow').header('Cache-Control', 'no-store');
      const origin = config.WEB_SHARE_ORIGIN;
      if (!origin) return reply.code(503).send({ error: 'share_unavailable' });
      reply.type('text/html; charset=utf-8');

      const live = await findLiveShare(getDb(), req.params.slug);
      if (!live) return reply.code(404).send(notFoundPage());
      const { slug } = req.params; // regex-checked by findLiveShare
      const locked = live.share.passwordHash !== null;
      const image =
        live.world.thumbnailKey && !locked
          ? await storage.presignDownload(live.world.thumbnailKey, OG_IMAGE_TTL_SECONDS)
          : null;
      return reply.send(
        landingPage({
          title: live.world.title || 'Untitled scan',
          url: `${config.PUBLIC_BASE_URL}/s/${slug}`,
          // Built only from config + the validated slug: no open redirect (T-05-15).
          target: `${origin}/r/${slug}`,
          image,
          locked,
        }),
      );
    },
  );
}

/** og:image presign TTL: 7 days, the S3 SigV4 maximum (D-20). */
export const OG_IMAGE_TTL_SECONDS = 604800;

const ESC: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
/** HTML-escape for text and double-quoted attributes (T-05-14). */
export const esc = (v: string) => v.replace(/[&<>"']/g, (c) => ESC[c]!);

function shell(pageTitle: string, head: string, body: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow">
<meta name="color-scheme" content="dark">
<title>${esc(pageTitle)}</title>
${head}
<style>
body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;background:#000;color:#fff;font-family:system-ui,-apple-system,sans-serif}
main{max-width:400px;padding:24px;text-align:center}
h1{font-size:20px;font-weight:600;margin:0 0 8px}
p{font-size:16px;margin:0 0 8px}
.lead{font-weight:600;color:#fff}
.muted{color:#B0B4BA}
a{color:#3CC8B4;font-size:16px}
</style>
</head>
<body><main>${body}</main></body>
</html>`;
}

function landingPage(o: { title: string; url: string; target: string; image: string | null; locked: boolean }) {
  const description = o.locked
    ? 'A password-protected 3D room, shared with Virtumetry.'
    : 'A 3D room you can walk through, shared with Virtumetry.';
  const head = [
    '<meta property="og:type" content="website">',
    `<meta property="og:title" content="${esc(o.title)}">`,
    `<meta property="og:description" content="${esc(description)}">`,
    `<meta property="og:url" content="${esc(o.url)}">`,
    ...(o.image ? [`<meta property="og:image" content="${esc(o.image)}">`] : []),
    `<meta name="twitter:card" content="${o.image ? 'summary_large_image' : 'summary'}">`,
    `<meta http-equiv="refresh" content="0;url=${esc(o.target)}">`,
    // JSON string with < escaped: cannot close the script element.
    `<script>location.replace(${JSON.stringify(o.target).replace(/</g, '\\u003c')})</script>`,
  ].join('\n');
  return shell(
    `${o.title} · Virtumetry`,
    head,
    `<p class="lead">Opening ${esc(o.title)}…</p><a href="${esc(o.target)}">Open the room</a>`,
  );
}

function notFoundPage(): string {
  return shell(
    'Link unavailable · Virtumetry',
    '',
    '<h1>This link is no longer available</h1><p class="muted">The owner may have turned it off. Ask them for a new link.</p>',
  );
}
