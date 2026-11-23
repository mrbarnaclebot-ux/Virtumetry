# Phase 1: Isolated Backend Fork - Research

**Researched:** 2026-11-23
**Domain:** Node 24 / Fastify / Drizzle backend fork + Neon / Railway / R2 provisioning + GitHub Actions monorepo CI
**Confidence:** HIGH for code inventory and CLI surfaces (read and run locally). MEDIUM for Railway IaC on Windows and R2 write permission (not exercised, because no resources were created).

<user_constraints>
## User Constraints (from CONTEXT.md)

### Locked Decisions

#### Copy & strip scope
- **D-01:** Copy VirtSpace `backend/` (src, test, drizzle, package.json, package-lock.json, tsconfig, vitest config, drizzle.config.ts, README.md, .env.example) plus repo-root `Dockerfile`, `.dockerignore`, `.railwayignore`, `.railway/` (IaC) and `.github/workflows/backend.yml` into the Virtumetry monorepo. Copy verbatim first (one commit), then strip in separate commits so the diff is reviewable.
- **D-02:** Remove: `backend/stitcher/` (Python) and its tests (`stitcher.*.test.ts`), `src/depth.ts`, `src/provider/worldlabs.ts` and its tests (`worldlabs*.test.ts`), stitch/generate_draft/generate_hq job kinds and the pano/enhance routes that only serve World Labs. Python, numpy, opencv and the venv leave the Dockerfile and CI (image becomes plain `node:24-*-slim`; no python setup step in CI).
- **D-03:** Keep: Fastify server, routes/health, auth (jose dev + Apple verify code paths — real auth replaced in Phase 3), Postgres job queue with leases, worker skeleton (purge + reaper), quotas/budget/throttle/rate-limit, storage drivers (local + s3), push module (dormant until Phase 7), provider interface `src/provider/types.ts` + `mock.ts` (generalized in Phase 2), graceful shutdown, zod contracts, migrate.ts.
- **D-04:** Rename VirtSpace identifiers (package name, project name `virtspace` in IaC, DB names, log prefixes, `VirtSpace <jobId>` strings) to Virtumetry. Do NOT bump dependency versions during the copy (vitest/TS/zod stay as in VirtSpace).
- **D-05:** Database schema: start a fresh migration history for Virtumetry (new `drizzle/0000_*` generated from the stripped schema) rather than replaying VirtSpace's 5 migrations that include World Labs/pano columns. Columns/tables that only served World Labs/stitching are dropped from `schema.ts`.

#### Neon topology
- **D-06:** One new Neon project `virtumetry` (via `neonctl --org-id org-patient-pine-24176162`), region close to Railway (us-west-2 / aws-us-west-2 to match Railway `us-west2`). Branches: `production` (default) and `dev` (child). Local dev and CI-integration use `dev`; Railway uses `production`.
- **D-07:** Two connection strings per branch: pooled (`-pooler` host) as `DATABASE_URL` for the app, direct host as `MIGRATE_DATABASE_URL` for migrations. Never issue session-level `SET` through the pooler.
- **D-08:** Isolation guard (FND-02): config refuses to boot when the DATABASE_URL / MIGRATE_DATABASE_URL host matches a known VirtSpace host or when `NODE_ENV!=production` and the URL points at the `production` branch endpoint. Implement as an explicit denylist + branch-endpoint check with a unit test. Also refuse S3 bucket names containing `virtspace`.

#### R2 + secrets layout
- **D-09:** Two new R2 buckets: `virtumetry-dev` and `virtumetry-prod` (created via Cloudflare API/wrangler with the owner's account token). Same access key may be used for both in v1, but bucket names are environment-specific and the prod bucket is only configured on Railway.
- **D-10:** Backend secrets move out of `virtumetry/.env` into a gitignored `backend/.env` with normalized names: `SPAITIAL_API_KEY`, `SPAITIAL_WEBHOOK_SECRET`, `S3_ENDPOINT`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY`, `S3_BUCKET`, `S3_REGION=auto`, `CLOUDFLARE_ACCOUNT_ID`, `CLOUDFLARE_API_TOKEN`. After copying, remove those keys from `virtumetry/.env` (the app never holds backend secrets). Never print secret values in logs or tool output. `.env.example` documents every variable with placeholders.
- **D-11:** SpAItial keys are stored now but unused until Phase 6; `PROVIDER_MODE=mock` default.

#### Paid-provider & dev-auth guards
- **D-12:** FND-03: boot refuses `PROVIDER_MODE=live` (any paid provider) unless `ALLOW_PAID_PROVIDER=1`; refuses `AUTH_MODE=dev` when `NODE_ENV=production` (keep VirtSpace's existing guard but drop the `ALLOW_DEV_AUTH` escape hatch, or keep it test-only). Both covered by boot tests.

#### Railway topology & deploy
- **D-13:** New Railway project `virtumetry` (never VirtSpace's `1690518b-…`), services `api` and `worker` from the same Dockerfile, `SERVICE_ENTRY` picks the entrypoint; IaC in `.railway/railway.ts` (whole-project file — omitted resources are deleted on apply). `preDeploy: node dist/migrate.js` on api only with `MIGRATE_DATABASE_URL` set to the direct production host. Healthcheck `/healthz`.
- **D-14:** Deploy is not GitHub-linked; deploy with `railway up` from a clean tree. A first deploy to the NEW project is approved for this phase (needed to prove FND-04). Variables set via `railway variables` (unmanaged in IaC). `TRUST_PROXY_HOPS=2` on Railway.

#### CI & push
- **D-15:** GitHub Actions in the existing private repo `github.com/mrbarnaclebot-ux/Virtumetry`: workflow `backend.yml` (paths `backend/**`): `npm ci`, `tsc --noEmit`, `vitest run` (no Python). Add `app.yml` (paths `virtumetry/**`): `npm ci`, `npx expo lint`, `npx tsc --noEmit`. Postgres integration suites run only when a `TEST_DATABASE_URL` secret (Neon `dev` branch) is present; otherwise skipped.
- **D-16:** Pushing commits to `origin main` of the owner's private repo is part of verifying FND-05. Never push secrets; check `git diff --cached` for `.env` before each commit.

### Claude's Discretion
- Exact list of routes/tables to delete vs keep where they're World-Labs-only (planner decides from code).
- Whether to keep the reaper/purge jobs now or stub them.
- Node base image variant (trixie-slim vs bookworm-slim) once Python is gone.

### Deferred Ideas (OUT OF SCOPE)
- Better Auth replacing the jose/Apple auth paths — Phase 3.
- Generalized ReconProvider + Echo-3 mock — Phase 2; live Echo-3 — Phase 6.
- Push notifications (APNs key) — Phase 7.
- R2 lifecycle/retention rules — Phase 9.
</user_constraints>

<phase_requirements>
## Phase Requirements

| ID | Description | Research Support |
|----|-------------|------------------|
| FND-01 | Backend runs from `backend/` as a stripped copy of VirtSpace, and its suite passes in CI | Delete/keep/modify inventory (below). Baseline is 375 passed / 36 skipped on Node 22 locally. The fresh `0000` migration generates without a DB |
| FND-02 | Own Neon/Railway/R2, and no config path can reach VirtSpace production | VirtSpace identifiers found (Neon endpoint `ep-withered-paper-ajlntp59`, region `us-east-2`, bucket `virtspace-assets` **in the same Cloudflare account**). Isolation guard design + tests below |
| FND-03 | Paid provider refused without `ALLOW_PAID_PROVIDER=1`. Dev-token auth refused in production | `config.ts` `refine()` already has the dev-auth refusal. Add the paid-provider rule, the `DEV_AUTH_TOKEN`-in-prod rule, and drop `ALLOW_DEV_AUTH` |
| FND-04 | Migrations run on deploy over the direct Neon host | `migrate.ts` + Railway `preDeploy` already exist. Add a config rule: in production `MIGRATE_DATABASE_URL` is required, non-pooler, and on the same endpoint as `DATABASE_URL` |
| FND-05 | App + backend lint/typecheck/tests on every push in GitHub Actions | `backend.yml` / `app.yml` drafts below. **App `tsc` fails in CI unless `expo-env.d.ts` is generated first** (verified) |
</phase_requirements>

## Project Constraints (from CLAUDE.md / AGENTS.md)

- Use GSD workflow entry points for all repo edits (`/gsd-execute-phase` for this phase).
- `virtumetry/AGENTS.md`: use `npx expo install` for app deps. Run `npx expo lint` + `npx tsc --noEmit` before declaring done. **Never run `eas build` without asking.** Never hand-edit `ios/`/`android/`.
- The app never holds backend secrets. Anything `EXPO_PUBLIC_*` is embedded in the bundle. Verified: `npx expo lint` prints `env: export CLOUDFLARE_ACCESS_KEY_ID … spAItial_apikey …`, so Expo CLI loads `virtumetry/.env` into every app command today. That is why D-10's move matters.
- Money: mock provider is the default. No real Echo-3 calls. Budget caps live server-side.
- Data isolation: VirtSpace production is never touched (Railway `1690518b-f063-41df-8839-19c0b00a33a1`, Neon project `long-hat-19889473`, R2 `virtspace-assets`).
- STACK.md: don't upgrade vitest/TS/zod during the copy.
- Conventional Commits with scope. Check `git diff --cached` for `.env` before every commit.

## Summary

The VirtSpace backend copies cleanly and runs today. On this Windows machine (Node 22.21.1), `npm ci && tsc --noEmit && vitest run` gives **31 files passed, 7 skipped, 375 tests passed, 36 skipped** in about 4 s. The skips are 5 stitcher suites (no Python) and 2 Postgres integration suites (no `TEST_DATABASE_URL`) `[VERIFIED: local run]`. The World Labs coupling is deep but has clear edges. `worker.ts` (1,400 lines) is mostly stitch plus draft/HQ generation. `routes/worlds.ts` has enhance, retry and depth add-ons wrapped around a generic create / presign / frames:done / get / list / delete core. `schema.ts` has 5 WL/pano-only `worlds` columns and 7 WL-only statuses. After the strip, the worker claims only `purge` and runs the two reapers. The world pipeline stops at a new `uploaded` status that Phase 2 picks up.

All guards belong in `config.ts` `refine()`, because the server, worker and `migrate.ts` all boot through `getConfig()`. One guard set therefore covers every entrypoint. VirtSpace's Neon production is in **aws-us-east-2** (`ep-withered-paper-ajlntp59.c-3.us-east-2.aws.neon.tech`), and Virtumetry goes to **aws-us-west-2**. That gives a cheap, structural denylist: refuse any `*.us-east-2.aws.neon.tech` host, plus the exact VirtSpace endpoint id. The R2 bucket `virtspace-assets` sits in the **same Cloudflare account** as the token the owner supplied. So the bucket-name guard is load-bearing, not cosmetic, and the S3 access key's bucket scope is an open question.

All provisioning has non-interactive CLI paths: `neonctl projects create/branches/cs`, `railway init --name --workspace --json`, `railway config apply --yes`, `railway variable set --stdin --skip-deploys`, `railway up -s api --ci`, R2 REST `POST /accounts/{id}/r2/buckets`, and `gh secret set` from stdin. Each was checked against `--help` or docs. Three traps would otherwise burn time. Neon CLI-created projects get a `main` default branch, not `production`, so it has to be renamed. `railway init` needs `--workspace` outside a TTY. App `tsc` in CI needs the gitignored `expo-env.d.ts`.

**Primary recommendation:** Copy verbatim, then strip in this order: tests → src → schema → fresh `0000` migration → Dockerfile/CI. Then add one TDD'd guard block in `config.ts` (paid provider, dev token in prod, VirtSpace denylist, prod-endpoint-from-non-prod, migrate URL non-pooler, bucket allowlist). Provision Neon first, because the prod endpoint id becomes a code constant. Then R2, CI, and Railway last, with `/readyz` doing a real DB read.

## Architectural Responsibility Map

| Capability | Primary Tier | Secondary Tier | Rationale |
|------------|-------------|----------------|-----------|
| Boot guards (paid provider, dev auth, isolation, migrate URL) | API / Backend (`config.ts` refine) | — | Every process (server, worker, migrate) calls `getConfig()`. One choke point |
| Schema migrations | Database (Neon direct host) | Railway preDeploy (api only) | Session advisory lock needs a direct connection. One migrator per release |
| Health / readiness | API / Backend (`/healthz`, `/readyz`) | Railway healthcheck | Railway checks only at deploy time, so `/readyz` with a DB read proves DB + migrations |
| Object storage | R2 (`virtumetry-dev` / `-prod`) | API presigns | Unchanged VirtSpace S3 driver |
| Job processing (purge, reapers) | Worker service | Postgres queue | Same image, `SERVICE_ENTRY=worker` |
| CI | GitHub Actions | — | Not EAS CI minutes (60/month free) |
| Secrets | Railway variables (prod), `backend/.env` (local), GH secret (CI) | — | Never in IaC, never in the app |

## Standard Stack

No new runtime dependencies. Copy VirtSpace's lockfile verbatim (D-04).

### Core (as installed from VirtSpace lockfile — `[VERIFIED: node_modules after npm ci]`)
| Library | Version | Purpose |
|---------|---------|---------|
| fastify | 5.12.8 | HTTP API |
| drizzle-orm | 0.45.2 | ORM + programmatic migrator (`drizzle-orm/node-postgres/migrator`) |
| drizzle-kit | 0.31.11 (dev) | `drizzle-kit generate` for the fresh `0000` |
| pg | ^8.23 | Postgres driver |
| zod | ^4.6.7 | Env + request validation |
| jose | ^6.2.12 | Apple JWT verify (kept until Phase 3) |
| @aws-sdk/client-s3 + s3-request-presigner | ^3.1134 | R2 |
| vitest | 2.1.9 (dev) | Tests. Don't upgrade in this phase |
| typescript | 5.9.3 (dev) | Typecheck |

### Tooling (machine) — `[VERIFIED: --version]`
| Tool | Version | Use |
|------|---------|-----|
| neonctl | 2.26.6 | Neon project/branch/connection strings |
| railway CLI | 5.26.0 | Project, IaC, variables, deploy (logged in) |
| `railway` npm (IaC runner `railway-iac-ts`) | 3.17.0 latest; VirtSpace pins `^3.16.0` | `.railway/` only, not the app image |
| gh | 2.83.2 (scopes include `repo`, `workflow`) | Secrets + pushing workflow files |
| curl | Git Bash | R2 bucket REST |
| wrangler | **not installed** | Not needed. Use REST |
| Docker daemon | **not running** | Not needed. Railway builds remotely |

### Alternatives Considered
| Instead of | Could Use | Tradeoff |
|------------|-----------|----------|
| R2 REST via curl | `wrangler r2 bucket create` | Wrangler isn't installed, and installing it adds a dependency for 2 calls |
| IaC `railway config apply` | `railway add --service` + dashboard | Use only if the IaC runner fails on Windows (see Pitfall 6) |
| Path-filtered workflows | Run both workflows on every push | D-15 locks path filters. See Open Question 3 |

## Package Legitimacy Audit

This phase installs **no new packages**. Every backend dependency comes from VirtSpace's committed `package-lock.json`, an established project. The only other package is the existing IaC tool `railway` in `.railway/package.json`, published by Railway and verified with `npm view railway` → 3.17.0 with bin `railway-iac-ts`, modified 2026-11-13.

| Package | Registry | Source | slopcheck | Disposition |
|---------|----------|--------|-----------|-------------|
| (backend deps) | npm | VirtSpace lockfile, copied verbatim | not run (no new names) | Approved (existing) |
| railway | npm | Railway official IaC docs (`import … from "railway/iac"`) | not run | Approved (existing, docs-referenced) |

**Packages removed:** none. **Flagged [SUS]:** none.

## Architecture Patterns

### System Architecture Diagram

```
 local dev (Windows, Git Bash)            GitHub Actions (push to main)
   backend/.env (dev branch, dev bucket)    backend.yml: npm ci → tsc → vitest (+TEST_DATABASE_URL → dev direct)
        │                                   app.yml:     npm ci → write expo-env.d.ts → expo lint → tsc
        ▼
 ┌──────────── process boot (server | worker | migrate) ────────────┐
 │ getConfig() → zod parse → refine():                              │
 │   VirtSpace denylist? ─yes→ THROW                                │
 │   non-prod + prod endpoint? ─yes→ THROW                          │
 │   PROVIDER_MODE=live w/o ALLOW_PAID_PROVIDER=1 ─→ THROW          │
 │   prod + (AUTH_MODE=dev | DEV_AUTH_TOKEN set) ─→ THROW           │
 │   prod + MIGRATE url missing/pooler/other endpoint ─→ THROW      │
 │   bucket not virtumetry-(dev|prod) / env mismatch ─→ THROW       │
 └──────────────────────────────────────────────────────────────────┘
        │
 railway up (repo root, -p <virtumetry id>) → Railway build (Dockerfile, node:24 slim)
        │
        ├─ api:   preDeploy `node dist/migrate.js` ──(direct host, advisory lock)──► Neon production branch
        │         then `node dist/server.js` ── /readyz: SELECT from drizzle.__drizzle_migrations ─► Neon (pooler)
        │                                       └─ HEAD sentinel key ─► R2 virtumetry-prod
        └─ worker: `node dist/worker.js` ── claim 'purge' + reapers ─► Neon (pooler), R2
```

### Recommended layout (monorepo root)
```
Virtumetry/
├── backend/            # copied + stripped VirtSpace backend (package.json name: virtumetry-backend)
│   ├── src/ test/ drizzle/ (fresh 0000_init.sql + meta/)
│   ├── .env            # gitignored (root .gitignore `.env`), D-10 names
│   └── .env.example
├── virtumetry/         # Expo app (untouched except removing backend keys from .env)
├── .railway/           # railway.ts + package.json (IaC runner only)
├── .github/workflows/  # backend.yml, app.yml
├── Dockerfile  .dockerignore  .railwayignore
└── .gitignore          # ADD node_modules/ (today it only lists .env*)
```

### Delete / Keep / Modify inventory (from the actual source)

**src/**
| Path | Action | Notes |
|------|--------|-------|
| `stitcher/` (Python: reproject.py, depth.py, …, requirements.txt) | DELETE | D-02 |
| `src/depth.ts` | DELETE | Imported by `worker.ts` and `routes/worlds.ts` (`depthKeyName`, `stageDepthMaps`) |
| `src/provider/worldlabs.ts` | DELETE | Imported only by `provider/index.ts` |
| `src/provider/index.ts` | MODIFY | Drop the worldlabs import. `PROVIDER_MODE=live` → `throw new Error('no live provider in this build (Phase 6)')` |
| `src/provider/types.ts`, `mock.ts` | KEEP | `budget.ts` imports `creditsForModel`/`WorldModel` from types.ts. Leave the marble shape alone (Phase 2 generalizes it) |
| `src/worker.ts` | MODIFY (large) | Delete: stitch section (`stitcherScriptPath`, `stitchPlan`, `parseProgressLine`, `createProgressLineStream`, `buildStitcherArgs`, `Stitcher*`, `classifyStitcher*`, `realStitcherSpawner`, `serializePoses`, `posesPresent`, `finalizeStitch`, `handleStitch`, `readFrameWithinCap`), generation section (`PENDING_MARKER_PREFIX`, `pendingOperationMarker`, `isPendingOperationMarker`, `generationDisplayName` = the `VirtSpace <jobId>` string, `runGeneration`, `unwindPendingGeneration`, `collectAssets`, `handleGenerate`, `createProgressThrottle`, `pseudoProgress`, `makeProgressWriter`, `GENERATE_TIMEOUT_MS`, `POLL_INTERVAL_MS`), `panoKeyFor`/`panoPreviewKeyFor`, imports of depth/provider/budget/`spawn`/fs. Keep: `NonRetryableJobError`, `LeaseLostError`, `WORLD_ASSET_NAMES` (minus `pano*.jpg`), `handlePurge` (minus the depth-key delete), `processJob` (purge only), `handleJobError`, `reapExhaustedJobs`, `isWorldReapable`, `reapStaleUploads`, `startWorker`, `main`. `WORKER_KINDS = ['purge']`. Drop `provider`/`stitcher` from `WorkerDeps`. Keep a minimal clock (`now`/`sleep`) for `startWorker`. `failedStatusFor` has no remaining kinds, so delete it and make `failWorldForDeadJob` a no-op or remove it |
| `src/routes/worlds.ts` | MODIFY | Delete: `ENHANCE_PATH`, `ENHANCE_LEGACY_PATH`, enhance handler, `RETRY_PATH`/`RETRY_PLANS`/retry handler (all three plans are WL kinds), `depthSizeSchema`/`depthFields`/`depthRequest`/`DEPTH_UPLOAD`/`presignDepthUploads`, the `depth` arg of `replayCreate`, the `panoUrl` row in `ASSET_FIELDS`, `budgetFits`/`WorldModel` imports. Change frames:done to flip `uploading → uploaded` in the same conditional-UPDATE transaction, keep the poses write, **enqueue nothing** (`job_id: null`), and keep the replay-returns-200 behaviour. Keep create (idempotency, quota, presign), uploads:refresh, GET, list, DELETE (+purge) |
| `src/db/schema.ts` | MODIFY | `WORLD_STATUSES` = `capturing, uploading, uploaded, complete, failed_upload`. `JOB_KINDS = ['purge']`. Drop `worlds.pano_url, draft_world_id, hq_world_id, draft_model, hq_model`. Keep `thumbnail_url, spz_*, collider_glb_url, provider, credits_spent, progress` (generic outputs; Phase 2 may rename). Keep `captures.poses_json` (Echo-3 accepts poses; Phase 2 decides). Statuses and kinds are TS-only, and the column is plain `text`, so no DB enum/check changes |
| `src/storage/index.ts` | MODIFY | Delete `MAX_DEPTH_BYTES` |
| `src/config.ts` | MODIFY | Remove `WORLDLABS_*`, `STITCHER_*`, `PYTHON_BIN`, `GENERATE_EXPECTED_*`, `ALLOW_DEV_AUTH`. Add `ALLOW_PAID_PROVIDER`, `SPAITIAL_API_KEY`, `SPAITIAL_WEBHOOK_SECRET` (optional). Add the guards (below) |
| `src/routes/health.ts` | MODIFY | Add `/readyz` (DB + storage probe). Keep `/healthz` as dependency-free liveness |
| `src/migrate.ts` | MODIFY (small) | Remove the "fall back to DATABASE_URL" path in production (config now guarantees `MIGRATE_DATABASE_URL`). Keep the advisory lock |
| `auth.ts`, `budget.ts`, `quota.ts`, `queue.ts`, `throttle.ts`, `push.ts`, `server.ts`, `db/client.ts`, `db/users.ts`, `routes/{account,devices,me,deps,index}.ts`, `storage/{local,s3}.ts` | KEEP | `queue.ts` keeps `setProviderOperationId`/`clearProviderOperationId` (generic money-path helpers, tested, needed in Phase 6) |
| `drizzle/0000..0004*.sql` + `meta/` | DELETE, then regenerate | D-05 |
| `drizzle.config.ts` | MODIFY | Default URL db name `virtumetry` |
| `package.json` | MODIFY | `name: virtumetry-backend`, description. **No version bumps** |
| `README.md` | MODIFY | Strip the stitcher/World Labs/depth sections. Rename |
| `.env.example` | MODIFY | Remove WL/stitcher vars. Add the D-10 names, `ALLOW_PAID_PROVIDER`, and guard notes |

**test/** (vitest does **not** typecheck tests, and `tsconfig.json` excludes `test/`. A deleted export fails at import time, but a stale `panoUrl: null` field in a fixture passes silently.)
| File | Action |
|------|--------|
| `stitcher.{banding,nominal,orientation,smoke,v2}.test.ts` | DELETE |
| `worldlabs.test.ts`, `worldlabs.download.test.ts` | DELETE |
| `worker.generate-hq.test.ts`, `worker.generate-resume.test.ts`, `worlds.enhance.test.ts`, `worlds.retry.test.ts` | DELETE |
| `worker.test.ts` | MODIFY → keep only "purge" (drop its depth-key assertions) + the mock-billing `creditsForModel` cases that don't call `runGeneration`. Delete stitchPlan/serializePoses/buildStitcherArgs/runGeneration/handleStitch/classify*/depth describes |
| `worker.lease.test.ts` | MODIFY → keep `heartbeatJob`, `clearProviderOperationId`, `handleJobError` (lost lease / retryable), `reapExhaustedJobs`. Delete "generate job lease", "idempotent generate finalize", "stitch job lease" |
| `worker.progress.test.ts` | MODIFY → keep `isWorldReapable`, `reapStaleUploads`, `serializeWorld progress + heartbeat`. Delete parseProgressLine/createProgressLineStream/createProgressThrottle/pseudoProgress |
| `upload-size.test.ts` | MODIFY → drop "depth opt-in" and "worker frame size guard" (imports `handleStitch`), and `MAX_DEPTH_BYTES` from the imports. Rename the `virtspace` bucket/tmp prefix |
| `frames-done.test.ts` | MODIFY → expect `status=uploaded`, no job enqueued. "replay after uploaded" → 200/no writes. Drop depth pose fields and the `failed_stitch` re-stitch case |
| `atomic-flip.test.ts` | MODIFY → drop the `:enhance` case. Keep DELETE world/account |
| `worlds.idempotency.test.ts`, `worlds.uploads-refresh.test.ts`, `zod-contract.test.ts` | MODIFY → drop depth cases/fields |
| `worlds.list.test.ts`, `quota.charge.test.ts` | MODIFY → drop `panoUrl` from fixtures/assertions |
| `queue.lease.test.ts`, `integration/queue.pg.test.ts` | MODIFY (hygiene) → kind literals `'stitch'`/`'generate_*'` → `'purge'`/arbitrary. Schema prefix `virtspace_it_` → `virtumetry_it_` |
| `integration/quota.pg.test.ts` | MODIFY → prefix rename |
| `jose-contract.test.ts`, `rate-limit.test.ts`, `storage.local.test.ts` | MODIFY → rename `virtspace` strings |
| `config.test.ts` | MODIFY → drop `STITCHER_WIDTH`, `ALLOW_DEV_AUTH` cases. Add the guard tests (below) |
| `account-deleted`, `auth`, `budget`, `db-client`, `error-handler`, `me-quota`, `mock-provider`, `quota`, `shutdown` | KEEP (`account-deleted` passes `provider: {}` into WorkerDeps, so delete that line once `provider` leaves WorkerDeps) |
| NEW `isolation.test.ts` (or inside `config.test.ts`), `migrate-folder.test.ts`, `readyz.test.ts` | ADD |

Recoverability: the verbatim-copy commit (D-01) keeps `runGeneration`, the pending-marker reconciliation and `readFrameWithinCap` reachable with `git show <copy-sha>:backend/src/worker.ts`. Phase 2/6 should port that money-path pattern rather than re-invent it.

### Pattern 1: Guards in `refine()` (extend the existing style)
```typescript
// Source: VirtSpace backend/src/config.ts refine() pattern (read this session)
// src/isolation.ts — committed constants (hostnames are not secrets; repo is private)
export const VIRTSPACE_NEON_ENDPOINT_IDS = ['ep-withered-paper-ajlntp59']; // VirtSpace prod (aws-us-east-2)
export const DENY_HOST_SUFFIXES = ['.us-east-2.aws.neon.tech'];            // VirtSpace region; Virtumetry is us-west-2
export const VIRTUMETRY_PROD_ENDPOINT_IDS: string[] = ['<filled after neonctl create>'];

/** 'ep-foo-bar-123-pooler.c-3.us-west-2.aws.neon.tech' → 'ep-foo-bar-123' */
export function neonEndpointId(url: string): string | null {
  const host = new URL(url).hostname;
  const label = host.split('.')[0] ?? '';
  return label.startsWith('ep-') ? label.replace(/-pooler$/, '') : null;
}
export const isPoolerUrl = (url: string) => new URL(url).hostname.split('.')[0]!.endsWith('-pooler');

// in refine(cfg):
const isProd = cfg.NODE_ENV === 'production';
for (const [name, url] of [['DATABASE_URL', cfg.DATABASE_URL], ['MIGRATE_DATABASE_URL', cfg.MIGRATE_DATABASE_URL]] as const) {
  if (!url) continue;
  const host = new URL(url).hostname, ep = neonEndpointId(url);
  if ((ep && VIRTSPACE_NEON_ENDPOINT_IDS.includes(ep)) || DENY_HOST_SUFFIXES.some((s) => host.endsWith(s)))
    throw new Error(`${name} points at VirtSpace infrastructure — refused`);
  if (!isProd && ep && VIRTUMETRY_PROD_ENDPOINT_IDS.includes(ep))
    throw new Error(`${name} is the production branch but NODE_ENV is not production — refused`);
}
if (cfg.PROVIDER_MODE === 'live' && cfg.ALLOW_PAID_PROVIDER !== '1')
  throw new Error('PROVIDER_MODE=live refused: set ALLOW_PAID_PROVIDER=1 to allow paid provider calls');
if (isProd && cfg.AUTH_MODE === 'dev') throw new Error('AUTH_MODE=dev refused under NODE_ENV=production');
if (isProd && cfg.DEV_AUTH_TOKEN) throw new Error('DEV_AUTH_TOKEN must not be set under NODE_ENV=production');
if (isProd) {
  if (!cfg.MIGRATE_DATABASE_URL) throw new Error('MIGRATE_DATABASE_URL is required under NODE_ENV=production');
  if (isPoolerUrl(cfg.MIGRATE_DATABASE_URL)) throw new Error('MIGRATE_DATABASE_URL must be the direct (non -pooler) host');
  if (neonEndpointId(cfg.MIGRATE_DATABASE_URL) !== neonEndpointId(cfg.DATABASE_URL))
    throw new Error('MIGRATE_DATABASE_URL and DATABASE_URL must be the same Neon endpoint');
}
if (cfg.S3_BUCKET) {
  if (/virtspace/i.test(cfg.S3_BUCKET)) throw new Error('S3_BUCKET points at VirtSpace — refused');
  if (cfg.S3_BUCKET === 'virtumetry-prod' && !isProd) throw new Error('virtumetry-prod bucket refused outside production');
}
```
The `MIGRATE == DATABASE endpoint` rule is optional but cheap. It stops a deploy from migrating one DB while serving another. Note that `new URL('postgres://…')` parses fine in Node (WHATWG URL accepts non-special schemes) `[ASSUMED]`. The test suite will confirm it.

**Ordering:** the denylist and bucket checks run first. They must fire even when NODE_ENV is unset (local).

### Pattern 2: `/readyz` (real DB read + storage probe)
```typescript
// health.ts — /healthz stays dependency-free (liveness). /readyz proves DB + migrations + R2 creds.
app.get('/readyz', async (_req, reply) => {
  try {
    const r = await getDb().execute(sql`select count(*)::int as n from drizzle.__drizzle_migrations`);
    await storage.objectSize('readyz/sentinel').catch((e: any) => {
      if (e?.$metadata?.httpStatusCode !== 404 && e?.code !== 'ENOENT') throw e; // 404 = creds+bucket OK
    });
    return { status: 'ready', migrations: (r.rows[0] as { n: number }).n };
  } catch (err) {
    return reply.code(503).send({ status: 'unavailable' }); // never echo err (may contain host)
  }
});
```
Point the Railway healthcheck at `/readyz`. Railway runs healthchecks only during a deploy `[CITED: docs.railway.com/deployments/healthchecks]`, so a failing DB fails the release instead of flapping a live service. The drizzle migrator writes `drizzle.__drizzle_migrations` (schema `drizzle`) `[ASSUMED: drizzle-orm default migrationsSchema]`. Verify on the first local migrate with `BEGIN READ ONLY; select * from drizzle.__drizzle_migrations; ROLLBACK;`. The local driver throws a `fs` error on a missing key, so check its error shape when writing the test. `healthRoutes(app)` currently takes no deps, so pass `storage` (`registerRoutes` already has `deps.storage`).

### Pattern 3: Fresh migration (verified)
```bash
cd backend
rm -rf drizzle && npx drizzle-kit generate --name init     # no DB connection needed
# → drizzle/0000_init.sql + drizzle/meta/{_journal.json,0000_snapshot.json}
MIGRATE_DATABASE_URL=<dev direct> npx tsx --import dotenv/config src/migrate.ts   # applies via drizzle-orm migrator
```
I ran this in the scratchpad on the unstripped schema with drizzle-kit 0.31.11. It produced `0000_init.sql` (7 tables) and journal version 7 `[VERIFIED: local run]`. The new SQL uses plain `CREATE TABLE`/`ALTER TABLE … ADD CONSTRAINT` (no `IF NOT EXISTS`/`DO $$`). That is fine on a fresh DB. Regenerate **after** the `schema.ts` strip. The Dockerfile copies `backend/drizzle` → `/app/drizzle`, and `MIGRATIONS_FOLDER` resolves `../drizzle` from `dist/`.

### Pattern 4: Stripped Dockerfile
```dockerfile
FROM node:24-bookworm-slim AS build      # Python gone; any node:24 slim works. Discretion: bookworm-slim (or trixie-slim, VirtSpace's tested base)
WORKDIR /app
COPY backend/package.json backend/package-lock.json ./
RUN npm ci
COPY backend/tsconfig.json ./
COPY backend/src ./src
RUN npm run build && npm prune --omit=dev

FROM node:24-bookworm-slim
WORKDIR /app
COPY --chown=node:node backend/package.json ./
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist ./dist
COPY --chown=node:node backend/drizzle ./drizzle
USER node
ENV NODE_ENV=production
CMD ["sh", "-c", "exec node dist/${SERVICE_ENTRY:-server}.js"]
```
Keep VirtSpace's `exec` (node as PID 1 gets SIGTERM) and `package.json` copy (`"type": "module"`). Recommendation: `node:24-trixie-slim`. It is the base VirtSpace already ran in production, and with no Python nothing differs. Lowest risk.

### Pattern 5: Railway IaC (rename only)
```typescript
// .railway/railway.ts — same as VirtSpace with project("virtumetry") and healthcheck "/readyz"
const api = service("api", { build, preDeploy: "node dist/migrate.js", healthcheck: "/readyz", replicas: { "us-west2": 1 } });
const worker = service("worker", { build, replicas: { "us-west2": 1 } });
return project("virtumetry", { variables: { managed: false }, resources: [api, worker] });
```
"Omitting a resource means deleting it" for a single whole-project file `[CITED: docs.railway.com/infrastructure-as-code]`. Generated `*.up.railway.app` domains are not declared in the file `[CITED: IaC reference]`, so `railway domain -s api` survives apply. `variables: { managed: false }` isn't in the current public reference, but VirtSpace applied it on 2026-11-05 `[CITED: VirtSpace HANDOFF.md]`. If `config plan` rejects it, remove it and confirm the plan shows no variable deletions.

### Anti-Patterns to Avoid
- **Guards in `server.ts` only.** The worker and `migrate.ts` would bypass them. Put them in `refine()`.
- **`TEST_DATABASE_URL` = pooled URL.** The integration suites run `SET search_path` on every pool connect (`quota.pg.test.ts`). That is the exact session-`SET`-through-pooler incident. Use the **direct** dev host.
- **Pushing the verbatim VirtSpace `backend.yml`.** It installs Python and runs the stitcher suites. Push only after the strip, or accept one Python run.
- **Running `railway` commands without `-p`.** Always pass the Virtumetry project id, and assert `railway status --json` ≠ `1690518b-…` before `up`/`apply`.
- **Echoing `neonctl projects create -o json`.** The output contains `connection_uris` with passwords `[CITED: neon.com/docs/reference/cli-projects]`. Pipe it to a parser that prints only `project.id`.

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| Migration runner | Custom SQL applier | Existing `migrate.ts` (drizzle migrator + advisory lock) | Already handles journal, lock, exit code for preDeploy |
| Env validation | Ad-hoc `process.env` checks | Existing zod `baseSchema` + `refine()` | One choke point. Existing tests show the style |
| Connection strings | String-building from parts | `neonctl cs <branch> --project-id P [--pooled]` | Gets host/role/password/sslmode right |
| Bucket creation | wrangler install | `curl POST /accounts/{id}/r2/buckets` | 2 calls, token already verified |
| Postgres test isolation | New harness | Existing `describe.skipIf(!TEST_DATABASE_URL)` + throwaway schema | Already written, skips cleanly when the secret is empty |

## Runtime State Inventory (fork/rename)

| Category | Items Found | Action Required |
|----------|-------------|-----------------|
| Stored data | Fresh Neon DB, so no Virtumetry data yet. VirtSpace data stays in `long-hat-19889473` (untouched) | None. Fresh `0000` migration |
| Live service config | New Railway project (variables live only in Railway, by design). VirtSpace Railway `1690518b-…` untouched | Set variables via `railway variable set` (list below) |
| OS-registered state | Railway CLI links are per-directory in `~/.railway/config.json`. The Virtumetry root is currently **unlinked** (`railway status` → "No linked project found") `[VERIFIED]`. `railway init` links the cwd | Run `railway init` from the repo root only |
| Secrets/env vars | `virtumetry/.env` holds `spAItial_apikey, spAItial_webhook_secret, CLOUDFLARE_ACCOUNT_API_TOKEN (cfat_…), CLOUDFLARE_ACCOUNT_ID, CLOUDFLARE_ACCESS_KEY_ID, CLOUDFLARE_ACCESS_KEY_SECRET, CLOUDFLARE_S3_API_ENDPOINT (https://<acct>.r2.cloudflarestorage.com, no bucket path)` `[VERIFIED: keys only]` | Map → `SPAITIAL_API_KEY, SPAITIAL_WEBHOOK_SECRET, CLOUDFLARE_API_TOKEN, CLOUDFLARE_ACCOUNT_ID, S3_ACCESS_KEY_ID, S3_SECRET_ACCESS_KEY, S3_ENDPOINT` in `backend/.env`. Remove the keys from `virtumetry/.env` (delete the file if empty). Copy with a script that never prints values |
| Build artifacts | `.railway/node_modules` after `npm ci` is **not** covered by the root `.gitignore` (it lists only `.env*`) | Add `node_modules/` to the root `.gitignore`. Add `virtumetry/`, `.planning/`, `.railway/node_modules/`, `backend/node_modules/`, `backend/test/` to `.railwayignore`/`.dockerignore` (VirtSpace's versions exclude `VirtSpace/`, not `virtumetry/`) |

## Provisioning Runbook (verified CLI surfaces; nothing was created)

### Neon (`neonctl` 2.26.6)
```bash
ORG=org-patient-pine-24176162
P=$(neonctl projects create --org-id $ORG --name virtumetry --region-id aws-us-west-2 -o json \
    | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>process.stdout.write(JSON.parse(s).project.id))')
neonctl branches list --project-id $P -o json            # expect default "main" (CLI/API-created projects)
neonctl branches rename main production --project-id $P  # D-06 wants "production"
neonctl branches create --project-id $P --name dev --parent production -o json >/dev/null
# endpoint ids for the isolation constants (no secrets): parse host from cs output, print host only
neonctl cs production --project-id $P | sed -E 's#^[^@]*@##; s#[/?].*$##'   # → ep-xxx.c-N.us-west-2.aws.neon.tech
# secrets go straight to files/stdin, never to the terminal:
neonctl cs production --project-id $P --pooled   # DATABASE_URL (Railway api+worker)
neonctl cs production --project-id $P            # MIGRATE_DATABASE_URL (Railway api)
neonctl cs dev --project-id $P --pooled          # backend/.env DATABASE_URL
neonctl cs dev --project-id $P                   # backend/.env MIGRATE_DATABASE_URL + GH TEST_DATABASE_URL
```
- Flags verified with `--help`: `--org-id`, `--name`, `--region-id` (aws-us-west-2 listed), `-o json`; `branches create --name --parent`; `branches rename <id|name> <new-name>`; `cs [branch] --project-id --pooled --ssl` `[VERIFIED: neonctl --help]`.
- Default branch naming: Neon docs say CLI/API-created projects get `main` and Console-created ones get `production` `[CITED: neon.com/docs/manage/branches]`. VirtSpace (CLI-created) has `main` `[VERIFIED: neonctl branches list]`.
- Endpoint host format includes a cell label: `ep-<name>.c-3.us-east-2.aws.neon.tech`. The pooler adds `-pooler` to the first label `[VERIFIED: VirtSpace endpoint via Neon API]`. The `neonEndpointId` parser must take label 0 and strip `-pooler`.
- `neonctl cs` default `--ssl require`. `withVerifyFullSslMode` rewrites it to verify-full (existing).
- Default database `neondb`, role `neondb_owner` `[VERIFIED: --help]`. That's fine. Don't rename.

### Cloudflare R2 (REST; token verified active and can list buckets)
```bash
# read values without printing them
T=$(grep '^CLOUDFLARE_API_TOKEN=' backend/.env | cut -d= -f2- | tr -d '\r'); A=$(grep '^CLOUDFLARE_ACCOUNT_ID=' backend/.env | cut -d= -f2- | tr -d '\r')
for b in virtumetry-dev virtumetry-prod; do
  curl -s -X POST "https://api.cloudflare.com/client/v4/accounts/$A/r2/buckets" \
    -H "Authorization: Bearer $T" -H 'Content-Type: application/json' \
    -d "{\"name\":\"$b\",\"locationHint\":\"wnam\"}" | node -e '…print .success and .errors only…'
done
```
- Endpoint/body/permission (`Workers R2 Storage Write`) `[CITED: developers.cloudflare.com/api/resources/r2/subresources/buckets/methods/create]`. `GET …/tokens/verify` → active, and `GET …/r2/buckets` → success `[VERIFIED: this session]`. **Write permission is not verified.** If the POST returns 403, the owner adds R2 Write to the token or creates the buckets in the dashboard.
- Existing buckets in this account: `propestate-photos`, `virtspace-assets` `[VERIFIED]`.
- CORS: not this phase (needed for Phase 4/5 uploads and the web viewer).

### Railway (CLI 5.26.0, logged in)
```bash
cd <repo root>
railway list --json                                   # find workspace id/name
railway init --name virtumetry --workspace "<ws>" --json   # creates project AND links cwd; capture .id
railway status --json                                 # assert id != 1690518b-f063-41df-8839-19c0b00a33a1
(cd .railway && npm ci)                               # IaC runner (railway-iac-ts)
railway config plan                                   # expect: create api, worker
railway config apply --yes
# variables: secrets via stdin, --skip-deploys until all set
neonctl cs production --project-id $P --pooled | tr -d '\r\n' | railway variable set DATABASE_URL --stdin -s api --skip-deploys
…same for worker; MIGRATE_DATABASE_URL (direct) on api only; S3_* ; plain values with KEY=VALUE…
railway domain -s api --json                          # generated *.up.railway.app
railway up -s api --ci -p <id> -e production -m "phase1 first deploy"
railway up -s worker --ci -p <id> -e production
railway logs -s api --lines 100 --json                # expect "[migrate] up to date"
curl -fsS https://<domain>/readyz
```
- `init` outside a TTY: "Use an exact workspace ID or name when running outside a terminal" `[VERIFIED: railway init --help]`.
- `up` respects `.gitignore` unless `--no-gitignore`, and `--ci` streams build logs then exits `[VERIFIED: railway up --help]`. Run it from the repo root, because the Dockerfile and build context are at the root.
- `variable set --stdin`, `--skip-deploys`, `-s`, `-e`, `-p` `[VERIFIED: help]`. `variable list --json/--kv` prints raw values, so never run it in agent output.
- `config plan/apply --yes --confirm-destructive --detailed-exit-code` `[VERIFIED: help]`.

**Railway variables (both services unless noted):**
| Var | api | worker | Value |
|-----|-----|--------|-------|
| SERVICE_ENTRY | server | worker | — |
| DATABASE_URL | ✓ | ✓ | prod **pooled** |
| MIGRATE_DATABASE_URL | ✓ | — | prod **direct** |
| AUTH_MODE / APPLE_BUNDLE_ID | apple / placeholder | apple / placeholder | No dev auth in prod. The bundle id isn't in `app.json` yet. Use a placeholder such as `com.virtumetry.app` `[ASSUMED]`; Phase 3 replaces it |
| STORAGE_DRIVER, S3_ENDPOINT, S3_REGION=auto, S3_BUCKET=virtumetry-prod, S3_ACCESS_KEY_ID, S3_SECRET_ACCESS_KEY | ✓ | ✓ | — |
| PROVIDER_MODE | mock | mock | — |
| TRUST_PROXY_HOPS | 2 | — | D-14 |
| NODE_ENV | (Dockerfile sets production) | same | — |
| DEV_AUTH_TOKEN, ALLOW_PAID_PROVIDER, SPAITIAL_*, CLOUDFLARE_API_TOKEN | **never set** | never | — |

Consequence: the deployed API has no working authenticated route in Phase 1 (apple mode with no app). The walking-skeleton write path is **local**: `npm run dev` against the Neon `dev` branch, then `curl -H "Authorization: Bearer $DEV_AUTH_TOKEN" -H "x-dev-user: owner" localhost:8080/v1/me/quota` upserts a `users` row (`auth.ts` → `upsertUserBySub`). On Railway, the migration itself is the real write.

### GitHub Actions
```yaml
# .github/workflows/backend.yml
name: backend
on:
  push:
    branches: [main]
    paths: ['backend/**', 'Dockerfile', '.dockerignore', '.github/workflows/backend.yml']
  pull_request:
    paths: ['backend/**', 'Dockerfile', '.dockerignore', '.github/workflows/backend.yml']
permissions: { contents: read }
concurrency: { group: backend-${{ github.ref }}, cancel-in-progress: true }
jobs:
  test:
    runs-on: ubuntu-latest
    defaults: { run: { working-directory: backend } }
    steps:
      - uses: actions/checkout@v7
      - uses: actions/setup-node@v7
        with: { node-version: 24, cache: npm, cache-dependency-path: backend/package-lock.json }
      - run: npm ci
      - run: npx tsc --noEmit
      - run: npx vitest run
        env:
          TEST_DATABASE_URL: ${{ secrets.TEST_DATABASE_URL }}   # empty → integration suites skip
```
```yaml
# .github/workflows/app.yml
name: app
on:
  push:
    branches: [main]
    paths: ['virtumetry/**', '.github/workflows/app.yml']
  pull_request:
    paths: ['virtumetry/**', '.github/workflows/app.yml']
permissions: { contents: read }
concurrency: { group: app-${{ github.ref }}, cancel-in-progress: true }
jobs:
  check:
    runs-on: ubuntu-latest
    defaults: { run: { working-directory: virtumetry } }
    steps:
      - uses: actions/checkout@v7
      - uses: actions/setup-node@v7
        with: { node-version: 22, cache: npm, cache-dependency-path: virtumetry/package-lock.json }
      - run: npm ci
      - run: printf '/// <reference types="expo/types" />\n' > expo-env.d.ts   # gitignored, generated by expo start
      - run: npx expo lint
      - run: npx tsc --noEmit
```
- Latest majors: `actions/checkout` v7.0.1, `actions/setup-node` v7.1.0 `[VERIFIED: gh api releases]`. Since setup-node v6, auto-cache is limited to npm. Keep explicit `cache: npm` + `cache-dependency-path` for subfolders.
- App node 22 matches the version where lint + tsc were verified locally. Node 24 would probably also work `[ASSUMED]`.
- Secret: `neonctl cs dev --project-id $P | tr -d '\r\n' | gh secret set TEST_DATABASE_URL -R mrbarnaclebot-ux/Virtumetry` (stdin, so the value never hits argv or the screen). Use the **direct** dev host.
- `gh` token scopes include `workflow`, which pushing `.github/workflows/*` requires `[VERIFIED: gh auth status]`.

## Common Pitfalls

### Pitfall 1: App `tsc` fails in CI
**What goes wrong:** `TS2307 Cannot find module './animated-icon.module.css'` and `TS2882 '@/global.css'`.
**Why:** `expo-env.d.ts` (`/// <reference types="expo/types" />`) is gitignored and only generated by `expo start`. I reproduced this by typechecking without it. With it present (and no `.expo/types/router.d.ts`), tsc exits 0 `[VERIFIED: local simulation]`.
**Avoid:** write the file in CI before `tsc` (app.yml above).

### Pitfall 2: Neon default branch is `main`
**What goes wrong:** the `dev --parent production` step fails, or the guard constants point at the wrong branch.
**Avoid:** `neonctl branches rename main production` right after create, then verify with `branches list`.

### Pitfall 3: Integration tests through the pooler
**What goes wrong:** `SET search_path` sticks to pgbouncer backends, which repeats the VirtSpace 2026-09-17 incident pattern (read-only prod).
**Avoid:** `TEST_DATABASE_URL` = dev **direct** host. Only `budget.ts`'s `pg_advisory_xact_lock` (transaction-scoped, safe in transaction mode) runs through the pooler `[VERIFIED: grep]`.

### Pitfall 4: Same Cloudflare account as VirtSpace
**What goes wrong:** the S3 key in `virtumetry/.env` may be account-wide, so it could write to `virtspace-assets`.
**Avoid:** the bucket guard (`/virtspace/i` refused; `virtumetry-prod` only in production). Recommend a bucket-scoped R2 token (Open Question 1).

### Pitfall 5: `railway init` in a non-TTY
**What goes wrong:** it hangs or errors when asked for a workspace.
**Avoid:** `--workspace <id|name> --json`. Get the workspace from `railway list --json`/`whoami`.

### Pitfall 6: IaC runner on Windows
**What goes wrong:** `railway config plan` can't find `railway-iac-ts` (on Windows the npm bin is `railway-iac-ts.cmd`).
**Avoid:** `cd .railway && npm ci` first. If it isn't found, pass `--runner .railway/node_modules/.bin/railway-iac-ts.cmd` or set `RAILWAY_IAC_TS_BIN` `[ASSUMED: untested on Windows]`. Last resort: create the services with `railway add` and set preDeploy/healthcheck in the dashboard, then `railway config pull` to bring the file in line.

### Pitfall 7: `railway up` uploads the app tree
**What goes wrong:** the copied `.railwayignore` excludes `VirtSpace/`, not `virtumetry/`, so the upload includes the whole Expo app and possibly `virtumetry/node_modules` (gitignored by `virtumetry/.gitignore`, but still large).
**Avoid:** rewrite `.railwayignore`/`.dockerignore` for this monorepo (Runtime State table).

### Pitfall 8: Guards break existing config tests
**What goes wrong:** existing tests boot `NODE_ENV=production` with `DATABASE_URL=postgres://u:p@localhost…`, no `MIGRATE_DATABASE_URL`, `DEV_AUTH_TOKEN` in `base`, and `S3_BUCKET: 'worlds'`.
**Avoid:** add a `prodBase` fixture (apple auth, no DEV_AUTH_TOKEN, matching direct + pooler fake Neon URLs, s3 with `virtumetry-prod`). Expect to rewrite about 8 of the 15 existing config cases.

### Pitfall 9: Secrets in tool output
**What goes wrong:** `neonctl projects create -o json`, `neonctl cs`, `railway variable list --json/--kv` all print credentials.
**Avoid:** always pipe through a parser that prints only ids/hosts, or straight into `--stdin`/files.

### Pitfall 10: Local Node 22 vs `engines >=24`
**What goes wrong:** nothing fails, but local results aren't from the CI runtime. `npm ci` on Node 22 only warns (no `engine-strict`), and the full suite passes on 22.21.1 `[VERIFIED]`.
**Avoid:** treat CI (Node 24) as authoritative. Optionally install Node 24 (`winget install OpenJS.NodeJS.LTS` if 24 is the current LTS `[ASSUMED]`). Not blocking.

### Pitfall 11: Git Bash quirks
- `\r` in values read from `.env` files created on Windows. Strip with `tr -d '\r'` (used above).
- MSYS path conversion mangles arguments that start with `/` (e.g. `--runner /c/...`). Use `C:/...` forms, or `MSYS_NO_PATHCONV=1`.
- `.gitattributes` has `* text=auto`. `railway up` uploads working-tree files, and nothing in the stripped image runs shell scripts from the repo (CMD is inline), so CRLF doesn't matter.

## Code Examples

### Boot-guard tests (vitest, extend `config.test.ts`)
```typescript
const PROD_EP = 'ep-prod-aaaa-11111111';            // test-only; real constant lives in src/isolation.ts
const pooled = (ep: string) => `postgres://u:p@${ep}-pooler.c-1.us-west-2.aws.neon.tech/neondb?sslmode=require`;
const direct = (ep: string) => `postgres://u:p@${ep}.c-1.us-west-2.aws.neon.tech/neondb?sslmode=require`;
const prodBase = { NODE_ENV: 'production', AUTH_MODE: 'apple', APPLE_BUNDLE_ID: 'x', DATABASE_URL: pooled(PROD_EP),
  MIGRATE_DATABASE_URL: direct(PROD_EP), STORAGE_DRIVER: 's3', S3_ENDPOINT: 'https://a.r2.cloudflarestorage.com',
  S3_BUCKET: 'virtumetry-prod', S3_ACCESS_KEY_ID: 'a', S3_SECRET_ACCESS_KEY: 'b' };

it('refuses PROVIDER_MODE=live without ALLOW_PAID_PROVIDER=1', ...);       // and 'true' is not '1'
it('boots live with ALLOW_PAID_PROVIDER=1 (non-prod)', ...);
it('refuses AUTH_MODE=dev in production (no escape hatch)', ...);
it('refuses DEV_AUTH_TOKEN set in production even with AUTH_MODE=apple', ...);
it('refuses the VirtSpace endpoint (pooled and direct) in any env', ...);   // ep-withered-paper-ajlntp59[-pooler].c-3.us-east-2…
it('refuses any us-east-2 Neon host', ...);
it('refuses the production endpoint when NODE_ENV is not production', ...);
it('production requires MIGRATE_DATABASE_URL, non-pooler, same endpoint', ...);
it('refuses virtspace buckets; refuses virtumetry-prod outside production', ...);
it('prodBase boots', ...);
```
Use `vi.mock`/injection or export the constant arrays so tests can override `VIRTUMETRY_PROD_ENDPOINT_IDS` (or test against the real committed value).

### Migrations folder sanity (FND-04 automated half)
```typescript
import { readFileSync, existsSync } from 'node:fs';
import { MIGRATIONS_FOLDER } from '../src/migrate.js';
it('every journal entry has its SQL file', () => {
  const j = JSON.parse(readFileSync(`${MIGRATIONS_FOLDER}/meta/_journal.json`, 'utf8'));
  expect(j.entries.length).toBeGreaterThan(0);
  for (const e of j.entries) expect(existsSync(`${MIGRATIONS_FOLDER}/${e.tag}.sql`)).toBe(true);
});
```

## State of the Art

| Old (VirtSpace) | Current (Virtumetry Phase 1) | Impact |
|-----------------|------------------------------|--------|
| `ALLOW_DEV_AUTH=1` in prod | No escape hatch. `DEV_AUTH_TOKEN` in prod refused | Railway runs apple mode with no working auth until Phase 3 |
| `MIGRATE_DATABASE_URL` optional with warning | Required + non-pooler in production | A misconfigured deploy fails at boot, not mid-migration |
| python3.13 + opencv image (trixie forced by numpy) | Plain node:24 slim | Smaller and faster builds |
| `actions/checkout@v4`, `setup-node@v4` | v7 / v7 | v4 used the Node 20 action runtime |
| 5 incremental migrations | Single fresh `0000_init` | Clean history |

## Assumptions Log

| # | Claim | Section | Risk if Wrong |
|---|-------|---------|---------------|
| A1 | `new URL('postgres://…')` exposes `hostname` correctly in Node | Pattern 1 | Guard parse fails. Tests catch it immediately; fall back to a regex on `@host` |
| A2 | Drizzle migrator table is `drizzle.__drizzle_migrations` | Pattern 2 | `/readyz` query errors. Check after the first local migrate |
| A3 | R2 `HeadObject` on a missing key returns HTTP 404 (`$metadata.httpStatusCode`), and bad credentials return 403 | Pattern 2 | readyz misreports. Adjust the check after the first call |
| A4 | Placeholder `APPLE_BUNDLE_ID` is acceptable until Phase 3 | Railway vars | None functionally (no client yet) |
| A5 | The IaC runner works on Windows, or `--runner` fixes it | Pitfall 6 | Fall back to `railway add` + dashboard |
| A6 | `variables: { managed: false }` is still accepted by railway 3.17 IaC | Pattern 5 | Plan errors, so remove it and verify no variable deletions in the plan |
| A7 | The current Cloudflare token has R2 write | R2 runbook | 403, so the owner adds the permission or creates the buckets in the dashboard |
| A8 | `neonctl cs` output may include `channel_binding=require`. node-postgres ignores or handles it | Neon | Connection error. Strip the param if seen |

## Open Questions

1. **Is the existing R2 access key scoped to specific buckets?**
   - Known: it's in the same account as `virtspace-assets`.
   - Unclear: its scope. Testing it would mean touching VirtSpace's bucket, which isn't allowed.
   - Recommendation: the owner creates an R2 API token in the dashboard, "Object Read & Write", limited to `virtumetry-dev` + `virtumetry-prod`, and uses that for `S3_*`. The code-level bucket guard ships regardless.
2. **SC2 says "deployed dev backend … dev R2 bucket", but D-06/D-09 put Railway on Neon `production` + `virtumetry-prod`.**
   - Recommendation: follow the locked decisions. Railway = production branch + prod bucket. "Dev backend" in SC2 means "pre-release". The local `npm run dev` path exercises the dev bucket + dev branch.
3. **"On every push" (FND-05) vs D-15 path filters.**
   - With filters, a docs-only push runs nothing. Recommendation: keep the D-15 filters (each workflow runs on every push that touches its tree). The verifier should read FND-05 that way.
4. **The `uploaded` status name.** The planner can choose any name (Phase 2 defines the processing states). It only needs to be a non-pipeline terminal state for Phase 1.

## Environment Availability

| Dependency | Required By | Available | Version | Fallback |
|------------|------------|-----------|---------|----------|
| Node | backend tests, app lint | ✓ | 22.21.1 (engines wants ≥24) | CI on 24 is authoritative. Tests pass on 22 |
| npm | all | ✓ | 10.9.4 | — |
| neonctl | Neon | ✓ (authed, org visible) | 2.26.6 | — |
| railway CLI | Railway | ✓ (logged in) | 5.26.0 | — |
| gh | secrets, push | ✓ (repo, workflow scopes) | 2.83.2 | — |
| curl | R2 | ✓ | Git Bash | — |
| wrangler | — | ✗ | — | REST (preferred anyway) |
| Docker daemon | local image test | ✗ (not running) | — | Railway remote build. `railway up --ci` streams the build log |
| psql | DB inspection | ✗ | — | `node -e` with `pg`, or `neonctl` + Neon SQL editor. Use `BEGIN READ ONLY … ROLLBACK` |

Nothing missing blocks execution.

## Validation Architecture

### Test Framework
| Property | Value |
|----------|-------|
| Framework | vitest 2.1.9 (backend). eslint via `expo lint` + tsc (app) |
| Config file | `backend/vitest.config.ts` (`include: ['test/**/*.test.ts']`) |
| Quick run command | `cd backend && npx vitest run test/config.test.ts` |
| Full suite command | `cd backend && npx tsc --noEmit && npx vitest run` ; `cd virtumetry && npx expo lint && npx tsc --noEmit` |

### Phase Requirements → Test Map
| Req ID | Behavior | Test Type | Automated Command | File Exists? |
|--------|----------|-----------|-------------------|-------------|
| FND-01 | Stripped backend typechecks + all suites pass. No stitcher/worldlabs/depth left | unit + grep | `npx tsc --noEmit && npx vitest run` ; `! grep -rniE "worldlabs\|stitch\|depth\.js\|python" backend/src backend/test Dockerfile .github` ; `grep -rni virtspace backend .railway Dockerfile .github` → only isolation denylist + its test | ✅ (existing suite, modified) |
| FND-01 | Fresh migration consistent | unit | `npx vitest run test/migrate-folder.test.ts` | ❌ Wave 0 |
| FND-02 | VirtSpace host/region/bucket refused. Prod endpoint refused outside prod | unit | `npx vitest run test/config.test.ts -t "VirtSpace\|production branch\|bucket"` | ❌ Wave 0 (add cases) |
| FND-02 | Deployed API answers on new infra | manual/CLI | `railway status --json` (id ≠ 1690518b…) ; `curl -fsS https://<api-domain>/readyz` → `{"status":"ready","migrations":1}` | — |
| FND-03 | live provider refused w/o `ALLOW_PAID_PROVIDER=1`. dev auth + `DEV_AUTH_TOKEN` refused in prod | unit | `npx vitest run test/config.test.ts -t "paid\|dev auth\|DEV_AUTH_TOKEN"` | ❌ Wave 0 (add cases) |
| FND-04 | Prod requires direct, same-endpoint migrate URL | unit | `npx vitest run test/config.test.ts -t "MIGRATE_DATABASE_URL"` | ❌ Wave 0 |
| FND-04 | Deploy ran migrations | CLI | `railway logs -s api --lines 200` contains `[migrate] up to date` ; `/readyz` migrations ≥ 1 | — |
| FND-04 | readyz reads DB, 503 on failure | unit | `npx vitest run test/readyz.test.ts` | ❌ Wave 0 |
| FND-05 | Both workflows green on push | CI | `gh run list -R mrbarnaclebot-ux/Virtumetry --limit 4` → backend + app `success` ; `gh run view <id> --log` shows the vitest summary | ❌ Wave 0 (workflows) |
| FND-05 | Integration suites run in CI when the secret exists | CI | CI log shows `queue.pg.test.ts` executed (not `↓ skipped`) | ✅ existing suites |

### Sampling Rate
- **Per task commit:** `cd backend && npx tsc --noEmit && npx vitest run` (~5 s locally)
- **Per wave merge:** the above + `cd virtumetry && npx expo lint && npx tsc --noEmit`
- **Phase gate:** CI green on `main` for both workflows + `/readyz` 200 on the Railway domain + migrate log line

### Wave 0 Gaps
- [ ] `backend/test/config.test.ts`: new guard cases + `prodBase` fixture
- [ ] `backend/test/migrate-folder.test.ts`: journal ↔ SQL consistency
- [ ] `backend/test/readyz.test.ts`: Fastify inject with fake db/storage (200 / 503)
- [ ] `.github/workflows/backend.yml`, `.github/workflows/app.yml`

## Security Domain

### Applicable ASVS Categories
| ASVS Category | Applies | Standard Control |
|---------------|---------|-----------------|
| V2 Authentication | yes (config only) | Dev-token auth refused in production. Apple JWT verify (jose) is kept but unused |
| V3 Session Management | no | Phase 3 (Better Auth) |
| V4 Access Control | yes (unchanged) | Existing per-owner `findOwnedWorld` checks |
| V5 Input Validation | yes | zod env schema + request schemas (existing) |
| V6 Cryptography | yes (unchanged) | `secretEquals` (SHA-256 + timingSafeEqual). TLS `verify-full` rewrite |
| V14 Configuration | yes (core of phase) | Fail-closed boot guards. Secrets only in Railway vars, `backend/.env`, GH secrets |

### Known Threat Patterns
| Pattern | STRIDE | Mitigation |
|---------|--------|------------|
| Config points at VirtSpace prod DB/bucket | Tampering / Info disclosure | Denylist (endpoint id + us-east-2 suffix + `virtspace` bucket) in `refine()` |
| Local dev writes to Virtumetry prod | Tampering | Prod endpoint refused when NODE_ENV≠production. `virtumetry-prod` bucket refused outside prod |
| Accidental paid provider call | Elevation (cost) | `ALLOW_PAID_PROVIDER=1` required. No live provider exists in this build anyway |
| Shared dev token in prod | Spoofing | AUTH_MODE=dev and DEV_AUTH_TOKEN refused in prod. No escape hatch |
| Migration race / pooler session state | DoS / Tampering | Direct host required in prod. Advisory lock. preDeploy on api only |
| Secrets in git/logs/agent output | Info disclosure | Root `.gitignore` `.env*`. Stdin piping. `/readyz` never echoes errors |
| Unauthenticated `/dev-storage` in prod | Info disclosure | Existing `STORAGE_DRIVER=local` refusal in prod (kept) |

## Sources

### Primary (HIGH confidence)
- VirtSpace source (read this session): `backend/src/{config,worker,migrate,server,auth}.ts`, `src/routes/{worlds,health,index}.ts`, `src/db/{schema,client,users}.ts`, `src/provider/*`, `src/storage/*`, `test/*`, `drizzle/*`, `Dockerfile`, `.railway/railway.ts`, `.github/workflows/backend.yml`, `HANDOFF.md`
- Local runs: VirtSpace suite on Node 22 (375 pass / 36 skip). `drizzle-kit generate` fresh 0000. App lint/tsc with and without `expo-env.d.ts`
- CLI help: `neonctl` 2.26.6 (`projects create`, `branches create/rename`, `connection-string`), `railway` 5.26.0 (`init`, `up`, `config plan/apply/init`, `variable set`, `domain`), `gh secret set`
- Read-only API: Neon projects list (VirtSpace `long-hat-19889473`, aws-us-east-2), VirtSpace endpoint host. Cloudflare token verify + R2 bucket list
- https://developers.cloudflare.com/api/resources/r2/subresources/buckets/methods/create/: R2 create bucket
- https://docs.railway.com/infrastructure-as-code.md, https://docs.railway.com/infrastructure-as-code/reference.md: IaC semantics, domains, preDeploy
- https://neon.com/docs/reference/cli-projects: create output contains connection_uris
- `gh api repos/actions/{checkout,setup-node}/releases`: v7 majors and breaking changes

### Secondary (MEDIUM confidence)
- https://neon.com/docs/manage/branches, https://neon.com/docs/changelog/2025-04-18: `main` for CLI/API projects vs `production` for Console (docs partly inconsistent; VirtSpace evidence agrees with `main`)

### Tertiary (LOW confidence)
- Behaviour of the Windows IaC runner bin, drizzle migrations table name, and R2 HeadObject status codes (all in the Assumptions Log)

## Metadata

**Confidence breakdown:**
- Code inventory / strip plan: HIGH (read every coupled file, ran the suite)
- Guards design: HIGH (extends the existing tested pattern. VirtSpace identifiers verified)
- Provisioning commands: MEDIUM-HIGH (help verified, nothing created)
- CI: HIGH (the app tsc failure reproduced and the fix verified locally)

**Research date:** 2026-11-23
**Valid until:** ~2026-12-23 (CLIs move fast; re-check `railway`/`neonctl` help if versions change)
