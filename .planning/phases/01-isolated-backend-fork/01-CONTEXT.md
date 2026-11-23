# Phase 1: Isolated Backend Fork - Context

**Gathered:** 2026-11-23
**Status:** Ready for planning

<domain>
## Phase Boundary

A working Virtumetry backend runs from `backend/` in the monorepo — a copy of the VirtSpace backend with the stitcher, World Labs provider and depth pipeline removed — on its own new Neon database, Railway project and R2 buckets, with CI on GitHub Actions, migrations on deploy over the direct Neon host, and boot guards so it can never spend money (paid provider) or accept dev-token auth in production by accident. Requirements: FND-01..05.

Not in this phase: Echo-3 provider, bundle pipeline, session format, Better Auth, app changes (Phases 2–3).

</domain>

<decisions>
## Implementation Decisions

### Copy & strip scope
- **D-01:** Copy VirtSpace `backend/` (src, test, drizzle, package.json, package-lock.json, tsconfig, vitest config, drizzle.config.ts, README.md, .env.example) plus repo-root `Dockerfile`, `.dockerignore`, `.railwayignore`, `.railway/` (IaC) and `.github/workflows/backend.yml` into the Virtumetry monorepo. Copy verbatim first (one commit), then strip in separate commits so the diff is reviewable.
- **D-02:** Remove: `backend/stitcher/` (Python) and its tests (`stitcher.*.test.ts`), `src/depth.ts`, `src/provider/worldlabs.ts` and its tests (`worldlabs*.test.ts`), stitch/generate_draft/generate_hq job kinds and the pano/enhance routes that only serve World Labs. Python, numpy, opencv and the venv leave the Dockerfile and CI (image becomes plain `node:24-*-slim`; no python setup step in CI).
- **D-03:** Keep: Fastify server, routes/health, auth (jose dev + Apple verify code paths — real auth replaced in Phase 3), Postgres job queue with leases, worker skeleton (purge + reaper), quotas/budget/throttle/rate-limit, storage drivers (local + s3), push module (dormant until Phase 7), provider interface `src/provider/types.ts` + `mock.ts` (generalized in Phase 2), graceful shutdown, zod contracts, migrate.ts.
- **D-04:** Rename VirtSpace identifiers (package name, project name `virtspace` in IaC, DB names, log prefixes, `VirtSpace <jobId>` strings) to Virtumetry. Do NOT bump dependency versions during the copy (vitest/TS/zod stay as in VirtSpace).
- **D-05:** Database schema: start a fresh migration history for Virtumetry (new `drizzle/0000_*` generated from the stripped schema) rather than replaying VirtSpace's 5 migrations that include World Labs/pano columns. Columns/tables that only served World Labs/stitching are dropped from `schema.ts`.

### Neon topology
- **D-06:** One new Neon project `virtumetry` (via `neonctl --org-id org-patient-pine-24176162`), region close to Railway (us-west-2 / aws-us-west-2 to match Railway `us-west2`). Branches: `production` (default) and `dev` (child). Local dev and CI-integration use `dev`; Railway uses `production`.
- **D-07:** Two connection strings per branch: pooled (`-pooler` host) as `DATABASE_URL` for the app, direct host as `MIGRATE_DATABASE_URL` for migrations. Never issue session-level `SET` through the pooler.
- **D-08:** Isolation guard (FND-02): config refuses to boot when the DATABASE_URL / MIGRATE_DATABASE_URL host matches a known VirtSpace host or when `NODE_ENV!=production` and the URL points at the `production` branch endpoint. Implement as an explicit denylist + branch-endpoint check with a unit test. Also refuse S3 bucket names containing `virtspace`.

### R2 + secrets layout
- **D-09:** Two new R2 buckets: `virtumetry-dev` and `virtumetry-prod` (created via Cloudflare API/wrangler with the owner's account token). Same access key may be used for both in v1, but bucket names are environment-specific and the prod bucket is only configured on Railway.
- **D-10:** Backend secrets move out of `virtumetry/.env` into a gitignored `backend/.env` with normalized names: `SPAITIAL_API_KEY`, `SPAITIAL_WEBHOOK_SECRET`, `S3_ENDPOINT`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY`, `S3_BUCKET`, `S3_REGION=auto`, `CLOUDFLARE_ACCOUNT_ID`, `CLOUDFLARE_API_TOKEN`. After copying, remove those keys from `virtumetry/.env` (the app never holds backend secrets). Never print secret values in logs or tool output. `.env.example` documents every variable with placeholders.
- **D-11:** SpAItial keys are stored now but unused until Phase 6; `PROVIDER_MODE=mock` default.

### Paid-provider & dev-auth guards
- **D-12:** FND-03: boot refuses `PROVIDER_MODE=live` (any paid provider) unless `ALLOW_PAID_PROVIDER=1`; refuses `AUTH_MODE=dev` when `NODE_ENV=production` (keep VirtSpace's existing guard but drop the `ALLOW_DEV_AUTH` escape hatch, or keep it test-only). Both covered by boot tests.

### Railway topology & deploy
- **D-13:** New Railway project `virtumetry` (never VirtSpace's `1690518b-…`), services `api` and `worker` from the same Dockerfile, `SERVICE_ENTRY` picks the entrypoint; IaC in `.railway/railway.ts` (whole-project file — omitted resources are deleted on apply). `preDeploy: node dist/migrate.js` on api only with `MIGRATE_DATABASE_URL` set to the direct production host. Healthcheck `/healthz`.
- **D-14:** Deploy is not GitHub-linked; deploy with `railway up` from a clean tree. A first deploy to the NEW project is approved for this phase (needed to prove FND-04). Variables set via `railway variables` (unmanaged in IaC). `TRUST_PROXY_HOPS=2` on Railway.

### CI & push
- **D-15:** GitHub Actions in the existing private repo `github.com/mrbarnaclebot-ux/Virtumetry`: workflow `backend.yml` (paths `backend/**`): `npm ci`, `tsc --noEmit`, `vitest run` (no Python). Add `app.yml` (paths `virtumetry/**`): `npm ci`, `npx expo lint`, `npx tsc --noEmit`. Postgres integration suites run only when a `TEST_DATABASE_URL` secret (Neon `dev` branch) is present; otherwise skipped.
- **D-16:** Pushing commits to `origin main` of the owner's private repo is part of verifying FND-05. Never push secrets; check `git diff --cached` for `.env` before each commit.

### Claude's Discretion
- Exact list of routes/tables to delete vs keep where they're World-Labs-only (planner decides from code).
- Whether to keep the reaper/purge jobs now or stub them.
- Node base image variant (trixie-slim vs bookworm-slim) once Python is gone.

</decisions>

<canonical_refs>
## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### Project scope
- `.planning/PROJECT.md` — constraints (isolation, money, Windows/EAS), key decisions
- `.planning/REQUIREMENTS.md` — FND-01..05
- `.planning/ROADMAP.md` — Phase 1 goal + success criteria
- `.planning/research/SUMMARY.md` — Phase 1 rationale, pitfalls P11/P12
- `.planning/research/PITFALLS.md` — prod isolation, Neon pooler incident, migrations
- `.planning/research/ARCHITECTURE.md` — monorepo layout, backend component boundaries
- `.planning/research/STACK.md` — "don't upgrade vitest/TS during the copy"

### VirtSpace source (copy origin, read-only)
- `C:\Users\Uzi\AppData\Local\Temp\claude\346e7b72b18422cf\afe0a28c-1f6a-46dc-ae5e-46bf841ce786\scratchpad\virtspace-src\VirtSpace\backend\` — backend to copy (README.md documents every subsystem)
- `…\VirtSpace\HANDOFF.md` §"Deploy (Railway) — how it actually works", §"Standing rules learned the hard way"
- `…\VirtSpace\.railway\railway.ts`, `…\VirtSpace\Dockerfile`, `…\VirtSpace\.github\workflows\backend.yml`
- `…\VirtSpace\backend\.env.example` — every env var and its guard

### App rules
- `virtumetry/AGENTS.md` — EAS free-plan rules; lint + typecheck before done
- `CLAUDE.md` — project guide

</canonical_refs>

<code_context>
## Existing Code Insights

### Reusable Assets
- VirtSpace `src/config.ts`: zod-validated env with production refusals (`AUTH_MODE=dev`, `STORAGE_DRIVER=local`) — extend for paid-provider + isolation guards.
- `src/queue.ts` (Postgres leases, attempts cap), `src/budget.ts` / `src/quota.ts` (atomic reservations), `src/storage/s3.ts` (R2 presign), `src/migrate.ts` (advisory lock, direct host), `test/config.test.ts`, `test/shutdown.test.ts`, integration suites gated on `TEST_DATABASE_URL`.
- `.railway/railway.ts` IaC + Dockerfile multi-stage pattern.

### Established Patterns
- Conventional Commits with scope; tests before commit; mock provider is default.
- Single image, `SERVICE_ENTRY` selects server/worker.

### Integration Points
- Monorepo root `C:\Users\Uzi\Documents\GitHub\Virtumetry`: `backend/` new, `virtumetry/` app untouched except removing backend secrets from `virtumetry/.env`, root `Dockerfile`/`.railway/`/`.github/`.
- Windows host: commands must work in Git Bash; `neonctl` needs `--org-id`.

</code_context>

<specifics>
## Specific Ideas

- Owner explicitly asked to use the `railway` and `neonctl` CLIs and the Cloudflare keys already in `virtumetry/.env`.
- Creating the new Neon project, Railway project and R2 buckets is pre-approved; touching any existing cloud resource (especially VirtSpace's) is not.

</specifics>

<deferred>
## Deferred Ideas

- Better Auth replacing the jose/Apple auth paths — Phase 3.
- Generalized ReconProvider + Echo-3 mock — Phase 2; live Echo-3 — Phase 6.
- Push notifications (APNs key) — Phase 7.
- R2 lifecycle/retention rules — Phase 9.

</deferred>

---

*Phase: 01-isolated-backend-fork*
*Context gathered: 2026-11-23*
