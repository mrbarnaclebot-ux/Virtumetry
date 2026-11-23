import {
  pgTable,
  uuid,
  text,
  integer,
  smallint,
  boolean,
  doublePrecision,
  timestamp,
  jsonb,
  index,
  uniqueIndex,
} from 'drizzle-orm/pg-core';

// Data model — spec §7. Asset columns store R2/storage *keys*; signed URLs are
// minted at read time. Timestamps are timestamptz; UUID PKs default to random.

// --- World status state machine (spec §7) -----------------------------------
// capturing → uploading → stitching → generating_draft → draft_ready
//   → (enhance) generating_hq → complete
// plus failed_<phase> variants that are retryable.
export const WORLD_STATUSES = [
  'capturing',
  'uploading',
  'stitching',
  'generating_draft',
  'draft_ready',
  'generating_hq',
  'complete',
  'failed_upload',
  'failed_stitch',
  'failed_generating_draft',
  'failed_generating_hq',
] as const;
export type WorldStatus = (typeof WORLD_STATUSES)[number];

// Job queue kinds + phases (spec §7 / §14).
export const JOB_KINDS = ['stitch', 'generate_draft', 'generate_hq', 'purge'] as const;
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
    status: text('status').notNull().default('capturing'),
    phase: text('phase'),
    // Within-status completion, 0–100. Written (throttled) by the worker while
    // stitching/generating; reset to NULL on every status transition so a
    // stale percentage never bleeds into the next phase.
    progress: smallint('progress'),

    // Asset columns — all point at OUR storage (never the provider CDN).
    panoUrl: text('pano_url'),
    thumbnailUrl: text('thumbnail_url'),
    spz100kUrl: text('spz_100k_url'),
    spz500kUrl: text('spz_500k_url'),
    spzFullUrl: text('spz_full_url'),
    colliderGlbUrl: text('collider_glb_url'),
    assetVersion: integer('asset_version').notNull().default(1),

    // Provider columns — draft-first means up to two provider worlds each.
    provider: text('provider'),
    draftWorldId: text('draft_world_id'),
    hqWorldId: text('hq_world_id'),
    draftModel: text('draft_model'),
    hqModel: text('hq_model'),
    creditsSpent: integer('credits_spent').notNull().default(0),

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
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  // Every hot path looks a capture up BY WORLD, newest first — the stitch and
  // purge handlers, uploads:refresh, frames:done and replayCreate all run
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
    // Persisted atomically around worlds:generate so a retry never blind-
    // resubmits a credit-spending call (spec §14).
    providerOperationId: text('provider_operation_id'),
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
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('credit_events_created_idx').on(t.createdAt)],
);

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
