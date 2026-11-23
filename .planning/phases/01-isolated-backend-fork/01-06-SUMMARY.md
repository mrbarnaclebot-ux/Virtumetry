---
phase: 01-isolated-backend-fork
plan: 06
subsystem: deploy
tags: [railway, docker, iac, migrations, walking-skeleton]
requires: [01-01, 01-02, 01-03, 01-04, 01-05]
provides:
  - "Node-only Dockerfile (node:24-trixie-slim), monorepo .dockerignore/.railwayignore"
  - "Railway project virtumetry (162ef8a1-afac-4a01-8253-4e3f75d8b3b3) with api + worker live"
  - "api preDeploy migrate over the Neon production direct host; healthcheck /readyz"
affects: [01-07]
tech-stack:
  added: []
  patterns: ["MIGRATE_DATABASE_URL required only by the migrator (config.migrateUrl), shape-checked by refine() when set"]
key-files:
  created: []
  modified:
    - Dockerfile
    - .dockerignore
    - .railwayignore
    - .railway/railway.ts
    - backend/src/config.ts
    - backend/src/migrate.ts
    - backend/test/config.test.ts
decisions:
  - "MIGRATE_DATABASE_URL is set on api only. The production 'required' check moved from refine() into migrateUrl(), used by migrate.ts. The worker never migrates and boots without it."
  - "Railway CLI upgraded 5.26.0 -> 5.75.0 (npm update -g @railway/cli, same package) because the installed railway/iac SDK requires CLI >= 5.42.1"
  - "On Git Bash, railway config plan/apply must run with _=<path to railway.exe>, because the SDK's version check spawns $_, which bash sets to a POSIX path"
  - "PUBLIC_BASE_URL not set: only the local storage driver reads it"
metrics:
  duration: ~45min
  completed: 2026-11-23
  tasks: 2
  files: 7
---

# Phase 1 Plan 06: Python-free image + first Railway deploy Summary

The new Railway project `virtumetry` runs api + worker from one node-only image. The api's preDeploy step migrated Neon production over the direct host and logged `[migrate] up to date`. `https://api-production-adfc8f68.up.railway.app/readyz` returns 200 `{"status":"ready","migrations":1}`.

## Commits

| Task | Commit | Message |
|------|--------|---------|
| 1 | c309559 | build(deploy): node-only image and Virtumetry Railway IaC |
| 2 (fix) | b6554c9 | fix(backend): require MIGRATE_DATABASE_URL only in the migrator |

Task 2 is otherwise cloud-only, with no repo files.

## Railway

- Project: `virtumetry`, id **162ef8a1-afac-4a01-8253-4e3f75d8b3b3**, workspace "mrbarnaclebot-ux's Projects". This is not VirtSpace's `1690518b-…`, which was never linked or touched. Every mutating command first asserted that `railway status --json` id equals 162ef8a1-… and passed `-p` where the CLI accepts it.
- Environment `production` (3868b96b-1464-4eb1-a0db-134f2d7d928a)
- Services: api `7bdf5698-01ae-4a91-8ad5-11c2fd82128f`, worker `2cebf618-1177-4c5a-a2e3-b83af234e212`. Both use the DOCKERFILE builder with `Dockerfile` and run 1 replica in us-west2.
- api: preDeploy `["node dist/migrate.js"]`, healthcheckPath `/readyz`
- IaC: `railway config plan` showed 0 to add, 3 to change, 0 to destroy (the services had been created empty first). `config apply --yes` succeeded. Variables are unmanaged.
- Public domain (api, target port 8080): `api-production-adfc8f68.up.railway.app`
- Deploys used `railway up --ci` from a clean tree (`git status --porcelain -- . ':!.planning'` was empty). The project is not GitHub-linked (D-14). The final deployments are api `1278d6d4-…` and worker `e88d2345-…`, both SUCCESS, built at commit b6554c9.

## Variables (names only)

| Service | Variables |
|---------|-----------|
| api | SERVICE_ENTRY=server, DATABASE_URL (Neon production pooled, secret), MIGRATE_DATABASE_URL (Neon production direct, secret), AUTH_MODE=apple, APPLE_BUNDLE_ID=com.virtumetry.app (placeholder until Phase 3), STORAGE_DRIVER=s3, S3_ENDPOINT / S3_ACCESS_KEY_ID / S3_SECRET_ACCESS_KEY (secrets), S3_REGION=auto, S3_BUCKET=virtumetry-prod, PROVIDER_MODE=mock, TRUST_PROXY_HOPS=2, PORT=8080 |
| worker | SERVICE_ENTRY=worker, DATABASE_URL (pooled, secret), AUTH_MODE, APPLE_BUNDLE_ID, STORAGE_DRIVER, S3_ENDPOINT, S3_ACCESS_KEY_ID, S3_SECRET_ACCESS_KEY, S3_REGION, S3_BUCKET, PROVIDER_MODE (same values as api) |

- **Absent on both services:** DEV_AUTH_TOKEN, ALLOW_PAID_PROVIDER, SPAITIAL_*, CLOUDFLARE_*, NODE_ENV (the image sets production). This was checked by listing the key names from `railway environment config --json` with the values stripped in-process. `railway variable list` was never run.
- Secrets were piped to `railway variable set KEY --stdin` from `neonctl connection-string` and from `backend/.env`. Before setting them, a script asserted the URL hosts were `ep-cold-bread-arwg787p-pooler` (pooled) and `ep-cold-bread-arwg787p` (direct, not the pooler). The dev endpoint ep-mute-fog-arwonnkz is not configured. The scratch script was deleted afterwards, and no value appeared in tool output.

## Evidence

- api deploy log:
  ```
  [migrate] applying migrations from /app/drizzle
  [migrate] up to date
  Server listening at http://...:8080
  GET /readyz (host healthcheck.railway.app) -> 200
  ```
- `curl https://api-production-adfc8f68.up.railway.app/readyz` returned `{"status":"ready","migrations":1}` with HTTP 200.
- `curl .../healthz` returned `{"status":"ok"}` with HTTP 200.
- The worker log shows `[worker] ... started; kinds=purge poll=2000ms`. A grep for `refused|Invalid environment|Error:` over its last 300 lines counted 0.
- Backend: `tsc --noEmit` is clean, and vitest shows 229 passed / 12 skipped.

**Scope note (D-06/D-09):** The deployed /readyz runs against the Neon `production` branch and the `virtumetry-prod` bucket, as locked in D-06/D-09. The roadmap SC2 phrase "dev backend … dev R2 bucket" is read as this pre-release deployment. The dev branch and `virtumetry-dev` are covered by the local /readyz in 01-05 and by CI.

## Deviations from Plan

**1. [Rule 3 - Blocking] The IaC SDK needs Railway CLI >= 5.42.1, and 5.26 was installed**
- `railway config plan` failed with: "This version of railway/iac requires Railway CLI 5.42.1 or newer". On 5.26, the plan's fallback `railway environment edit --service-config` was a silent no-op ("No changes to apply").
- Fix: `npm update -g @railway/cli` took the already-installed vendor package from 5.26.0 to 5.75.0. `railway upgrade --yes` had failed because it could not spawn `npm` on Windows. Next, the SDK's version check spawns `$_`, which Git Bash sets to `/c/nvm4w/nodejs/railway`, a path Node cannot execute. Plan and apply therefore ran as `env _="C:/nvm4w/nodejs/node_modules/@railway/cli/bin/railway.exe" railway.exe config plan|apply`.
- No repo change.

**2. [Rule 1 - Bug] The worker crash-looped because MIGRATE_DATABASE_URL was required for every production process**
- Found on the first worker deploy: `Error: MIGRATE_DATABASE_URL is required under NODE_ENV=production`. The 01-05 guard in refine() conflicted with this plan's "MIGRATE_DATABASE_URL on api only", and the worker never migrates.
- Fix: refine() still refuses a pooler or a different-endpoint MIGRATE_DATABASE_URL when it is set. The new `migrateUrl(cfg)` in config.ts refuses production without it, and migrate.ts uses it, so the direct-host-only migration guarantee (D-07) still holds. Tests: the "missing" case now asserts that config boots and that `migrateUrl` throws, plus a new case for the prod/non-prod return value.
- Files: backend/src/config.ts, backend/src/migrate.ts, backend/test/config.test.ts. Commit: b6554c9.
- That was redeploy 1 of the 3 allowed, and it succeeded.

**3. [Rule 3] Services were created with `railway add --service api|worker` before `config apply`**
- I ran these while trying the fallback path. Apply then matched the services by name and only changed their config (0 adds, 0 destroys).

**4. Verify-script quirk (not fixed)**
- The plan's automated verify parses `railway domain --json` as `domains[0].domain`. CLI 5.75 returns `{"domains":["https://…"]}`, so that one-liner curls `undefined`. The direct curl to the recorded domain passes. Plan 01-07 or the verifier should use `j.domains[0]`.

## Known Stubs

- `APPLE_BUNDLE_ID=com.virtumetry.app` is a placeholder until Phase 3 (A4) and is intentional.

## Threat Flags

None. The public api domain and its /readyz exposure are covered by T-01-26 (accepted).

## Self-Check: PASSED

- FOUND: Dockerfile, .dockerignore, .railwayignore, .railway/railway.ts, backend/src/config.ts
- FOUND commits: c309559, b6554c9
- Railway: project 162ef8a1-… is linked; api and worker are SUCCESS; /readyz returns 200.
