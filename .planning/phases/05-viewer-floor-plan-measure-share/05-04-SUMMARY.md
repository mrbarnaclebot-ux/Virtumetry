---
phase: 05-viewer-floor-plan-measure-share
plan: 04
subsystem: backend
tags: [share-links, scrypt, cors, og-preview, noindex, rate-limit]
requires:
  - 05-01 (ASSET_FIELDS, floorplan_meta, thumbnail_key)
provides:
  - migration 0004_share_links (share_slugs.password_hash, open_count, last_opened_at), applied to the Neon dev branch
  - POST/GET/DELETE /v1/worlds/:id/shares (owner, authed scope)
  - GET /v1/public/shares/:slug, POST /v1/public/shares/:slug/open (anonymous, scoped CORS)
  - GET /s/:slug landing (OG preview, noindex, redirect to WEB_SHARE_ORIGIN/r/<slug>)
  - config WEB_SHARE_ORIGIN, PUBLIC_BASE_URL_EXPLICIT, RATE_LIMIT_PUBLIC_MAX/SHARE_OPEN_MAX/LANDING_MAX, SHARE_FAIL_MAX
affects: [05-06 share sheet, 05-07 web share page, Railway dev/prod env vars]
tech-stack:
  added: []
  patterns:
    - "scrypt$N$r$p$salt$hash self-describing password hashes, bounded params, timingSafeEqual"
    - "CORS registered only inside a prefixed scope (/v1/public) so it never collides with the Better Auth cors scope"
    - "Missing optional deploy vars degrade routes to 503 instead of failing boot"
key-files:
  created:
    - backend/drizzle/0004_share_links.sql
    - backend/drizzle/meta/0004_snapshot.json
    - backend/src/share-password.ts
    - backend/src/routes/share.ts
    - backend/test/share-password.test.ts
    - backend/test/share-cors.test.ts
    - backend/test/integration/share.pg.test.ts
  modified:
    - backend/drizzle/meta/_journal.json
    - backend/src/db/schema.ts
    - backend/src/config.ts
    - backend/src/routes/index.ts
    - backend/test/config.test.ts
    - backend/test/migrate-folder.test.ts
decisions:
  - "Revoke on a junk or foreign shareId answers 404 share_not_found; a foreign world answers 404 world_not_found (same as every owner route)"
  - "POST /open validates the slug and liveness before the body, so a malformed body on a dead link is still the identical 404 (no oracle)"
  - "The per-slug password throttle applies only to protected links and is checked before scrypt; a missing password does not count as a failure"
  - "Landing title falls back to 'Untitled scan'; the public API returns the raw (possibly null) title for the web page to handle"
  - "verifySharePassword bounds N <= 2^17, r <= 16, p <= 4 so a corrupt stored hash cannot become a memory bomb"
metrics:
  duration: ~45 min (resumed run)
  completed: 2026-11-24
---

# Phase 5 Plan 04: Share links API Summary

Share links end to end at the API: 128-bit base64url slugs with optional scrypt passwords, owner create/list/revoke, anonymous get/open that atomically counts opens and hands out 15-minute presigned assets, scoped CORS for the web page, and a noindex `/s/:slug` landing with escaped OG tags that redirects to the web viewer. All of it is proven by a 23-case pg suite that drives the real HTTP routes.

## What was built

- **Task 1 (owner links):** Migration 0004 adds `password_hash`, `open_count` and `last_opened_at`. It was generated with drizzle-kit (no push), and `db:migrate:dev` reports the Neon dev branch is up to date with it. `src/share-password.ts` handles hashing. `shareRoutes` lives in the authed scope and covers create (ready worlds only), list (newest first, never exposes the hash) and an idempotent revoke (`coalesce(revoked_at, now())`). Config accepts `WEB_SHARE_ORIGIN` and only checks its format when it is set, with https required on Railway/prod.
- **Task 2 (public):** `publicShareRoutes` runs before the authed scope. `findLiveShare` checks the slug against a regex before touching the DB, then joins on revoked_at IS NULL, world ready and not deleted. Missing, revoked, malformed, not-ready and deleted links all return the same byte-identical `{"error":"share_not_found"}`. Opening a link goes through the throttle, then the password, then an atomic `open_count + 1` UPDATE that re-checks `revoked_at`, then presigns every asset except the thumbnail.
- **Task 3 (landing):** `GET /s/:slug` sits at the root with no CORS. Every interpolated value goes through `esc()`. `og:image` is a 7-day presign and is left out for password links and worlds without a thumbnail. It sends `X-Robots-Tag` plus a robots meta tag and `no-store` on both the live page and the 404, redirects with meta refresh and `location.replace` built only from config plus the validated slug, and never counts an open.

## Production note

The API **boots without WEB_SHARE_ORIGIN / PUBLIC_BASE_URL** (tested). In that state `/v1/public/*` and `/s/:slug` answer 503 `share_unavailable`, and creating a link also answers 503. Sharing on a Railway environment needs both `WEB_SHARE_ORIGIN` (https origin of the web page) and an explicit https `PUBLIC_BASE_URL` set there. Note too that an explicitly set `PUBLIC_BASE_URL` must now be https on Railway/prod, so check that any existing http value on the Railway dev env is fixed before the next deploy.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 2 - Security] Bounded scrypt params in verifySharePassword**
- **Found during:** Task 1
- **Issue:** Parsing N/r/p from the stored string without bounds lets a corrupt row request enormous scrypt memory.
- **Fix:** N in [2, 2^17], r in [1, 16], p in [1, 4], keylen must be 32, and any error is caught and returned as false.
- **Files modified:** backend/src/share-password.ts
- **Commit:** aaa7202

**2. [Rule 3 - Blocking] Added `ShareSlug` type export to schema.ts**
- Needed by `serializeShare`. Commit aaa7202.

### Resume note

The previous executor left the migration, config, schema and migrate-folder changes uncommitted. I reviewed them, found them correct, and committed them unchanged in aaa7202. The dev migration had already been applied (`db:migrate:dev` → "up to date").

## TDD Gate Compliance

Each task has a `test(05-04)` RED commit followed by a `feat(05-04)` GREEN commit: 29466d4 → aaa7202, 0211b95 → 0e9d58d, 234d50d → 9fe3212. Task 1's config tests already passed at RED because the stalled run had implemented config; the share-password and pg tests failed as expected.

## Verification

- `npx tsc --noEmit` clean
- `npx vitest run`: 42 files passed, 376 tests (pg suites skipped without TEST_DATABASE_URL)
- `npm run test:pg -- test/integration/share.pg.test.ts`: 23/23
- `npm run test:pg` (full): 15 files passed, 1 skipped (r2), 125 tests passed

## Known Stubs

None.

## Self-Check: PASSED
