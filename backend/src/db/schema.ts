import {
  pgTable,
  uuid,
  text,
  integer,
  smallint,
  boolean,
  bigint,
  doublePrecision,
  timestamp,
  jsonb,
  index,
  uniqueIndex,
} from 'drizzle-orm/pg-core';

// Data model — spec §7. Asset columns store R2/storage *keys*; signed URLs are
// minted at read time. Timestamps are timestamptz; UUID PKs default to random.

// --- World status state machine (D-15) --------------------------------------
// uploading → packing → submitting → processing → importing → ready, plus the
// terminal failed / cancelled. Where a failure happened lives in failure_stage.
export const WORLD_STATUSES = [
  'uploading',
  'packing',
  'submitting',
  'processing',
  'importing',
  'ready',
  'failed',
  'cancelled',
] as const;
export type WorldStatus = (typeof WORLD_STATUSES)[number];

// The pipeline step a `failed` world died in (D-15).
export const FAILURE_STAGES = ['upload', 'validate', 'pack', 'submit', 'processing', 'import'] as const;
export type FailureStage = (typeof FAILURE_STAGES)[number];

// Job queue kinds + phases (spec §7 / §14; D-16 pipeline kinds).
export const JOB_KINDS = ['pack', 'submit', 'track', 'purge'] as const;
export type JobKind = (typeof JOB_KINDS)[number];

// A job's phase tracks lifecycle within the queue: queued → running → done,
// or 'dead' once it exhausts retries (DLQ-equivalent, spec §14).
export const JOB_PHASES = ['queued', 'running', 'done', 'dead'] as const;
export type JobPhase = (typeof JOB_PHASES)[number];

export const users = pgTable('users', {
  id: uuid('id').primaryKey().defaultRandom(),
  // apple_sub holds the identity subject in both modes: Apple's `sub` in apple
  // mode, the x-dev-user id in dev mode. Unique so upserts are idempotent.
  appleSub: text('apple_sub').notNull().unique(),
  displayName: text('display_name'),
  // Cost-control quota (spec §7) — independent of monetization.
  dailyScanCount: integer('daily_scan_count').notNull().default(0),
  quotaResetAt: timestamp('quota_reset_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  deletedAt: timestamp('deleted_at', { withTimezone: true }),
});

export const worlds = pgTable(
  'worlds',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    ownerId: uuid('owner_id')
      .notNull()
      .references(() => users.id),
    title: text('title'),
    caption: text('caption'),
    // Client-supplied idempotency key (the capture session UUID, sent as the
    // `Idempotency-Key` header on POST /v1/worlds — spec §10 R4). Unique per
    // owner, so a retried create returns the SAME world instead of minting a
    // second billable one. NULL for clients that send no key (many NULLs are
    // allowed by a Postgres unique index).
    clientRequestId: text('client_request_id'),
    lat: doublePrecision('lat'),
    lng: doublePrecision('lng'),
    placeName: text('place_name'),
    isPublic: boolean('is_public').notNull().default(false),

    // Status state machine + optional finer-grained phase label for UI.
    status: text('status').notNull().default('uploading'),
    phase: text('phase'),
    // Within-status completion, 0–100. Written (throttled) by the worker while
    // processing; reset to NULL on every status transition so a
    // stale percentage never bleeds into the next phase.
    progress: smallint('progress'),

    // Asset keys — all point at OUR storage, never the provider CDN (D-15/D-19);
    // signed URLs are minted at read time.
    splatKey: text('splat_key'),
    colliderKey: text('collider_key'),
    floorplanKey: text('floorplan_key'),
    camerasKey: text('cameras_key'),
    thumbnailKey: text('thumbnail_key'),
    // Floorplan affine/meta from the provider, needed to draw it (D-15).
    floorplanMeta: jsonb('floorplan_meta'),
    assetVersion: integer('asset_version').notNull().default(1),

    provider: text('provider'),
    creditsSpent: integer('credits_spent').notNull().default(0),
    // Owner-approved ceiling and the provider quote it was checked against (D-18).
    approvedMaxCredits: integer('approved_max_credits'),
    quotedCredits: integer('quoted_credits'),
    // Idempotency key + exact body of the one paid submit, persisted BEFORE the
    // call so a retry resends identical bytes and never double-charges (D-17).
    submissionKey: uuid('submission_key'),
    submitBody: jsonb('submit_body'),
    // Provider request id, persisted before polling; webhooks look worlds up by it (D-17).
    providerRequestId: text('provider_request_id'),
    // Why a `failed` world failed (D-15).
    failureStage: text('failure_stage'),
    failureCode: text('failure_code'),
    failureMessage: text('failure_message'),
    // True once the provider has charged for this world (D-15).
    charged: boolean('charged').notNull().default(false),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    // Heartbeat: touched on every worker/route mutation of the row, surfaced to
    // clients as `heartbeat_at` so the UI can flag a stalled pipeline.
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
  },
  (t) => [
    index('worlds_owner_idx').on(t.ownerId),
    // The idempotency guarantee itself: the DB, not the request handler, is what
    // makes a concurrent double-create impossible (spec §10 R4).
    uniqueIndex('worlds_owner_client_request_idx').on(t.ownerId, t.clientRequestId),
    // One world per provider request (D-15).
    uniqueIndex('worlds_provider_request_idx').on(t.providerRequestId),
  ],
);

export const captures = pgTable(
  'captures',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    worldId: uuid('world_id')
      .notNull()
      .references(() => worlds.id),
    frameCount: integer('frame_count').notNull(),
    // Per-frame ARKit attitude/pose payload.
    posesJson: jsonb('poses_json'),
    r2FramesPrefix: text('r2_frames_prefix'),
    // session.json key and the packed Echo-3 bundle (D-15, D-07).
    manifestKey: text('manifest_key'),
    bundleKey: text('bundle_key'),
    bundleBytes: bigint('bundle_bytes', { mode: 'number' }),
    // Frame resolution from session.json, checked at pack time (D-15, D-06).
    imageW: integer('image_w'),
    imageH: integer('image_h'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  // Every hot path looks a capture up BY WORLD, newest first — the purge
  // handler, uploads:refresh, frames:done and replayCreate all run
  // `where world_id = $1 order by created_at desc limit 1`. Postgres does not
  // index a foreign key automatically, so each of those was a sequential scan.
  (t) => [index('captures_world_created_idx').on(t.worldId, t.createdAt)],
);

export const jobs = pgTable(
  'jobs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    worldId: uuid('world_id')
      .notNull()
      .references(() => worlds.id),
    kind: text('kind').notNull(),
    phase: text('phase').notNull().default('queued'),
    attempts: integer('attempts').notNull().default(0),
    lastError: text('last_error'),
    payload: jsonb('payload'),
    // Backoff gate — a job is claimable only once run_after <= now.
    runAfter: timestamp('run_after', { withTimezone: true }).notNull().defaultNow(),
    // SKIP LOCKED lease columns.
    lockedAt: timestamp('locked_at', { withTimezone: true }),
    lockedBy: text('locked_by'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('jobs_claim_idx').on(t.kind, t.phase, t.runAfter)],
);

export const devices = pgTable(
  'devices',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id),
    apnsToken: text('apns_token').notNull().unique(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('devices_user_idx').on(t.userId)],
);

// Append-only ledger of credit spends (spec §14 credit safety). The daily
// budget guard (src/budget.ts) sums today's `amount` inside a transaction and
// only inserts a new event if the cap would not be exceeded — atomic reserve.
export const creditEvents = pgTable(
  'credit_events',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    amount: integer('amount').notNull(),
    worldId: uuid('world_id').references(() => worlds.id),
    // One reserve and at most one release per paid submission (D-18). NULL on
    // pre-Phase-2 rows; Postgres unique indexes allow many NULLs.
    submissionKey: uuid('submission_key'),
    kind: text('kind').notNull().default('reserve'),
    // mock vs live, so mock runs never count against the real budget (D-18).
    providerMode: text('provider_mode').notNull().default('mock'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('credit_events_created_idx').on(t.createdAt),
    uniqueIndex('credit_events_submission_kind_idx').on(t.submissionKey, t.kind),
  ],
);

// Webhook dedupe (D-15, PROC-06): the delivery id is the primary key, so a redelivered
// webhook is a no-op insert conflict.
export const webhookDeliveries = pgTable('webhook_deliveries', {
  deliveryId: text('delivery_id').primaryKey(),
  requestId: text('request_id').notNull(),
  event: text('event'),
  receivedAt: timestamp('received_at', { withTimezone: true }).notNull().defaultNow(),
});

export const shareSlugs = pgTable('share_slugs', {
  id: uuid('id').primaryKey().defaultRandom(),
  worldId: uuid('world_id')
    .notNull()
    .references(() => worlds.id),
  slug: text('slug').notNull().unique(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  revokedAt: timestamp('revoked_at', { withTimezone: true }),
});

export type User = typeof users.$inferSelect;
export type World = typeof worlds.$inferSelect;
export type Job = typeof jobs.$inferSelect;
export type Device = typeof devices.$inferSelect;
export type Capture = typeof captures.$inferSelect;
export type CreditEvent = typeof creditEvents.$inferSelect;
export type WebhookDelivery = typeof webhookDeliveries.$inferSelect;
