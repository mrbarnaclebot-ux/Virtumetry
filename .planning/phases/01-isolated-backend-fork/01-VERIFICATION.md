---
phase: 01-isolated-backend-fork
verified: 2026-11-23T00:00:00Z
status: passed
score: 4/4 roadmap truths verified (SC1 CI green: runs 45150189343 backend 241/241, 45150189815 app)
---

# Phase 1: Isolated Backend Fork Verification

**Goal:** A working Virtumetry backend runs from `backend/` on separate infrastructure and cannot spend money or accept dev auth by accident.

## Truths

| # | Truth | Status | Evidence |
|---|-------|--------|----------|
| 1 | Forked backend, stripped, passes the suite, with CI on push | PARTIAL (human) | `cd backend && npx tsc --noEmit` is clean. `npx vitest run` gives 27 files passed and 229 tests passed. 12 integration tests are skipped without a DB, and the owner reports 241/241 against Neon dev. No stitcher, World Labs or depth files remain in `backend/src`. `.github/workflows/backend.yml` runs tsc and vitest. `app.yml` runs `expo lint` and `tsc --noEmit`, both with correct paths. The latest runs failed after 4s, which is the billing hold. |
| 2 | Deployed dev backend health-checks against new Neon and dev R2, and nothing points to VirtSpace | VERIFIED | `curl /readyz` returned `{"status":"ready","migrations":1}`. `/readyz` reads `drizzle.__drizzle_migrations` and HEADs storage (`routes/health.ts`). `railway status` shows project 162ef8a1-… and not 1690518b. `isolation.ts` and `config.ts` refine() deny the VirtSpace Neon endpoint, the us-east-2 host suffix and any bucket name containing "virtspace". Production needs `S3_BUCKET=virtumetry-prod`. `config.test.ts` has 31 tests. No "virtspace" strings remain outside `isolation.ts`. |
| 3 | Server refuses Echo-3 without ALLOW_PAID_PROVIDER=1, and refuses to boot in production with dev auth | VERIFIED | `config.ts:142` refuses `PROVIDER_MODE=live` unless `ALLOW_PAID_PROVIDER === '1'`. The check is strict, and `config.test.ts` covers a value of `'true'`. Lines 164-170 refuse `AUTH_MODE=dev` and `DEV_AUTH_TOKEN` under `NODE_ENV=production`. Both guards are in the zod refine, so they cover server, worker and migrate. |
| 4 | Deploy runs migrations automatically over the direct Neon host | VERIFIED | `.railway/railway.ts` sets `preDeploy: "node dist/migrate.js"` on api only. `config.ts:176-204` refuses a pooler `MIGRATE_DATABASE_URL`, and refuses production without one (`migrateUrl`). `migrate.ts` takes an advisory lock and exits non-zero on failure. `/readyz` shows migrations=1 on the deployed service. |

## Requirements

| Req | Status | Note |
|-----|--------|------|
| FND-01 | SATISFIED | Copy is stripped and tests pass locally. CI evidence is pending (see FND-05). |
| FND-02 | SATISFIED | Own Neon and Railway project, isolation denylists, and a prod/dev bucket split. |
| FND-03 | SATISFIED | Guards are in code and unit-tested. |
| FND-04 | SATISFIED | preDeploy over the direct host, enforced in config and tested. |
| FND-05 | HUMAN_NEEDED | Workflow files are correct. A green run is blocked by the billing hold. |

## Anti-patterns
None found in the files checked.

## Gaps
No code gaps. The only open item is confirming a green GitHub Actions run once billing is resolved.


## CI resolved (2026-11-23)

The repo was made public, which removed the billing hold. Reruns passed: backend run 45150189343 (tsc + vitest, 241/241 including queue.pg and quota.pg) and app run 45150189815 (expo lint + tsc). FND-05 is proven; status is now `passed`.
