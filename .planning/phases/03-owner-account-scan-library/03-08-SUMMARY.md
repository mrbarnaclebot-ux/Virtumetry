---
phase: 03-owner-account-scan-library
plan: 08
subsystem: deploy
tags: [railway, better-auth, environments, dev-backend]
requires: [03-04]
provides:
  - "Railway dev environment (api + worker) at https://api-dev-d164ec0a.up.railway.app on Neon dev + virtumetry-dev, session auth, mock provider"
  - "Production on AUTH_MODE=session with its own secret and an empty allowlist (closed)"
affects: [03-09]
tech-stack:
  added: []
  patterns: ["NODE_ENV=development as a Railway variable on dev overrides the image's production default"]
key-files:
  created: []
  modified:
    - Dockerfile
    - backend/README.md
decisions:
  - "Dockerfile copies backend/.npmrc before npm ci so legacy-peer-deps applies in the image"
  - "OWNER_ALLOWLIST is read by the api only; the owner sets it on dev api, never on worker"
  - "Dev api gets PORT=8080 and TRUST_PROXY_HOPS=2, mirroring production"
metrics:
  duration: ~45min
  completed: 2026-11-24
  tasks: 2
  files: 2
---

# Phase 3 Plan 08: Railway dev environment + production session auth Summary

The phone now has an HTTPS dev backend, **https://api-dev-d164ec0a.up.railway.app**, running Better Auth (sign-up disabled), the mock provider, the Neon dev branch and `virtumetry-dev`. Production was redeployed on session auth and stays closed until the owner opens its allowlist.

## Commits

| Task | Commit | Message |
|------|--------|---------|
| pre (Rule 3) | 30152b9 | fix(03-08): copy backend/.npmrc into the image before npm ci |
| 1 | 1579eeb | docs(03-08): Railway dev environment and auth variables |
| 2 | (cloud only) | production variables + redeploy. The README production notes landed in 1579eeb |

## Railway

- Project `virtumetry` 162ef8a1-afac-4a01-8253-4e3f75d8b3b3. Every mutation was preceded by a `railway status --json` id assertion. No other project was linked or touched.
- `railway environment new dev` (empty, not duplicated) created environment `dev` 97914b84-7cfb-40bf-941e-3db0f129e7a6. Note: this left the local link on `dev`. Every later command passed `-e` explicitly.
- `config plan --environment dev`: **Plan: 2 to add, 0 to change, 0 to destroy** (`+ Create service api`, `+ Create service worker`). `config apply` reused the existing service ids (api 7bdf5698-…, worker 2cebf618-…) for the dev instances. Production was not changed.
- Dev domain: `railway domain -s api -e dev -p 8080` returned `https://api-dev-d164ec0a.up.railway.app`.

### Variables (names only)

| Env / service | Variables |
|---|---|
| dev api | AUTH_MODE=session, BETTER_AUTH_SECRET, BETTER_AUTH_URL=https://api-dev-d164ec0a.up.railway.app, DATABASE_URL (dev pooler), MIGRATE_DATABASE_URL (dev direct), NODE_ENV=development, PORT=8080, PROVIDER_MODE=mock, S3_ACCESS_KEY_ID, S3_BUCKET=virtumetry-dev, S3_ENDPOINT, S3_REGION, S3_SECRET_ACCESS_KEY, SERVICE_ENTRY=server, STORAGE_DRIVER=s3, TRUST_PROXY_HOPS=2 |
| dev worker | same as api minus MIGRATE_DATABASE_URL, PORT, TRUST_PROXY_HOPS; SERVICE_ENTRY=worker |
| production api + worker | added AUTH_MODE=session (was apple), BETTER_AUTH_SECRET (new, different from dev), BETTER_AUTH_URL=https://api-production-adfc8f68.up.railway.app. Every other variable was left as it was, including APPLE_BUNDLE_ID, which `session` mode ignores |

- These were never set on either environment: DEV_AUTH_TOKEN, ALLOW_PAID_PROVIDER, SPAITIAL_API_KEY, OWNER_ALLOWLIST. I verified this by listing key names from `railway environment config --json` with the values stripped in-process.
- Before anything was piped, a scratch assertion script checked that DATABASE_URL contains `ep-mute-fog-arwonnkz-pooler`, that MIGRATE_DATABASE_URL is `ep-mute-fog-arwonnkz` and not the pooler, that neither contains `ep-cold-bread-arwg787p`, and that S3_BUCKET is `virtumetry-dev`. All checks passed. Secrets went through `--stdin`, and the secret scratch files plus the script were deleted afterwards.

## Owner action: open dev sign-in

Run this from the repo root (the CLI form was checked against `railway variable set --help`). Without `--skip-deploys` it redeploys the dev api:

```bash
railway variable set OWNER_ALLOWLIST=<your-email> -e dev -s api
```

The worker doesn't need it, because only the api reads OWNER_ALLOWLIST. Also put the same `OWNER_ALLOWLIST=<your-email>` in your local `backend/.env`, then run `cd backend && npm run owner:create` (Neon dev only) and optionally `npm run seed:library`. Leave production's allowlist unset until you deliberately open it.

## Evidence

- Pre-deploy gate: `tsc --noEmit` was clean; vitest 316 passed / 75 skipped; `test:pg` 82 passed / 1 skipped.
- Dev api deploy log: `[migrate] applying migrations from /app/drizzle`, `[migrate] up to date`, `Server listening at http://…:8080`, `GET /readyz (healthcheck.railway.app) -> statusCode 200`.
- Dev worker: `[worker] … started; kinds=pack,submit,track,purge poll=2000ms`, status SUCCESS, 0 matches for `refused|Invalid environment|Error:`.
- Prod api deploy log: the same migrate, listening and readyz 200 lines. /readyz now reports `migrations: 4`, so 0003_better_auth is applied (the migrator always prints "up to date" after migrate()).
- Prod worker: `[worker] … started; kinds=pack,submit,track,purge poll=2000ms`, with 0 refused/error matches.

curl results:

| Check | Result |
|---|---|
| dev `GET /readyz` | 200 `{"status":"ready","migrations":4}` |
| dev `GET /v1/worlds` (no auth) | 401 |
| dev `POST /api/auth/sign-up/email` (origin virtumetry://) | 400 `{"code":"EMAIL_PASSWORD_SIGN_UP_DISABLED"}` |
| prod `GET /readyz` | 200 `{"status":"ready","migrations":4}` |
| prod `GET /v1/worlds` (no auth) | 401 |
| prod `POST /api/auth/sign-in/email` x@example.com | 401 `{"code":"INVALID_EMAIL_OR_PASSWORD"}` |

## Deviations from Plan

**1. [Rule 3 - Blocking] The image would not get legacy-peer-deps**
- The Dockerfile copied only package.json and the lockfile before `npm ci`, so `backend/.npmrc` (from 03-02) was missing from the build stage. I added it to the COPY line; neither ignore file excludes it. The dev and prod builds then succeeded. Commit 30152b9.

**2. [Rule 3] `railway.exe` on PATH resolves to an older scoop shim without `config`**
- I used the full path `C:/nvm4w/nodejs/node_modules/@railway/cli/bin/railway.exe` (5.75.0) with `_` set to the same path. No repo change.

**3. Task 2 README note was folded into the Task 1 commit**
- The environments table already describes production as session auth with an empty allowlist, so Task 2 had no separate file change.

## Known Stubs

None.

## Threat Flags

None. The dev public URL is covered by T-03-39 (no DEV_AUTH_TOKEN, sign-up disabled as checked with curl, allowlist owner-set).

## Self-Check: PASSED

- FOUND: Dockerfile, backend/README.md (OWNER_ALLOWLIST and BETTER_AUTH_SECRET present)
- FOUND commits: 30152b9, 1579eeb
- Railway: dev and prod api + worker are SUCCESS, and both /readyz return 200
