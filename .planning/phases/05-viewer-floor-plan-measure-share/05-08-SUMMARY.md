---
phase: 05-viewer-floor-plan-measure-share
plan: 08
subsystem: deploy
tags: [eas-hosting, r2-cors, railway-dev, uat, ci]
requires: [05-01..05-07]
provides: [hosted web share page (dev alias), dev R2 CORS, Railway dev share vars + deploy, 05-HUMAN-UAT.md]
affects: [owner UAT, Phase 5 verification, prod share setup later]
tech-stack:
  added: []
  patterns: [guarded dev-only infra script (assertDevBucket), fixture:e2e --remote against the deployed dev worker]
key-files:
  created:
    - backend/scripts/r2-cors-dev.mjs
    - .planning/phases/05-viewer-floor-plan-measure-share/05-HUMAN-UAT.md
  modified:
    - virtumetry/app.json
    - backend/package.json
    - backend/scripts/fixture-e2e.ts
    - backend/README.md
    - virtumetry/README.md
decisions:
  - "EAS project @uziman99/virtumetry (personal account), dev domain `virtumetry`, alias `dev` → https://virtumetry--dev.expo.app; hosted server env comes from EAS env `development` (plaintext public EXPO_PUBLIC_* only)"
  - "Dev R2 CORS lists explicit LAN patterns plus https://*.exp.direct (Expo Go tunnel) instead of '*'; --lan-any was not needed"
  - "fixture:e2e gets --remote: while the Railway dev worker runs, jobs must not be split between two processes (in-memory mock state)"
metrics:
  duration: ~80 min
  completed: 2026-11-25
---

# Phase 5 Plan 08: Deploy to dev, owner UAT, green CI Summary

Phase 5 now runs on dev infrastructure:

- The web viewer is hosted at `https://virtumetry--dev.expo.app` (EAS Hosting, alias `dev`, never `--prod`).
- R2 `virtumetry-dev` serves room bytes cross-origin with Range to that origin and to the owner's Expo Go (LAN or tunnel).
- The Railway dev api and worker run the demo room and share routes.
- The owner has a 13-step checklist in 05-HUMAN-UAT.md.

## Tasks

| Task | Commit | Notes |
|------|--------|-------|
| 1 EAS link + R2 CORS script | f420bd6 | `eas init --account uziman99` (no build); `r2-cors-dev.mjs` + `npm run r2:cors-dev` |
| 1 follow-up: tunnel origin | 1fc94b2 | added `https://*.exp.direct` because the owner's Expo Go runs via `--tunnel` |
| 2 fix: fixture:e2e --remote | 192e503 | see Deviations |
| 2 Railway vars + deploy | (no repo files) | dev only, see below |
| 3 UAT + README | ff8cf26 | 13 checks, README "Test on your iPhone (Phase 5)" |

## EAS Hosting (D-19)

- `eas whoami` showed an existing login. `eas init --account uziman99 --non-interactive` created `@uziman99/virtumetry` and wrote `extra.eas.projectId` and `owner` to app.json. eas init also wrote a resolved `extra.router` block (including `asyncRoutes.web: true`). I removed it so router behaviour stays as configured by the plugin.
- EAS env vars, environment `development`, plaintext, public client config:
  - `EXPO_PUBLIC_API_URL=https://api-dev-d164ec0a.up.railway.app`
  - `EXPO_PUBLIC_APP_ENV=development`
- Deploy: `npm run web:export:dev`, then `eas deploy --alias dev --environment development --dev-domain virtumetry --non-interactive`. Alias URL: `https://virtumetry--dev.expo.app`. **No `--prod` in any command. No `eas build`, no `eas update`.**
- `GET https://virtumetry--dev.expo.app/r/AAAAAAAAAAAAAAAAAAAAAA` returned **200**, with `x-robots-tag: noindex, nofollow`, `<meta name="robots" content="noindex,nofollow"/>` and the SSR spinner. No 500, so the runtime env is present.

## R2 dev CORS (D-21)

- `node --env-file=.env scripts/r2-cors-dev.mjs --origin https://virtumetry--dev.expo.app`. assertDevBucket passed, PutBucketCors ok (no AccessDenied, so no owner action), and GetBucketCors printed this rule:
  - origins: share origin, `http://localhost:8081`, `http://localhost:8090`, `http://192.168.*`, `http://10.*`, `https://*.exp.direct`
  - methods: GET and HEAD
  - allowed header: `Range`
  - exposed headers: `Content-Range`, `Accept-Ranges`, `Content-Length`, `ETag`
  - max age: 3600
- Preflights after 30 s, all 204 with an echoed allow-origin:
  - `https://virtumetry--dev.expo.app`
  - `http://192.168.1.50:8081`
  - `https://abc-anonymous-8081.exp.direct`
- `--lan-any` wasn't needed. virtumetry-prod is untouched, and the script doesn't mention it.

## Railway dev (D-02/D-20)

Project 162ef8a1-…, **environment `dev` only**. Variables were set with `--skip-deploys`:

| Variable | Service | Env |
|----------|---------|-----|
| `MOCK_OUTPUTS_SET=demo-room` | api | dev |
| `WEB_SHARE_ORIGIN=https://virtumetry--dev.expo.app` | api | dev |
| `PUBLIC_BASE_URL=https://api-dev-d164ec0a.up.railway.app` | api | dev |
| `MOCK_OUTPUTS_SET=demo-room` | worker | dev |

`ALLOW_PAID_PROVIDER`: the variable list for api and worker was checked by count only and is 0 on both. **Production: unchanged. ALLOW_PAID_PROVIDER: unset.**

Deploys: `railway up -s api|worker -e dev -p 162ef8a1-… --ci -m "phase 5 viewer + share"` ran from a clean tree at f420bd6, and both reported "Deploy complete". The api log shows `[migrate] up to date`: 0004 was already applied to the Neon dev branch in 05-04. The server listens and the worker started with `kinds=pack,submit,track,purge`.

Live smoke results:
- `/healthz` → `{"status":"ok"}`
- `/s/AAAAAAAAAAAAAAAAAAAAAA` → 404 with `x-robots-tag: noindex, nofollow`. It is not 503, so the share vars are in effect.
- `OPTIONS /v1/public/shares/…` with Origin set to the share origin → 204 with `access-control-allow-origin: https://virtumetry--dev.expo.app`
- The same request with `Origin: https://evil.example` → 204 with **no** allow-origin
- `fixture:e2e -- --remote` (driven by the deployed dev worker): packing → submitting → processing → importing → **ready** in 80 s, credits 930. Assets: `v1/thumbnail.jpg` (31866 B), `splat.ply`, `collider.ply`, `floorplan.json`/`.png` and `cameras.json`. Everything was purged afterwards with 0 objects left. Cost: $0, mock.

Prod note: sharing on production needs both `WEB_SHARE_ORIGIN` and an https `PUBLIC_BASE_URL` set there, plus a prod hosting deploy and prod R2 CORS. None of that was done in this plan.

## Deviations from Plan

1. **[Rule 1 - Bug] fixture:e2e broke while the Railway dev worker is running** (192e503).
   - The first runs failed in two ways. One run hit `FRAME_COUNT_OUT_OF_RANGE` because the local run lacked dev's `CAPTURE_CONFIG_JSON`. The next stalled at processing: the dev worker claimed the `track` job and got `unknown request`, because the mock keeps request state in the memory of the process that submitted.
   - A failed run also crashed on cleanup (`reading 'phase'`), because purge deletes its own job row.
   - Fix: a `--remote` flag (only enqueue and poll, 420 s timeout) so the deployed dev worker runs the whole chain, plus a `!j` guard in the purge wait. The README documents both.
   - I soft-deleted the stranded world and the dev worker purged it. The first failed world had already been purged.
2. **[Rule 2] Expo Go tunnel origin in R2 CORS** (1fc94b2). The owner runs Expo Go over `--tunnel`, so the DOM viewer's origin is `https://*.exp.direct`, and the planned LAN patterns alone would block the owner's own viewer (research Pitfall 6).
3. **eas init side effect.** It wrote a resolved `extra.router` block into app.json. I removed it and kept only `extra.eas.projectId` and `owner`.
4. **Share link not pre-created.** Creating one needs the owner's session, which I didn't have. The UAT tells the owner to create it from the app (check 7).

## Verification

- virtumetry: `expo lint` ok, `tsc --noEmit` ok, `jest --ci` 29 suites / 284 tests passed
- backend: `tsc --noEmit` ok, `vitest run` 376 passed (117 skipped), `npm run test:pg` 125 passed (1 skipped)
- Secret grep on 05-HUMAN-UAT.md and virtumetry/README.md (`postgres://|sk_|r2.cloudflarestorage.com`): no matches
- CI for pushed HEAD ff8cf26: **app run 45463699981 success, backend run 45463700126 success**. The SUMMARY commit after it touches only `.planning/`, which both workflows' path filters skip, so ff8cf26 is still the latest code commit CI ran on.

## Known Stubs

None.

## Threat Flags

None. All surfaces are in the plan's threat model: T-05-36 (only dev was touched), T-05-37 (outputs show statuses and headers only), T-05-38 (GET/HEAD, explicit origins).

## Self-Check: PASSED

Commits f420bd6, 192e503, 1fc94b2, ff8cf26 found; backend/scripts/r2-cors-dev.mjs and 05-HUMAN-UAT.md exist. STATE.md / ROADMAP.md not modified (orchestrator owns them).
