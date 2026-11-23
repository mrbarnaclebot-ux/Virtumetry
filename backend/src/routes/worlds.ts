import { and, desc, eq, isNull } from 'drizzle-orm';
import { z } from 'zod';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { getDb } from '../db/client.js';
import { captures, worlds, type World } from '../db/schema.js';
import { enqueue } from '../queue.js';
import { chargeScanQuota, releaseScanQuota, type QuotaChargeResult } from '../quota.js';
import { MAX_FRAME_BYTES, type StorageDriver } from '../storage/index.js';
import type { RouteDeps } from './deps.js';

const DOWNLOAD_TTL_SECONDS = 3600;

/** Per-user scan quota refusal (spec §7.1). `message` is short display copy. */
function sendScanQuotaExceeded(reply: FastifyReply, charge: QuotaChargeResult) {
  return reply.code(429).send({
    error: 'scan_quota_exceeded',
    message: 'Daily scan limit reached.',
    retry_at: charge.resetAt,
  });
}

// Asset columns that hold a storage key → the JSON field name we sign into.
const ASSET_FIELDS = [
  ['thumbnailUrl', 'thumbnail_url'],
  ['spz100kUrl', 'spz_100k_url'],
  ['spz500kUrl', 'spz_500k_url'],
  ['spzFullUrl', 'spz_full_url'],
  ['colliderGlbUrl', 'collider_glb_url'],
] as const;

/**
 * Optional per-frame size declaration (spec §10 R7). The capture app knows each
 * frame's exact byte length at create time (the files are already on disk), so
 * declaring it lets the backend SIGN Content-Length into that frame's presigned
 * URL — the object store then rejects anything larger. The field is optional so
 * the shipped client keeps working; the worker-side guard covers it either way.
 */
const frameSizeSchema = z.object({
  index: z.number().int().min(0).max(63),
  bytes: z.number().int().positive().max(MAX_FRAME_BYTES),
});

const createBody = z.object({
  title: z.string().max(200).optional(),
  lat: z.number().min(-90).max(90).optional(),
  lng: z.number().min(-180).max(180).optional(),
  frame_count: z.number().int().min(1).max(64),
  frames: z.array(frameSizeSchema).max(64).optional(),
});

/** Same optional declaration on the resume path. Body may be absent entirely. */
export const refreshUploadsBody = z
  .object({ frames: z.array(frameSizeSchema).max(64).optional() })
  .optional()
  .nullable();

/** index → exact byte size, from an optional `frames` declaration. */
export function frameSizeMap(
  frames?: { index: number; bytes: number }[],
): Map<number, number> {
  return new Map((frames ?? []).map((f) => [f.index, f.bytes]));
}

// Per-frame ARKit pose sent by the capture app on frames:done. `.passthrough()`
// keeps unknown extra fields so poses_json stores what the client sent
// verbatim (forward-compatible with future ARKit metadata).
const poseSchema = z
  .object({
    index: z.number().int().min(0),
    timestamp: z.number(),
    transform: z.array(z.number()).length(16), // 4x4 row-major.
    intrinsics: z.array(z.number()).length(9), // 3x3 camera intrinsics.
    exposureLocked: z.boolean(),
    // Capture v2 optional fields (spec §5.2 item 1). Typed so a wrong type or a
    // nonsensical value is a clear 400 here rather than a confused
    // reconstruction later; bounds are generous physical limits, not tuning. Absent = omit the
    // key (a JSON null is rejected like any other wrong type).
    iso: z.number().nonnegative().max(100_000).optional(),
    exposureDuration: z.number().nonnegative().max(60).optional(), // seconds
  })
  .passthrough();

// frames:done body is OPTIONAL — the current app version sends nothing, and
// absent/empty body must keep behaving exactly as before.
export const framesDoneBody = z
  .object({ poses: z.array(poseSchema).max(64).optional() })
  .optional()
  .nullable();

// Generous ceiling for 64 poses (~25 numbers each); Fastify rejects anything
// larger with a clean 413 instead of buffering unbounded JSON.
const FRAMES_DONE_BODY_LIMIT = 256 * 1024;

/** GET /v1/worlds pagination. Exported so the 400 contract is directly testable. */
export const listQuery = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(20),
  offset: z.coerce.number().int().min(0).default(0),
});

function requireUserId(req: FastifyRequest, reply: FastifyReply): string | null {
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
  };
}

/**
 * List-item shape for GET /v1/worlds (iOS Library screen contract): the
 * serializeWorld fields plus an `assets` object carrying ONLY a presigned
 * `thumbnail_url` (when the key column is set). Deliberately does NOT presign
 * the heavy asset fields (spz/pano/collider) in list context — presigning is
 * per-item crypto and the Library only renders thumbnails; the detail route
 * keeps signing everything. Exported for tests.
 */
export async function serializeWorldListItem(
  w: World,
  storage: StorageDriver,
): Promise<Record<string, unknown>> {
  const assets: { thumbnail_url?: string } = {};
  if (w.thumbnailUrl) {
    assets.thumbnail_url = await storage.presignDownload(
      w.thumbnailUrl,
      DOWNLOAD_TTL_SECONDS,
    );
  }
  return { ...serializeWorld(w), assets };
}

export function worldsRoutes(app: FastifyInstance, deps: RouteDeps): void {
  const { config, storage } = deps;

  // POST /v1/worlds — create world shell + capture, return presigned frame URLs.
  //
  // Carries its OWN rate-limit bucket (spec §10 R10), far tighter than the
  // general per-user one: every accepted call can become a billable generation,
  // and DAILY_SCAN_QUOTA is 10/day, so a minute's worth of creates is small by
  // definition. Quota is the correctness guard; this is the cost guard in front
  // of it, so a runaway client is refused before it touches the ledger at all.
  app.post('/v1/worlds', {
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

    const parsed = createBody.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'invalid_body', issues: parsed.error.issues });
    }
    const body = parsed.data;
    const sizes = frameSizeMap(body.frames);
    const db = getDb();

    // Idempotency-Key (spec §10 R4): the client's capture-session UUID. A retry
    // of a create that already succeeded must return the SAME world — not mint a
    // second one, and not charge quota again.
    const keyHeader = req.headers['idempotency-key'];
    const rawKey = Array.isArray(keyHeader) ? keyHeader[0] : keyHeader;
    let clientRequestId: string | null = null;
    if (rawKey !== undefined) {
      // z.guid(), not z.uuid(): zod 4's uuid() enforces RFC 9562 version and
      // variant bits, which zod 3 did not — keep accepting any 8-4-4-4-12 hex.
      const key = z.guid().safeParse(rawKey.trim());
      if (!key.success) {
        return reply
          .code(400)
          .send({ error: 'invalid_idempotency_key', detail: 'expected a UUID' });
      }
      clientRequestId = key.data;

      const existing = await findWorldByClientRequestId(db, userId, clientRequestId);
      if (existing) {
        return replayCreate(reply, db, storage, existing, sizes);
      }
    }

    // Daily scan quota (spec §7). ONE conditional UPDATE … RETURNING — the
    // old read-then-write let two concurrent creates both pass at the limit
    // (spec §10 R9).
    const charge = await chargeScanQuota(db, userId, config.DAILY_SCAN_QUOTA);
    if (!charge.userFound) return reply.code(401).send({ error: 'unknown_user' });
    if (!charge.allowed) return sendScanQuotaExceeded(reply, charge);

    // Create the world shell in the uploading state.
    let world: World;
    try {
      const [row] = await db
        .insert(worlds)
        .values({
          ownerId: userId,
          title: body.title ?? null,
          lat: body.lat ?? null,
          lng: body.lng ?? null,
          status: 'uploading',
          clientRequestId,
        })
        .returning();
      world = row!;
    } catch (err) {
      // Concurrent duplicate: two in-flight creates with the same key. The
      // unique index — not this handler — is what makes that impossible, so the
      // loser refunds the scan it just charged and replays the winner's world.
      if (!clientRequestId || !isUniqueViolation(err)) throw err;
      await releaseScanQuota(db, userId);
      const winner = await findWorldByClientRequestId(db, userId, clientRequestId);
      if (!winner) throw err; // not our constraint after all — surface it.
      return replayCreate(reply, db, storage, winner, sizes);
    }

    // Create the capture row and its frame-key prefix.
    const [capture] = await db
      .insert(captures)
      .values({ worldId: world.id, frameCount: body.frame_count })
      .returning();
    const prefix = `captures/${capture!.id}`;
    await db
      .update(captures)
      .set({ r2FramesPrefix: prefix })
      .where(eq(captures.id, capture!.id));

    // Presign one upload URL per frame, binding Content-Length for every frame
    // whose exact size the client declared (spec §10 R7).
    const uploads = await presignFrameUploads(storage, prefix, body.frame_count, sizes);

    return reply.code(201).send({
      world: serializeWorld(world),
      capture_id: capture!.id,
      uploads,
    });
  });

  // POST /v1/worlds/:id/uploads:refresh — re-issue presigned frame PUT URLs so a
  // client that lost its original (short-TTL) URLs mid-upload can resume without
  // creating a duplicate world. Same keys, content-type and per-frame ceiling as
  // create, so the client PUTs the remaining frames to the identical R2 objects.
  // Owner-checked; a world with no capture row (or no frame prefix) is 404.
  app.post<{ Params: { id: string } }>(
    '/v1/worlds/:id/uploads:refresh',
    async (req, reply) => {
      const userId = requireUserId(req, reply);
      if (!userId) return;

      // Optional per-frame size declaration, same contract as create (§10 R7).
      const parsedBody = refreshUploadsBody.safeParse(req.body ?? undefined);
      if (!parsedBody.success) {
        return reply
          .code(400)
          .send({ error: 'invalid_body', issues: parsedBody.error.issues });
      }

      const db = getDb();
      const world = await findOwnedWorld(db, req.params.id, userId);
      if (!world) return reply.code(404).send({ error: 'world_not_found' });

      // Latest capture row carries the frame-key prefix + count minted at create.
      const [capture] = await db
        .select()
        .from(captures)
        .where(eq(captures.worldId, world.id))
        .orderBy(desc(captures.createdAt))
        .limit(1);
      if (!capture || !capture.r2FramesPrefix) {
        return reply.code(404).send({ error: 'capture_not_found' });
      }

      const uploads = await presignFrameUploads(
        storage,
        capture.r2FramesPrefix,
        capture.frameCount,
        frameSizeMap(parsedBody.data?.frames),
      );
      return reply.send({
        world: serializeWorld(world),
        capture_id: capture.id,
        uploads,
      });
    },
  );

  // POST /v1/worlds/:id/frames:done — all frames uploaded → status `uploaded`.
  // `uploaded` is the Phase 1 terminal state: nothing is enqueued yet (the
  // processing pipeline and its states arrive in Phase 2), so job_id is null.
  // Optionally accepts { poses: [...] } (per-frame ARKit poses) which is stored
  // verbatim into captures.poses_json. No body / empty body = old behavior.
  app.post<{ Params: { id: string } }>(
    '/v1/worlds/:id/frames:done',
    { bodyLimit: FRAMES_DONE_BODY_LIMIT },
    async (req, reply) => {
      const userId = requireUserId(req, reply);
      if (!userId) return;

      // Validate BEFORE any DB write: an invalid poses shape 400s without
      // touching world status or enqueuing a job.
      const parsed = framesDoneBody.safeParse(req.body ?? undefined);
      if (!parsed.success) {
        return reply
          .code(400)
          .send({ error: 'invalid_body', issues: parsed.error.issues });
      }
      const poses = parsed.data?.poses;

      const db = getDb();
      const world = await findOwnedWorld(db, req.params.id, userId);
      if (!world) return reply.code(404).send({ error: 'world_not_found' });

      // Clients REPLAY frames:done when a response was lost. The flip is one
      // conditional UPDATE (uploading → uploaded) and the poses write shares
      // its transaction: a refused flip (replay) writes nothing.
      const flipped = await db.transaction(async (tx) => {
        const [row] = await tx
          .update(worlds)
          // Entering a new status → progress resets; updated_at is the heartbeat.
          .set({ status: 'uploaded', progress: null, updatedAt: new Date() })
          .where(
            and(
              eq(worlds.id, world.id),
              eq(worlds.status, 'uploading'),
              isNull(worlds.deletedAt),
            ),
          )
          .returning();
        if (!row) return null;

        // Store poses on the world's (latest) capture row when provided.
        if (poses && poses.length > 0) {
          const [capture] = await tx
            .select()
            .from(captures)
            .where(eq(captures.worldId, world.id))
            .orderBy(desc(captures.createdAt))
            .limit(1);
          if (capture) {
            await tx
              .update(captures)
              .set({ posesJson: poses })
              .where(eq(captures.id, capture.id));
          }
        }
        return row;
      });

      if (!flipped) {
        // Replay (or a world already past uploading): 200, not 409 — a 409
        // would make client recovery retry forever.
        const current = await findOwnedWorld(db, world.id, userId);
        return reply.send({ world: serializeWorld(current ?? world), job_id: null });
      }
      return reply.send({ world: serializeWorld(flipped), job_id: null });
    },
  );

  // GET /v1/worlds/:id — status/phase + signed asset URLs.
  app.get<{ Params: { id: string } }>('/v1/worlds/:id', async (req, reply) => {
    const userId = requireUserId(req, reply);
    if (!userId) return;
    const db = getDb();
    const world = await findOwnedWorld(db, req.params.id, userId);
    if (!world) return reply.code(404).send({ error: 'world_not_found' });

    const assets: Record<string, string> = {};
    for (const [field, out] of ASSET_FIELDS) {
      const key = world[field];
      if (key) assets[out] = await storage.presignDownload(key, DOWNLOAD_TTL_SECONDS);
    }
    return reply.send({ world: serializeWorld(world), assets });
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

interface UploadKind {
  name: (i: number) => string;
  contentType: string;
  maxBytes: number;
}

const FRAME_UPLOAD: UploadKind = {
  name: (i) => `frame_${i}.heic`,
  contentType: 'image/heic',
  maxBytes: MAX_FRAME_BYTES,
};

/**
 * Presign one PUT upload URL per frame under `prefix`. Shared by world create
 * and uploads:refresh so both mint byte-identical keys (`frame_<i>.heic`),
 * content-type and per-frame ceiling — the resume path must land on the exact
 * same R2 objects the original upload targeted.
 */
async function presignFrameUploads(
  storage: StorageDriver,
  prefix: string,
  frameCount: number,
  sizes: Map<number, number> = new Map(),
  kind: UploadKind = FRAME_UPLOAD,
): Promise<
  Array<{ index: number; key: string } & Awaited<ReturnType<StorageDriver['presignUpload']>>>
> {
  return Promise.all(
    Array.from({ length: frameCount }, async (_v, i) => {
      const key = `${prefix}/${kind.name(i)}`;
      const presigned = await storage.presignUpload(
        key,
        kind.contentType,
        kind.maxBytes,
        sizes.get(i),
      );
      return { index: i, key, ...presigned };
    }),
  );
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
async function findWorldByClientRequestId(
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
 * Idempotent replay of POST /v1/worlds (spec §10 R4): the ORIGINAL world, the
 * original capture id, and FRESH presigned upload URLs for the same keys (the
 * first batch has almost certainly expired — that is usually why the client is
 * retrying). Same body shape as a create, status 200 rather than 201 so the
 * replay is visible in logs; the iOS client accepts any 2xx.
 *
 * A soft-deleted world is a 409, not a new create: reusing the key would either
 * resurrect a world whose assets the purge job has destroyed or silently mint a
 * second billable world behind the same key. The client decides (new key, or
 * surface the deletion).
 */
async function replayCreate(
  reply: FastifyReply,
  db: ReturnType<typeof getDb>,
  storage: StorageDriver,
  world: World,
  sizes: Map<number, number>,
) {
  if (world.deletedAt) {
    return reply.code(409).send({
      error: 'idempotency_key_world_deleted',
      world_id: world.id,
    });
  }
  const [capture] = await db
    .select()
    .from(captures)
    .where(eq(captures.worldId, world.id))
    .orderBy(desc(captures.createdAt))
    .limit(1);
  if (!capture || !capture.r2FramesPrefix) {
    // The original create did not get as far as a usable capture row; there is
    // nothing to hand back that the client could upload to.
    return reply.code(409).send({
      error: 'idempotency_key_incomplete_world',
      world_id: world.id,
    });
  }
  const uploads = await presignFrameUploads(
    storage,
    capture.r2FramesPrefix,
    capture.frameCount,
    sizes,
  );
  return reply.code(200).send({
    world: serializeWorld(world),
    capture_id: capture.id,
    uploads,
    idempotent_replay: true,
  });
}

/**
 * The world `id` names a row this user owns, or nothing. A `:id` that is not a
 * uuid is "nothing" too (see isInvalidTextRepresentation) rather than a 500 —
 * every caller already answers `404 world_not_found` on undefined.
 */
async function findOwnedWorld(
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
