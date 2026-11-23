# VirtSpace Backend

Fastify API + Postgres-backed job queue for VirtSpace (spec §3.2, §7, §14).
**Stage 1** is the API + schema + storage + credit-safe queue; **Stage 2** (this
build) adds the **worker loop**, the **World Labs provider** (live + mock), the
**daily credit budget guard**, and the **APNs push stub**. No external API / DB
calls happen at import or boot.

## Stack (locked — spec §3.2)

- **TypeScript** (strict, NodeNext), Node 24, ESM.
- **Fastify 5** + **zod** — HTTP + validation.
- **Drizzle ORM** over Postgres via the `pg` driver; migrations via **drizzle-kit**.
- **Vitest** — tests.
- Storage behind an **S3-compatible driver** interface: local disk for dev,
  Cloudflare R2 / S3 in production.

## Setup

Run every npm command from inside `backend/` — it holds the only lockfile, the
same one the Docker image installs from (there is no root workspace).

```bash
cd backend
npm ci
cp .env.example .env      # fill in DATABASE_URL + DEV_AUTH_TOKEN at minimum
npm run db:generate       # (already committed) generate SQL from the schema
npm run db:migrate        # apply migrations to the DB in DATABASE_URL
npm run dev               # tsx watch + dotenv → http://localhost:8080/healthz
```

`npm run dev` loads `.env` via `--import dotenv/config`. The committed
`.env.example` documents every variable.

## Scripts

| Script | What it does |
|---|---|
| `dev` | `tsx watch` the server, loading `.env` via dotenv |
| `worker` | run the Stage-2 worker loop (`tsx src/worker.ts`), loading `.env` |
| `build` | `tsc` → `dist/` |
| `start` | run the compiled `dist/server.js` |
| `typecheck` | `tsc --noEmit` |
| `test` | `vitest run` (no DB required — pure/smoke tests) |
| `db:generate` | drizzle-kit: SQL migration from `src/db/schema.ts` (no DB) |
| `db:migrate` | drizzle-kit: apply migrations, **dev only** (needs devDependencies) |
| `db:migrate:prod` | `node dist/migrate.js` — drizzle-orm migrator, advisory-locked; the release step |

## Architecture map

```
src/
  config.ts          zod-validated env loader (loadConfig / getConfig, memoized)
  server.ts          buildServer() + main(); lazy DB, boots without Postgres
  auth.ts            dev-token + Sign in with Apple (jose/JWKS) preHandler
  queue.ts           enqueue / claimNextJob (SKIP LOCKED + lease expiry) / complete / fail / parkDead
  quota.ts           pure daily-scan-quota logic (evaluateQuota)
  budget.ts          daily credit budget guard (reserveCredits, BudgetExceededError)
  worker.ts          Stage-2 loop: claims stitch/generate/purge jobs; credit-safe generation
  push.ts            APNs sendPush STUB (logs in dev; real APNs is a later phase)
  provider/
    types.ts         WorldGenProvider interface + WorldModel/credits + typed errors
    worldlabs.ts     LIVE World Labs Marble client (ported from tools/spike/spike.py)
    mock.ts          offline zero-credit provider (PROVIDER_MODE=mock)
    index.ts         createProvider(config) factory (mock | live)
  db/
    schema.ts        Drizzle tables — users, worlds, captures, jobs, devices, credit_events, share_slugs
    client.ts        LAZY pg Pool + drizzle db (created on first query, not at boot)
    users.ts         upsertUserBySub (idempotent identity upsert)
  storage/
    index.ts         StorageDriver interface + createStorage(config) factory
    local.ts         disk driver + dev-only /dev-storage/* Fastify routes
    s3.ts            @aws-sdk/client-s3 + presigner, endpoint-configurable (R2)
  routes/
    index.ts         registers health (open) + authed scope (worlds/devices/account)
    health.ts        GET /healthz — no auth, no DB
    worlds.ts        POST/GET/DELETE /v1/worlds*, frames:done, enhance
    devices.ts       POST /v1/devices
    account.ts       DELETE /v1/account
drizzle/             generated SQL migrations + meta
test/                vitest: config, storage, auth, quota/backoff
```

### API surface (spec §7.1)

- `GET  /healthz` — liveness, no auth, no DB.
- `POST /v1/worlds` — create world (`status=uploading`) + capture; returns N
  presigned frame upload URLs (`captures/{captureId}/frame_{i}.heic`). Enforces
  the daily scan quota with a single conditional `UPDATE … RETURNING`
  (`chargeScanQuota`) — the check and the increment are one statement, so
  concurrent creates cannot both pass at the limit (spec §10 R9); a refusal is
  `429 {"error":"scan_quota_exceeded","message":…,"retry_at":…}`. Optional
  `frames: [{ index, bytes }]` declares each frame's exact size (see
  [Upload size caps](#upload-size-caps-spec-10-r7)).
- `POST /v1/worlds/:id/frames:done` — verify ownership, set `status=stitching`,
  enqueue a `stitch` job. Optionally accepts
  `{ poses: [{ index, timestamp, transform[16], intrinsics[9], exposureLocked }] }`
  (max 64 per-frame ARKit poses), stored verbatim into `captures.poses_json`.
  No/empty body keeps the old behavior; an invalid shape 400s before any state
  change (no status update, no job).
- `GET  /v1/worlds/:id` — status/phase + signed download URLs for any asset
  columns that are set.
- `GET  /v1/worlds` — owner's library, paginated (`limit`/`offset`), excludes
  soft-deleted. Each item carries `assets` with ONLY a presigned
  `thumbnail_url` (when set) for the iOS Library grid — heavy asset URLs are
  signed exclusively by the detail route. Response:
  `{ worlds: [{ ...world, assets: { thumbnail_url? } }], has_more, next_offset }`.
- `POST /v1/worlds/{id}:enhance` — **canonical** (spec §7.1, literal colon; this
  is the path the iOS client calls). Enqueues `generate_hq` if
  `status=draft_ready`, else `409 not_enhanceable` with the current status. The
  `draft_ready → generating_hq` flip and the check are ONE conditional
  `UPDATE … WHERE status='draft_ready' … RETURNING`, and the job is enqueued only
  when that row was actually flipped — a double-tap or a client retry gets the
  409 and cannot buy a second `marble-1.1` generation (1500 credits). Carries the
  `RATE_LIMIT_CREATE_MAX` bucket under its own `enhance:<user>` key (see
  [Rate limiting](#rate-limiting-spec-10-r10)). `POST /v1/worlds/:id/enhance`
  (slash) is kept as a **legacy alias** on the same handler.
  - Route string: `'/v1/worlds/:id(^[^:]+)::enhance'`. find-my-way's `::` escape
    for a literal colon only works in a *static* segment — written straight after
    a param, `'/v1/worlds/:id::enhance'` parses the param NAME as `id::enhance`,
    so `req.params.id` is `undefined`. The regex constraint terminates the param
    name and makes `::enhance` the static suffix it looks like. Verified by
    `test/worlds.enhance.test.ts`, which also covers the percent-encoded
    `…%3Aenhance` spelling (find-my-way decodes the parametric segment first).
  - A `:id` that is not a uuid (e.g. `GET /v1/worlds/<uuid>:enhance`, which the
    router hands to `GET /v1/worlds/:id` as a garbage id) answers
    `404 world_not_found` — Postgres' `22P02` on the uuid cast is caught in
    `findOwnedWorld` instead of escaping as a `500`.
  - Refuses up front with `429 credit_budget_exceeded` when one HQ cannot fit
    today's `DAILY_CREDIT_BUDGET` (advisory `budgetFits`; the worker's
    `reserveCredits` stays the guard).
- `POST /v1/worlds/{id}:retry` — re-run a failed phase (`failed_stitch`,
  `failed_generating_draft`, `failed_generating_hq`) in one conditional
  transaction; route string `'/v1/worlds/:id(^[^:]+)::retry'`, own `retry:<user>`
  rate-limit key. Full contract in spec §7.1.
- `DELETE /v1/worlds/:id` — soft delete + enqueue `purge`.
- `POST /v1/devices` — upsert an APNs token.
- `DELETE /v1/account` — soft-delete the user's worlds (+ enqueue purges), delete
  devices, mark the user deleted. **After deletion every authenticated request
  from that identity is `403 {"error":"account_deleted"}`** — see below.

### Idempotent world creation (spec §10 R4)

`POST /v1/worlds` accepts an optional **`Idempotency-Key: <UUID>`** header — the
client's capture-session UUID. Without it the endpoint behaves exactly as before.

| Case | Result |
|---|---|
| First request with a key | `201` — world created, key stored in `worlds.client_request_id`, quota charged once |
| Repeat with the same key | `200` — the **same** world + capture id, **fresh** presigned upload URLs for the same keys, `idempotent_replay: true`. No second row, no second quota charge |
| Key present but not a UUID | `400 invalid_idempotency_key` (before any quota charge) |
| Key maps to a **soft-deleted** world | `409 idempotency_key_world_deleted` (+ `world_id`) — the client decides: new key, or surface the deletion. Reusing it would resurrect a purged world or hide a second billable one behind the same key |
| Key maps to a world with no usable capture row | `409 idempotency_key_incomplete_world` |
| Two concurrent requests, same key | The `worlds_owner_client_request_idx` unique index decides; the loser refunds its scan (`releaseScanQuota`) and replays the winner's world (`200`) |

Uniqueness is enforced by the database — `UNIQUE (owner_id, client_request_id)`,
migration `drizzle/0003_heavy_maddog.sql` — not by a check in the handler, so the
concurrent case cannot slip through. Many NULLs are allowed, so keyless creates
are unaffected.

### Upload size caps (spec §10 R7)

`s3.presignUpload` used to take a `_maxBytes` argument and ignore it, so a
presigned frame URL accepted an object of any size. Enforcement is now layered:

1. **Request validation** — `POST /v1/worlds` and `POST /v1/worlds/:id/uploads:refresh`
   accept an optional `frames: [{ index, bytes }]` array. Any `bytes` above the
   12 MB `MAX_FRAME_BYTES` ceiling is rejected with `400 invalid_body`.
2. **Signed Content-Length** — for every frame whose exact size was declared, the
   S3/R2 driver signs `ContentLength` into the presigned URL (`signableHeaders`
   includes `content-length`) and returns a `content-length` response header
   beside `content-type`; the object store then rejects a payload of any other
   length. SigV4 can bind only an *exact* length, never a ceiling, which is why
   the declaration is needed. The local dev driver mirrors this by tightening its
   per-key PUT limit. Undeclared frames sign exactly as before.
3. **Worker-side guard (always on)** — `handleStitch` HEADs every frame
   (`storage.objectSize`) before reading it and fails **non-retryably** if it is
   over the cap or unsizeable, so an oversized object is never pulled into worker
   memory even when the client declared nothing.

The `frames` field is optional, so the shipped iOS client keeps working
unchanged; layer 3 is the guarantee.

### Account deletion semantics (spec §13 / §10 R3)

- **Deleted stays deleted.** `users.deleted_at` is read by the auth preHandler in
  **both** modes: a deleted user is rejected with `403 account_deleted` instead of
  being re-upserted and served. Re-signing in with the *same* Apple `sub` does
  **not** resurrect the account and does **not** mint a second row (`apple_sub` is
  UNIQUE, and the purge job has already destroyed that user's worlds and frames —
  a revived row would point at deleted data). A genuinely new user has a new
  Apple `sub` and gets a fresh row as usual. Re-admitting a previously deleted
  `sub` would need an explicit product decision (e.g. rewriting the old row's
  `apple_sub` to a tombstone value on delete); it is deliberately not done here.
- **Purge nulls `captures.poses_json`.** The per-frame ARKit poses are personal
  motion data whose only consumer is the stitcher; the purge job now clears them
  alongside the frame objects (including on the reaper's frames-only purge).

## Auth

- **dev** (`AUTH_MODE=dev`): send `Authorization: Bearer <DEV_AUTH_TOKEN>` **and**
  `x-dev-user: <email-ish id>`. The id upserts a user and is attached as
  `request.userId`. Header validation is a pure function (`parseDevAuth`) so
  rejection never touches the DB. The token is compared with
  `crypto.timingSafeEqual` over SHA-256 digests (`secretEquals`) — constant-time
  **and** length-safe, so neither the token's bytes nor its length leak through
  response timing.
- **apple** (`AUTH_MODE=apple`): the `Authorization: Bearer` value is a Sign in
  with Apple identity token, verified with `jose` against Apple's JWKS
  (`https://appleid.apple.com/auth/keys`), issuer `https://appleid.apple.com`,
  audience `APPLE_BUNDLE_ID`. The `sub` upserts a user.

### `ALLOW_DEV_AUTH` — dev auth in production (spec §10 R2)

`AUTH_MODE` **defaults to `dev`**, so a dropped or mistyped env var used to hand
production traffic a shared-token auth mode silently. The config loader now
**refuses to boot** when `NODE_ENV=production` and `AUTH_MODE=dev`, unless
`ALLOW_DEV_AUTH=1` is set — the value must be exactly `1`.

> ⚠️ **Deploy prerequisite.** Production currently runs dev auth on purpose (the
> iOS build authenticates with `DEV_AUTH_TOKEN`; there is no paid Apple account
> yet). `ALLOW_DEV_AUTH=1` **must be set on Railway before this change deploys**,
> or both the API and the worker will exit at boot. Drop the variable the moment
> `AUTH_MODE=apple` goes live.

## Migrations

Drizzle-kit is schema-first: edit `src/db/schema.ts`, then `npm run db:generate`
writes a timestamped SQL file + snapshot into `drizzle/`. `generate` needs **no**
database connection. `npm run db:migrate` applies pending files to
`DATABASE_URL`. Committed migrations: `0000_*.sql` (initial schema), `0001_*.sql` (the
`credit_events` ledger for the Stage-2 budget guard), `0002_*.sql` (pipeline
progress + heartbeat columns), `0003_heavy_maddog.sql`
(`worlds.client_request_id` + its per-owner unique index — idempotent create,
spec §10 R4) and `0004_moaning_silvermane.sql` (a `(world_id, created_at)` index
on `captures`).

### Applying migrations in production (spec §10 R10)

`drizzle-kit` is a **devDependency** and the image prunes dev deps, so
`db:migrate` does not exist in the deployed container. Migrations used to be
applied by hand, which let code ship ahead of its schema.

`src/migrate.ts` (built to `dist/migrate.js`, `npm run db:migrate:prod`) runs the
same committed SQL through **drizzle-orm's own migrator** — no CLI, no dev
toolchain. The Dockerfile now `COPY`s `backend/drizzle` into the image so the
files are actually there.

It holds a **Postgres advisory lock** for the whole run, on a dedicated
`pg.Client` (the lock is session-scoped, so a pooled connection could hand the
lock and the DDL to different backends). A concurrent runner blocks, then finds
nothing pending.

It is deliberately **not** run at server/worker boot: both services can scale
past one replica and both would race the same DDL on every deploy. It is a
release step.

**Railway setup — do this once, on the `api` service only:**

> Settings → Deploy → **Pre-deploy Command**: `node dist/migrate.js`

Leave the `worker` service's pre-deploy command empty, or both services race
each other on every deploy. A failed migration exits non-zero and aborts the
rollout, which is the point.

> ⚠️ **`0003_heavy_maddog.sql` is still pending in production.** It adds
> `worlds.client_request_id` and its per-owner unique index — the columns the
> shipped idempotent-create path (spec §10 R4) reads. Set the pre-deploy command
> **before** the next deploy so it lands.

## Rate limiting (spec §10 R10)

`@fastify/rate-limit`, registered globally at the **preHandler** stage. The auth
hook is an `onRequest` hook precisely so `req.userId` exists by the time the
limiter picks a key — Fastify runs every `onRequest` hook before any
`preHandler`, so the ordering holds without depending on registration order.

| Bucket | Key | Default | Env |
|---|---|---|---|
| General | `user:<id>` when authenticated | 300 / min | `RATE_LIMIT_MAX` |
| General (anonymous) | `ip:<addr>` | 600 / min | `RATE_LIMIT_IP_MAX` |
| `POST /v1/worlds` | `create:<user>` | 12 / min | `RATE_LIMIT_CREATE_MAX` |
| `POST /v1/worlds/{id}:enhance` (+ slash alias) | `enhance:<user>` | 12 / min | `RATE_LIMIT_CREATE_MAX` |
| `POST /v1/worlds/{id}:retry` | `retry:<user>` | 12 / min | `RATE_LIMIT_CREATE_MAX` |
| Failed authentications | `<ip>` | 20 / min | `AUTH_FAIL_MAX` |

Window: `RATE_LIMIT_WINDOW_MS` (default `60000`).

**Why per user, not per IP.** A corporate NAT or carrier egress is legitimately
many devices; keying the general bucket on the IP would let one heavy user
exhaust everyone else's budget. Anonymous traffic has no better key, so it falls
back to the IP with a looser cap.

**The iOS Library poll is safe.** It calls `GET /v1/worlds` every 3 s — 20
requests per 60 s window, against a 300 budget. ~15× headroom, and a test pins
that relationship so a future tightening cannot silently break the app.

**`POST /v1/worlds` is deliberately tiny.** Every accepted call can become a
billable generation and `DAILY_SCAN_QUOTA` is 10/day, so a minute's worth of
creates is small by definition. Quota is the correctness guard; this is the cost
guard sitting in front of it, refusing a runaway client before it reaches the
credit ledger at all.

**Enhance shares that cap but not that key.** One accepted enhance is a
`marble-1.1` generation — 1500 credits, ~10× a draft — which makes it the most
expensive single call in the API, so it belongs in the tight bucket rather than
the 300/min general one. It gets a *separate* `enhance:<user>` key because create
and enhance are different user actions: coupling them would make an enhance fail
because of unrelated capture activity. The real correctness guards behind both
remain `DAILY_CREDIT_BUDGET` (§14) and, for enhance specifically, the atomic
`draft_ready → generating_hq` flip that makes a second submit a 409.

**Failed auth gets its own counter** (`src/throttle.ts`), not a share of the
general bucket: it counts only requests that *failed* authentication, which is
what distinguishes a credential guesser from a busy client. Auth failures never
reach the plugin anyway — the auth hook short-circuits first. A successful auth
clears the IP's history.

> **Single replica assumption.** Both the plugin's store and the failed-auth
> counter are **in-memory and per-process**. That is correct for today's
> single-replica api service and avoids a Redis dependency bought for nothing.
> **Scaling the api past one replica requires moving both to a shared store** —
> otherwise each replica enforces its own copy of every limit.

## Graceful shutdown (spec §10 R10)

Both services handle `SIGTERM`/`SIGINT`, bounded by `SHUTDOWN_GRACE_MS`
(default `20000`). Keep it **below** the platform's own SIGTERM→SIGKILL window.

- **API** — `app.close()` (stop accepting, finish in-flight requests), *then*
  the `pg` pool. That order matters: closing the pool first turns a request
  that was about to succeed into a 500. A hard timer exits `1` if the drain
  wedges, because a deploy that hangs forever is worse than a dropped straggler.
- **Worker** — stops *claiming* immediately and lets the in-flight job run to
  completion, exiting early once it finishes.

The worker deliberately does **not** try to outlive `SIGKILL`. Railway's grace
period is tens of seconds and a draft generation runs minutes, so a redeploy
*will* interrupt live generations. That is safe by design rather than by luck:
the provider operation id is persisted **before** the billable call (§10 R1) and
the job lease expires so another worker re-claims and resumes it (§10 R6) — it
never re-generates and never double-bills. The grace window exists for the cheap
tail (a stitch about to upload, a finalize about to commit), not the long poll.

## Dev storage (`STORAGE_DRIVER=local`)

The local driver mimics presigned object storage without any cloud dependency:

- `presignUpload(key)` returns a plain `http://<PUBLIC_BASE_URL>/dev-storage/<key>`
  URL with method `PUT`; the client `PUT`s the bytes there.
- `presignDownload(key)` returns the same URL for `GET`.
- The `/dev-storage/*` routes (registered **only** when the driver is local) write
  to / read from `LOCAL_STORAGE_DIR`. Keys are path-traversal-checked.

Swap to `STORAGE_DRIVER=s3` for real presigned R2/S3 URLs — the route is not
registered and the driver signs URLs directly against the bucket. The rest of the
app only ever calls the `StorageDriver` interface, so nothing else changes.

## Job queue (spec §14)

`queue.ts` implements a Postgres-backed queue:

- `enqueue(kind, worldId, payload?)` inserts a `jobs` row.
- `claimNextJob(kinds, workerId)` uses
  `UPDATE ... WHERE id = (SELECT ... FOR UPDATE SKIP LOCKED) RETURNING`, takes a
  lease (`locked_at`/`locked_by`) and increments `attempts`.
- **Lease expiry (`LEASE_SECONDS = 600`)** — a job is claimable when it is
  unlocked **OR** its lease is older than 10 minutes. This fixes a QA defect: a
  worker that crashes mid-job previously left `locked_at` set forever, stranding
  the job. `isJobClaimable()` is the pure mirror of that WHERE clause (tested).
- `failJob` sets `run_after = now + min(2^attempts · 30s, 1h)` and parks the job
  as `phase='dead'` after 5 attempts (DLQ-equivalent).
- `parkJobDead` parks a job dead **immediately**, bypassing retry — used for
  non-retryable failures (budget exceeded, un-implemented stitch).
- **`heartbeatJob(db, jobId, workerId?)` (spec §10 R6)** — a conditional
  `UPDATE … RETURNING` that refreshes `locked_at` only while the job is still
  `running` **and** still leased to `workerId`. The lease (600 s) is shorter than
  a generation's in-process ceiling (900 s), so long phases call it from the
  generate poll tick and from the stitcher's progress stream. `false` means this
  worker **lost** the job: it throws `LeaseLostError`, abandons the phase without
  finalizing, and `handleJobError` deliberately leaves the job row alone (failing
  or parking it would clobber the new owner's lease). A heartbeat that *errors*
  (DB blip) is treated as "still held" — a transient error is not proof of loss.
- **Idempotent finalizes** — the stitch transition only applies while the world
  is still pre-generation (so a re-run cannot enqueue a second, billable
  `generate_draft`), and the generation finalize is conditional on
  `draft_world_id`/`hq_world_id` not already holding *this* provider world id, so
  `credits_spent` and the APNs push can never double-apply on a replay.
- `setProviderOperationId` persists the provider op id atomically so a resumed
  worker never blind-resubmits a credit-spending `worlds:generate` call.

## Worker (Stage 2) — `npm run worker`

A long-running loop (`workerId = hostname:pid`) that claims jobs of kinds
`stitch | generate_draft | generate_hq | purge` every `WORKER_POLL_MS` (default
2000). Handlers:

- **stitch** — **1** frame is a passthrough (copied verbatim to
  `worlds/{id}/pano.jpg`, the test-scan path; no transcode). **>1** frame runs
  the production reprojection stitcher (see [Stitcher](#stitcher-spec-5--phase-05)
  below): frames + poses are staged to a temp dir, `reproject.py` builds the
  equirect pano, and it's uploaded before `status=generating_draft` +
  `generate_draft` enqueue. A stitcher failure fails the job **retryable**.
- **generate_draft / generate_hq** — the credit-safe money path (see below);
  `marble-1.0-draft` (150 credits) → `draft_ready`, `marble-1.1` (1500 credits)
  → `complete`. Fires the APNs push stub on success.
- **purge** — deletes storage objects under the world prefix + captures' frame
  prefixes; **keeps** the DB row (soft-deleted).

Boot is crash-safe: the DB pool is lazy, so with a dummy `DATABASE_URL` the
worker starts, logs claim errors, and idles instead of exiting.

### Stitcher (spec §5 / Phase 0.5)

Multi-frame captures are stitched into a 4096×2048 equirectangular pano
(capture v2, spec §5.2; Marble works at 2560×1280) by `stitcher/reproject.py`,
spawned as a subprocess by the worker's `stitch` handler. Stages live in small
modules beside it (`geom.py`, `poses.py`, `warp.py`, `depth.py`, `fill.py`, …).

**Pipeline (poses provided).** Each frame is decoded once and `INTER_AREA`
prefiltered to ~1.3× the pano's angular density (anti-aliasing). The pano is
centred on the **centroid of camera positions** and reprojected
**translation-aware**: each pano ray is placed at a depth and sampled by every
camera through its full pose. Depth per frame, in priority order: LiDAR depth
maps from `--depth-dir` (forward-projected into one pano-space depth, nearest
surface wins) → `featureDepthMedian` → `--proxy-depth` (default 2.0 m, chosen on
the 2026-09-17 capture). Then per-frame gain compensation over overlaps (seeded
by `iso × exposureDuration` when every pose has both), graph-cut seam selection
(`cv2.detail`, colour-gradient cost, at 1024 wide), a banded multi-band blend
that wraps at ±180°, and a nadir cap mask (`--nadir-cap-deg`, default 20°; the
user's body) refilled from the surrounding floor in a top-down view.

**Poses absent** — rotation-only fallback on the nominal guided-capture angles,
exactly as the Phase 0.5 spike (R17 orientation tests still cover it).

Benchmark on the 28-frame 2026-09-17 capture at 4096 (`stitcher/bench.py`):
overlap error 11.43 → 9.06, edge-doubling score 0.076 → 0.048, 4.8 s,
~1 GB peak RSS (macOS high-water mark). At 8192: 12.8 s, 1.43 GB.

**Coordinate reconciliation.** Equirect world and ARKit world are both
right-handed, +Y up (gravity), so the horizon stays level. The ARKit camera is
right-handed (+X right, +Y up, optical axis **−Z**); after the 90° CW upright
rotation the fixed rebasing `X_proj=+Y_ak, Y_proj=−X_ak, Z_proj=−Z_ak` maps it
into the left-handed pinhole the reprojection equations use (forward **+Z**).

**Memory (spec §10 R8).** The equirect is filled in **horizontal row bands**
rather than at sphere resolution; `--width` is capped at **8192**.
`test/stitcher.banding.test.ts` proves banded output equals a whole-pano run of
the same code.

**CLI** (deterministic; progress on stdout; stderr + an EXIT CODE on failure):

```bash
python3 stitcher/reproject.py \
  --frames-dir DIR --out pano.jpg \
  [--poses poses.json] [--width 4096] [--preview-out pano_preview.jpg] \
  [--depth-dir DIR] [--proxy-depth M] [--nadir-cap-deg D] [--band-rows N]
```

**Exit codes** — the worker classifies retryability from the code, never by
matching message text:

| Code | Meaning | Worker policy |
|---|---|---|
| `0` | success | — |
| `1` | internal/transient (failed write, unexpected exception) | retry with backoff |
| `2` | **input error** — undecodable or genuinely-HEIF frames, no usable frames, bad args | **park dead immediately** |
| `137` | `128 + SIGKILL` — OOM-killed (or timed out) | retry once, then park (`STITCH_RESOURCE_MAX_ATTEMPTS = 2`) |

**Worker integration.** For `frame_count > 1` the handler downloads every
`frame_i.heic` to a temp dir (as `frame_i.jpg`), writes `poses.json` when the
capture carries poses, spawns `PYTHON_BIN` with a `STITCHER_TIMEOUT_MS` ceiling,
and on success uploads `pano.jpg` (+ optional `pano_preview.jpg`). The temp dir
is always cleaned. Config: `STITCHER_TIMEOUT_MS` (300000), `STITCHER_WIDTH`
(4096, spec §10 R40), `PYTHON_BIN` (`python3`).

**About the `.heic` frame keys.** Frames are presigned, stored and downloaded as
`frame_<i>.heic` with an `image/heic` content-type, but **the bytes the iOS app
uploads are JPEG**. The key and content-type are a client contract we
deliberately do *not* rename (renaming them would break shipped clients), so the
extension carries no information and staging the bytes as `frame_<i>.jpg` is
correct, not a workaround. Earlier revisions of this README described this as a
"missing HEIC→JPEG transcode"; that was wrong — there is nothing to transcode on
the current client.

What *was* missing is a clear failure when a frame really is HEIF. The stitcher
now sniffs the container by **magic bytes** (`ftyp` brand) whenever a decode
fails and exits with the input-error code and a message naming the format, so a
genuinely-HEIC capture parks the job immediately instead of burning five
retries. `pillow-heif` was deliberately **not** added: it drags libheif/HEVC into
the image to decode a format no shipped client produces. If a client ever does
send HEIF, adding the decoder is a contained follow-up — the detection and the
error path are already there.

**Docker.** The single `Dockerfile` (both services, selected by `SERVICE_ENTRY`)
installs Python 3 + `stitcher/requirements.txt` (numpy, opencv-python-headless)
into a venv on `PATH` alongside the Node build, so the worker's `python3`
resolves to the bundled interpreter.

> **Wheel availability is load-bearing.** The base image is `node:24-trixie-slim`
> (Debian trixie), whose `python3` is **3.13**. `opencv-python-headless` did not
> publish a cp313 wheel until **4.13.0.92** — pin anything older and pip falls
> back to building OpenCV from source, which fails the image build. Check for a
> cp313 manylinux wheel before changing either pin.

**Local dev.** Create a venv and install the stitcher deps:

```bash
python3 -m venv .venv && source .venv/bin/activate
pip install -r stitcher/requirements.txt
# then run the worker with PYTHON_BIN pointing at this interpreter:
PYTHON_BIN="$(pwd)/.venv/bin/python" npm run worker
```

The Python smoke test (`test/stitcher.smoke.test.ts`) `skipIf`s when `python3`
lacks the deps; point it at a venv with `STITCHER_TEST_PYTHON=/path/to/python`.

### Credit safety (spec §14) — the money-touching path

`worlds:generate` is the only step that spends credits, and it runs **at most
once** per job. `jobs.provider_operation_id` drives three entry states:

1. **A real operation id** → the worker **resumes at polling**: no reserve, no
   upload, no second `generateWorld`, no re-bill.
2. **A `pending:<jobId>` intent marker** → a previous attempt died *inside* the
   generate window, so whether credits were spent is unknown. The worker
   **reconciles**: `provider.findWorldByDisplayName(displayName)` looks the job
   up by its deterministic, job-unique `display_name`
   (`VirtSpace world <worldId> [job:<jobId>]`, see `generationDisplayName`).
   - match with an operation id → adopt it, replace the marker, keep polling;
   - match that is a finished world → adopt the world and re-host its assets;
   - match still generating → retryable, reconcile again next attempt;
   - **no match** → the job is **parked dead**. A listing can lag a
     just-accepted generation, so "not listed" does not prove nothing was
     billed, and an unprovable state is never resolved by re-submitting.
   - a lookup *error* is retryable and likewise never re-generates.
3. **Null** → a fresh generation: (a) persist the `pending:<jobId>` marker,
   (b) `reserveCredits(cost)` against the **daily budget**, (c) upload the pano,
   (d) call `generateWorld`, (e) persist the real operation id. The marker lands
   **before** the reservation, so no *process death* in the window can reserve
   twice or generate twice. A failure or timeout **of the generate call itself**
   is **non-retryable** (`NonRetryableJobError` → parked dead): the provider may
   have accepted it. Poll-phase timeouts stay retryable — they resume by id.

   **Pre-generate failures unwind.** A *thrown* error from (b), (c) or (d)'s
   upload — the pano PUT is an ordinary network call and the likeliest failure in
   the path — proves no generation was submitted. Those release the reservation
   (`releaseCredits`) and clear the marker (`clearProviderOperationId`,
   conditional on it still being this job's), then rethrow the **original** error
   with its **original retryability**, so a transient 5xx retries normally instead
   of parking the job for an operator. `BudgetExceededError` still parks. If the
   unwind itself fails, the marker stays — the retry then reconciles and at worst
   parks, which is the safe direction. Only a process death inside the window, or
   a throw from `generateWorld`, leaves a marker behind on purpose.

   A released reservation is a **compensating `-amount` entry** in
   `credit_events`, not a deletion: the ledger is append-only and the guard is a
   daily SUM, so both halves stay visible and the day's total comes out right.
   Reservations are deliberately **not** made idempotent per job — a job retried
   on a later day must be re-checked against *that* day's budget, and one world
   legitimately reserves twice (draft + HQ).

> `findWorldByDisplayName`'s live implementation targets a
> `GET /marble/v1/worlds` listing that the Phase 0 spike never exercised, so the
> path/response shape is an **unverified** best-effort guess parsed tolerantly.
> A wrong guess degrades to "reconciliation fails → job parked", never to a
> double bill. Verify it against the live API before relying on auto-recovery.

4. `reserveCredits` (`budget.ts`) sums today's `credit_events.amount` inside a
   transaction (with a `pg_advisory_xact_lock` so parallel workers can't both
   slip past) and inserts a new event iff `sum + cost <= DAILY_CREDIT_BUDGET`;
   else it throws `BudgetExceededError` and the job is **parked dead (no
   retry)**.

Provider CDN URLs are never exposed: every asset (SPZ 500k/100k, thumbnail,
collider) is downloaded and re-hosted on **our** storage under `worlds/{id}/`.

**Asset downloads are treated as untrusted input** (spec §10 R10). The URLs come
from the provider's own JSON, so `downloadAsset`:

- sends `WLT-Api-Key` **only** when the host is the API host. Signed CDN URLs
  need no credential, and attaching one to a provider-chosen host is how a key
  leaks;
- requires **https** and an allowlisted host — `WORLDLABS_ASSET_HOSTS`
  (comma-separated; a leading `.` matches subdomains), defaulting to
  `api.worldlabs.ai` and `.worldlabs.ai`;
- refuses non-routable hosts (loopback, RFC1918, CGNAT, and link-local
  `169.254.169.254`, the cloud metadata endpoint) even if the allowlist names
  one, so a misconfigured env cannot become an SSRF primitive;
- enforces `WORLDLABS_ASSET_MAX_BYTES` (default **200 MB**) **while streaming**,
  aborting the transfer rather than discovering the size after buffering it.
  `Content-Length` is a fast path only — it is attacker-controlled and absent
  under chunked encoding.

### Mock mode walkthrough (offline, zero credits)

`PROVIDER_MODE=mock` (the default) runs the whole pipeline with **no network and
no credits** via `provider/mock.ts` (instant operations, fixture asset bytes
served from an in-memory map). Cost is a property of the provider: the mock's
`creditsForModel` returns **0**, so dev runs reserve 0 against
`DAILY_CREDIT_BUDGET` (a 0-amount `credit_events` row keeps the ledger path
exercised) and `worlds.credits_spent` stays 0 — spend metrics reflect only real
generations. End to end offline:

```bash
cp .env.example .env         # defaults are mock + local storage
# start Postgres + apply migrations
npm run db:migrate
# terminal 1 — API
npm run dev
# terminal 2 — worker
npm run worker
```

Then drive the API (`POST /v1/worlds` with `frame_count: 1` → PUT the frame →
`POST /v1/worlds/{id}/frames:done`). The worker stitches (passthrough),
"generates" a mock world, re-hosts fixture assets into local storage, and the
world reaches `draft_ready` — all with zero World Labs calls. (Multi-frame
captures additionally exercise the Python stitcher — ensure `PYTHON_BIN` points
at a venv with `stitcher/requirements.txt` installed; see
[Stitcher](#stitcher-spec-5--phase-05).)

## Known leftovers

Deliberately not fixed — recorded so the next reader does not mistake them for
oversights.

- **`worlds.spz_full_url` is a dead column.** Nothing writes it: the worker
  re-hosts only the 100k and 500k SPZ tiers (spec §3.2 — `full_res` is an
  export/desktop concern, and WKWebView has a hard memory ceiling), and
  `getWorld` parses `full_res` into `spzUrls.full` which `collectAssets` never
  stores. It *is* still presigned into the detail response's `assets` object, so
  it reads as `null` for every world. Left in place: dropping a column is a
  destructive, irreversible migration to reclaim a few bytes per row, and the
  column is the obvious place to put the full-res URL if the export path ever
  ships. Treat it as reserved, not as a bug.

## Notes / boundaries

- No DB connection is made on boot — the `pg` pool is created lazily on the first
  query, so the process and `/healthz` come up without Postgres.
- `worldlabs.ts` is a faithful port of `tools/spike/spike.py` (the live-verified
  contract), incl. `media_asset.media_asset_id`, the `WLT-Api-Key` header, and
  the `is_pano: true` generate body. It is exercised only when `PROVIDER_MODE=live`.
- Multi-frame stitching is live (Phase 0.5, see [Stitcher](#stitcher-spec-5--phase-05));
  real APNs delivery remains a future phase. The `.heic` frame keys hold JPEG
  bytes by client contract — see [Stitcher](#stitcher-spec-5--phase-05); there is
  no transcode to add.
