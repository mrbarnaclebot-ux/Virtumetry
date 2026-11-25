import { and, desc, eq, isNull, sql } from 'drizzle-orm';
import { z } from 'zod';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { getDb } from '../db/client.js';
import { captures, worldAttempts, worlds, type World } from '../db/schema.js';
import { enqueue } from '../queue.js';
import type { QuotaChargeResult } from '../quota.js';
import { budgetAlertFor, spentCredits } from '../budget.js';
import { createProvider, ProviderError, ProviderTimeoutError } from '../provider/index.js';
import { applyRetry, heldReserveSql, isRetryable, ledgerClear } from '../retry.js';
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

/** Per-world facts the payload needs beyond the row: latest capture's frames (A-03), held reserve (A-02). */
export type WorldExtra = { frameCount?: number | null; ledgerHeld?: boolean };

/** POST /v1/worlds/:id/retry body (D-09): the fresh explicit approval. */
export const retryBody = z
  .object({ approved_max_credits: z.number().int().positive().max(2_000_000_000) })
  .strict();

export function serializeWorld(w: World, extra?: WorldExtra): Record<string, unknown> {
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
    // D-08/A-02: the only source of the Retry button. Held reserve = maybe billed.
    retryable: isRetryable(w) && !extra?.ledgerHeld,
    submit_attempt: w.submitAttempt,
    frame_count: extra?.frameCount ?? null,
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
  extra?: WorldExtra,
): Promise<Record<string, unknown>> {
  const assets: { thumbnail_url?: string } = {};
  if (w.thumbnailKey) {
    assets.thumbnail_url = await storage.presignDownload(
      w.thumbnailKey,
      DOWNLOAD_TTL_SECONDS,
    );
  }
  return { ...serializeWorld(w, extra), assets };
}

/**
 * GET /v1/worlds/:id body: serializeWorld plus the floor-plan meta (detail only, the
 * list stays lean) and every set asset key presigned.
 */
export async function serializeWorldDetail(w: World, storage: StorageDriver, extra?: WorldExtra) {
  const assets: Record<string, string> = {};
  for (const [field, out] of ASSET_FIELDS) {
    const key = w[field];
    if (key) assets[out] = await storage.presignDownload(key, DOWNLOAD_TTL_SECONDS);
  }
  return { world: { ...serializeWorld(w, extra), floorplan_meta: w.floorplanMeta ?? null }, assets };
}

export function worldsRoutes(app: FastifyInstance, deps: RouteDeps): void {
  const { config, storage } = deps;
  const provider = deps.provider ?? createProvider(config);

  // GET /v1/worlds/:id — status/phase + signed asset URLs.
  app.get<{ Params: { id: string } }>('/v1/worlds/:id', async (req, reply) => {
    const userId = requireUserId(req, reply);
    if (!userId) return;
    const db = getDb();
    const world = await findOwnedWorld(db, req.params.id, userId);
    if (!world) return reply.code(404).send({ error: 'world_not_found' });

    const cap = await latestCapture(db, world.id);
    const ledgerHeld = !(await ledgerClear(db, world.submissionKey));
    return reply.send(
      await serializeWorldDetail(world, storage, { frameCount: cap?.frameCount ?? null, ledgerHeld }),
    );
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
    // One query (A-03): latest capture's frame count + WR-01 held reserve per row.
    // Raw `worlds.submission_key`: an unqualified column would bind to credit_events r.
    const rows = await db
      .select({
        world: worlds,
        frameCount: sql<number | null>`(SELECT c.frame_count FROM captures c WHERE c.world_id = worlds.id ORDER BY c.created_at DESC LIMIT 1)`,
        ledgerHeld: sql<boolean>`EXISTS(${heldReserveSql(sql`worlds.submission_key`)})`,
      })
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
      page.map((r) =>
        serializeWorldListItem(r.world, storage, {
          frameCount: r.frameCount == null ? null : Number(r.frameCount),
          ledgerHeld: r.ledgerHeld === true,
        }),
      ),
    );
    const budgetAlert = budgetAlertFor(await spentCredits(db, provider.mode), {
      daily: config.DAILY_CREDIT_BUDGET,
      monthly: config.MONTHLY_CREDIT_BUDGET,
      share: config.BUDGET_ALERT_SHARE,
    });
    return reply.send({
      worlds: items,
      has_more: hasMore,
      // Kept alongside has_more for existing pagination consumers.
      next_offset: hasMore ? q.offset + q.limit : null,
      budgetAlert,
    });
  });

  // POST /v1/worlds/:id/retry — D-09: a fresh explicit approval turns a
  // retryable failure into exactly one new attempt with a new submission key.
  // Never charges the scan quota (A-04). Logs the world id only.
  app.post<{ Params: { id: string } }>('/v1/worlds/:id/retry', {
    config: {
      rateLimit: {
        max: config.RATE_LIMIT_CREATE_MAX,
        timeWindow: config.RATE_LIMIT_WINDOW_MS,
        keyGenerator: (req: FastifyRequest) => `create:${req.userId ?? req.ip}`,
      },
    },
  }, async (req, reply) => {
    const userId = requireUserId(req, reply);
    if (!userId) return;
    const parsed = retryBody.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'invalid_body', issues: parsed.error.issues });
    }
    const keyHeader = req.headers['idempotency-key'];
    const rawKey = Array.isArray(keyHeader) ? keyHeader[0] : keyHeader;
    if (rawKey === undefined) return reply.code(400).send({ error: 'missing_idempotency_key' });
    const key = z.guid().safeParse(rawKey.trim());
    if (!key.success) {
      return reply.code(400).send({ error: 'invalid_idempotency_key', detail: 'expected a UUID' });
    }
    const clientRequestId = key.data;

    const db = getDb();
    const world = await findOwnedWorld(db, req.params.id, userId);
    if (!world) return reply.code(404).send({ error: 'world_not_found' });

    // Idempotency-Key replay: this key already archived an attempt → current world.
    const replay = async () => {
      const [hit] = await db
        .select({ id: worldAttempts.id })
        .from(worldAttempts)
        .where(and(eq(worldAttempts.worldId, world.id), eq(worldAttempts.clientRequestId, clientRequestId)))
        .limit(1);
      if (!hit) return null;
      const current = (await findOwnedWorld(db, world.id, userId)) ?? world;
      const cap = await latestCapture(db, world.id);
      // WR-11: same ledger guard as GET /v1/worlds/:id, so `retryable` agrees.
      const ledgerHeld = !(await ledgerClear(db, current.submissionKey));
      return { world: serializeWorld(current, { frameCount: cap?.frameCount ?? null, ledgerHeld }) };
    };
    const replayed = await replay();
    if (replayed) return reply.send(replayed);

    if (!isRetryable(world) || !(await ledgerClear(db, world.submissionKey))) {
      return reply.code(409).send({ error: 'not_retryable' });
    }
    const cap = await latestCapture(db, world.id);
    if (!cap) return reply.code(409).send({ error: 'not_retryable' });
    let quote: Awaited<ReturnType<typeof provider.quote>>;
    try {
      quote = await provider.quote(cap.frameCount);
    } catch (err) {
      if (!(err instanceof ProviderError)) throw err;
      // WR-11: a provider hiccup is not our 500. 429/503/timeout → 503 with a
      // backoff hint; anything else (bad shape, 5xx, 4xx) → 502. Nothing was written.
      const transient = err instanceof ProviderTimeoutError || err.status === 429 || err.status === 503;
      req.log.warn({ worldId: world.id, status: err.status, code: err.code }, 'retry quote failed');
      return transient
        ? reply.code(503).send({ error: 'quote_unavailable', retry_after: err.retryAfterS ?? null })
        : reply.code(502).send({ error: 'quote_failed' });
    }
    if (parsed.data.approved_max_credits < quote.credits) {
      return reply.code(400).send({ error: 'approval_below_quote', quote_credits: quote.credits });
    }

    let row: World | null;
    try {
      row = await applyRetry(db, world, {
        approvedMaxCredits: parsed.data.approved_max_credits,
        clientRequestId,
        bundlePresent: !!cap.bundleKey,
        captureId: cap.id,
      });
    } catch (err) {
      if (!isUniqueViolation(err)) throw err;
      // Same key raced itself → replay; a different key took this attempt → 409.
      const raced = await replay();
      if (raced) return reply.send(raced);
      return reply.code(409).send({ error: 'not_retryable' });
    }
    if (!row) return reply.code(409).send({ error: 'not_retryable' });
    req.log.info({ worldId: world.id }, 'retry approved');
    // A freshly minted key holds no reserve yet.
    return reply.send({ world: serializeWorld(row, { frameCount: cap.frameCount, ledgerHeld: false }) });
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

/** The world's newest capture (captures ordered by created_at desc). Shared with scans.ts. */
export async function latestCapture(db: ReturnType<typeof getDb>, worldId: string) {
  const [capture] = await db
    .select()
    .from(captures)
    .where(eq(captures.worldId, worldId))
    .orderBy(desc(captures.createdAt))
    .limit(1);
  return capture;
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
