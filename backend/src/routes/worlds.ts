import { and, desc, eq, isNull } from 'drizzle-orm';
import { z } from 'zod';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { getDb } from '../db/client.js';
import { worlds, type World } from '../db/schema.js';
import { enqueue } from '../queue.js';
import type { QuotaChargeResult } from '../quota.js';
import type { StorageDriver } from '../storage/index.js';
import type { RouteDeps } from './deps.js';

export const DOWNLOAD_TTL_SECONDS = 3600;

/** Per-user scan quota refusal (spec §7.1). `message` is short display copy. */
export function sendScanQuotaExceeded(reply: FastifyReply, charge: QuotaChargeResult) {
  return reply.code(429).send({
    error: 'scan_quota_exceeded',
    message: 'Daily scan limit reached.',
    retry_at: charge.resetAt,
  });
}

// Asset columns that hold a storage key → the JSON field name we sign into.
// Keys are re-hosted Echo-3 outputs (D-15/PROC-07).
export const ASSET_FIELDS = [
  ['splatKey', 'splat_url'],
  ['colliderKey', 'collider_url'],
  ['floorplanKey', 'floorplan_url'],
  ['camerasKey', 'cameras_url'],
  ['thumbnailKey', 'thumbnail_url'],
] as const;

/** GET /v1/worlds pagination. Exported so the 400 contract is directly testable. */
export const listQuery = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(20),
  offset: z.coerce.number().int().min(0).default(0),
});

/** PATCH /v1/worlds/:id body (D-16): title only, trimmed, 1-80 chars. */
export const renameBody = z.object({ title: z.string().trim().min(1).max(80) }).strict();

export function requireUserId(req: FastifyRequest, reply: FastifyReply): string | null {
  if (!req.userId) {
    reply.code(401).send({ error: 'unauthenticated' });
    return null;
  }
  return req.userId;
}

export function serializeWorld(w: World): Record<string, unknown> {
  return {
    id: w.id,
    title: w.title,
    caption: w.caption,
    lat: w.lat,
    lng: w.lng,
    place_name: w.placeName,
    is_public: w.isPublic,
    status: w.status,
    phase: w.phase,
    // Within-status completion 0–100 (null between phases) + the heartbeat
    // (worlds.updated_at, touched on every pipeline write) so clients can
    // render a progress bar and flag a stalled job.
    progress: w.progress,
    heartbeat_at: w.updatedAt,
    asset_version: w.assetVersion,
    provider: w.provider,
    credits_spent: w.creditsSpent,
    created_at: w.createdAt,
    // D-15a: honest Library states. eta_seconds stays null until a real ETA exists.
    failure_stage: w.failureStage,
    failure_code: w.failureCode,
    failure_message: w.failureMessage,
    charged: w.charged,
    eta_seconds: null,
  };
}

/**
 * List-item shape for GET /v1/worlds (iOS Library screen contract): the
 * serializeWorld fields plus an `assets` object carrying ONLY a presigned
 * `thumbnail_url` (when the key column is set). Deliberately does NOT presign
 * the heavy asset fields (spz/collider) in list context — presigning is
 * per-item crypto and the Library only renders thumbnails; the detail route
 * keeps signing everything. Exported for tests.
 */
export async function serializeWorldListItem(
  w: World,
  storage: StorageDriver,
): Promise<Record<string, unknown>> {
  const assets: { thumbnail_url?: string } = {};
  if (w.thumbnailKey) {
    assets.thumbnail_url = await storage.presignDownload(
      w.thumbnailKey,
      DOWNLOAD_TTL_SECONDS,
    );
  }
  return { ...serializeWorld(w), assets };
}

/**
 * GET /v1/worlds/:id body: serializeWorld plus the floor-plan meta (detail only, the
 * list stays lean) and every set asset key presigned.
 */
export async function serializeWorldDetail(w: World, storage: StorageDriver) {
  const assets: Record<string, string> = {};
  for (const [field, out] of ASSET_FIELDS) {
    const key = w[field];
    if (key) assets[out] = await storage.presignDownload(key, DOWNLOAD_TTL_SECONDS);
  }
  return { world: { ...serializeWorld(w), floorplan_meta: w.floorplanMeta ?? null }, assets };
}

export function worldsRoutes(app: FastifyInstance, deps: RouteDeps): void {
  const { storage } = deps;

  // GET /v1/worlds/:id — status/phase + signed asset URLs.
  app.get<{ Params: { id: string } }>('/v1/worlds/:id', async (req, reply) => {
    const userId = requireUserId(req, reply);
    if (!userId) return;
    const db = getDb();
    const world = await findOwnedWorld(db, req.params.id, userId);
    if (!world) return reply.code(404).send({ error: 'world_not_found' });

    return reply.send(await serializeWorldDetail(world, storage));
  });

  // GET /v1/worlds — owner's library, paginated, excluding soft-deleted.
  app.get('/v1/worlds', async (req, reply) => {
    const userId = requireUserId(req, reply);
    if (!userId) return;
    // safeParse, not parse: `?limit=abc` used to throw a ZodError out of the
    // handler and surface as a 500 (spec §10 R10). A malformed query string is
    // the client's mistake, and the 3 s Library poll must see a clean 400.
    const parsedQuery = listQuery.safeParse(req.query);
    if (!parsedQuery.success) {
      return reply
        .code(400)
        .send({ error: 'invalid_query', issues: parsedQuery.error.issues });
    }
    const q = parsedQuery.data;
    const db = getDb();
    const rows = await db
      .select()
      .from(worlds)
      .where(and(eq(worlds.ownerId, userId), isNull(worlds.deletedAt)))
      .orderBy(desc(worlds.createdAt))
      .limit(q.limit + 1)
      .offset(q.offset);

    const hasMore = rows.length > q.limit;
    const page = hasMore ? rows.slice(0, q.limit) : rows;
    // Each list item carries assets.thumbnail_url (only) — see
    // serializeWorldListItem. Presigning is pure crypto (no I/O), so the
    // per-item Promise.all is cheap.
    const items = await Promise.all(
      page.map((w) => serializeWorldListItem(w, storage)),
    );
    return reply.send({
      worlds: items,
      has_more: hasMore,
      // Kept alongside has_more for existing pagination consumers.
      next_offset: hasMore ? q.offset + q.limit : null,
    });
  });

  // PATCH /v1/worlds/:id — rename (D-16). Owner-only; title is the only
  // writable field. The UPDATE re-checks owner + not-deleted itself.
  app.patch<{ Params: { id: string } }>('/v1/worlds/:id', async (req, reply) => {
    const userId = requireUserId(req, reply);
    if (!userId) return;
    const parsed = renameBody.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_body' });
    const db = getDb();
    const world = await findOwnedWorld(db, req.params.id, userId);
    if (!world) return reply.code(404).send({ error: 'world_not_found' });

    const [row] = await db
      .update(worlds)
      .set({ title: parsed.data.title, updatedAt: new Date() })
      .where(and(eq(worlds.id, world.id), eq(worlds.ownerId, userId), isNull(worlds.deletedAt)))
      .returning();
    if (!row) return reply.code(404).send({ error: 'world_not_found' });
    return reply.send(serializeWorld(row));
  });

  // DELETE /v1/worlds/:id — soft delete + enqueue purge.
  app.delete<{ Params: { id: string } }>('/v1/worlds/:id', async (req, reply) => {
    const userId = requireUserId(req, reply);
    if (!userId) return;
    const db = getDb();
    const world = await findOwnedWorld(db, req.params.id, userId);
    if (!world) return reply.code(404).send({ error: 'world_not_found' });

    // One transaction (spec §10 R27): a soft delete without its purge job hides
    // the world forever while its assets stay in R2 (§13).
    const jobId = await db.transaction(async (tx) => {
      await tx
        .update(worlds)
        .set({ deletedAt: new Date(), updatedAt: new Date() })
        .where(eq(worlds.id, world.id));
      return enqueue(tx, 'purge', world.id);
    });
    return reply.send({ ok: true, job_id: jobId });
  });
}

/**
 * True when an error is a Postgres unique-constraint violation (SQLSTATE 23505).
 * Drizzle may wrap the driver error, so the whole `cause` chain is inspected.
 */
export function isUniqueViolation(err: unknown): boolean {
  return hasPgCode(err, '23505');
}

/**
 * SQLSTATE 22P02 — `invalid_text_representation`, i.e. Postgres was handed
 * something that is not a uuid for `worlds.id`.
 *
 * This is reachable from the router: `GET /v1/worlds/<uuid>:foo` matches
 * `GET /v1/worlds/:id` (the colon is an ordinary path character) with
 * `id = '<uuid>:foo'`, and the same is true of any hand-typed garbage id.
 * Without this the query throws, the last-resort handler logs it as an unhandled
 * error and answers `500 internal_error` — for what is simply a URL naming a
 * world that cannot exist. A malformed id is a 404, not a server fault.
 */
export function isInvalidTextRepresentation(err: unknown): boolean {
  return hasPgCode(err, '22P02');
}

/**
 * True when `err` — or anything in its `cause` chain, since Drizzle may wrap the
 * driver error — carries the given Postgres SQLSTATE.
 */
function hasPgCode(err: unknown, code: string): boolean {
  let cur: unknown = err;
  for (let hops = 0; cur && hops < 5; hops++) {
    if (typeof cur === 'object' && (cur as { code?: unknown }).code === code) return true;
    cur = (cur as { cause?: unknown }).cause;
  }
  return false;
}

/** Look a world up by its owner's idempotency key, INCLUDING soft-deleted rows
 * (a replayed key must not silently resurrect or duplicate a deleted world). */
export async function findWorldByClientRequestId(
  db: ReturnType<typeof getDb>,
  userId: string,
  clientRequestId: string,
): Promise<World | undefined> {
  const [world] = await db
    .select()
    .from(worlds)
    .where(
      and(eq(worlds.ownerId, userId), eq(worlds.clientRequestId, clientRequestId)),
    )
    .limit(1);
  return world;
}

/**
 * The world `id` names a row this user owns, or nothing. A `:id` that is not a
 * uuid is "nothing" too (see isInvalidTextRepresentation) rather than a 500 —
 * every caller already answers `404 world_not_found` on undefined.
 */
export async function findOwnedWorld(
  db: ReturnType<typeof getDb>,
  id: string,
  userId: string,
): Promise<World | undefined> {
  try {
    const [world] = await db
      .select()
      .from(worlds)
      .where(and(eq(worlds.id, id), eq(worlds.ownerId, userId), isNull(worlds.deletedAt)))
      .limit(1);
    return world;
  } catch (err) {
    if (isInvalidTextRepresentation(err)) return undefined;
    throw err;
  }
}
