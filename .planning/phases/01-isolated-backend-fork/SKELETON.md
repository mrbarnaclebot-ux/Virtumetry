# Walking Skeleton — Virtumetry

**Phase:** 1
**Generated:** 2026-11-23

## Capability Proven End-to-End

The owner's Virtumetry backend runs on its own Railway project, migrates its own Neon database on deploy, and answers `/readyz` with a real DB read. The same code, run locally against the Neon `dev` branch and the `virtumetry-dev` bucket, takes an authenticated request that writes a user and a world row. It cannot reach VirtSpace, spend money, or accept dev auth in production. CI checks every push.

**As the** owner, **I want to** have a Virtumetry backend running on its own infrastructure behind fail-closed guards, **so that** I can build the scan-to-world loop without risking VirtSpace production or a surprise Echo-3 bill.

## Architectural Decisions

| Decision | Choice | Rationale |
|---|---|---|
| Repo layout | Monorepo: `backend/` (Node API + worker), `virtumetry/` (Expo app), root `Dockerfile`, `.railway/`, `.github/workflows/` | One repo, one CI. The app never holds backend secrets (D-10) |
| Backend framework | Fastify 5 + zod env/contracts, TypeScript, ESM, Node 24 (copied from VirtSpace, no version bumps) | Proven code. Fork and strip, don't rewrite (D-01, D-04) |
| Data layer | Neon Postgres project `virtumetry` (aws-us-west-2), branches `production` + `dev`. Drizzle ORM 0.45, fresh `0000_init` history | Isolation from VirtSpace. Clean history (D-05, D-06) |
| Connections | App: pooled `-pooler` `DATABASE_URL`. Migrations: direct `MIGRATE_DATABASE_URL`. No session `SET` through the pooler | Neon pooler incident lesson (D-07) |
| Migrations | `node dist/migrate.js` (drizzle migrator + advisory lock) as Railway `preDeploy` on api only. Never `drizzle-kit push` | One migrator per release, over the direct host (D-13, FND-04) |
| Jobs | Postgres queue with leases in the same DB. Worker service claims `purge`, runs reapers | No Redis. Phase 2 adds pipeline kinds |
| Object storage | Cloudflare R2 via S3 driver: `virtumetry-dev` (local/CI), `virtumetry-prod` (Railway only) | Env-specific buckets (D-09) |
| Provider | `PROVIDER_MODE=mock` by default. `live` refused without `ALLOW_PAID_PROVIDER=1`. No live client exists until Phase 6 | Money safety (D-11, D-12) |
| Auth | Kept from VirtSpace: jose dev-token (local/tests only) + Apple verify. `AUTH_MODE=dev` and `DEV_AUTH_TOKEN` refused in production | Replaced by Better Auth in Phase 3 (D-03, D-12) |
| Boot guards | All in `config.ts` `refine()` + `src/isolation.ts`, so server, worker and migrate share one choke point | VirtSpace denylist, prod endpoint/bucket outside prod, paid provider, dev auth, direct migrate URL (D-08) |
| Health | `/healthz` liveness (no deps). `/readyz` reads `drizzle.__drizzle_migrations` + probes storage, used as the Railway healthcheck | A deploy fails instead of serving a broken DB |
| Deployment | Railway project `virtumetry`, services `api` + `worker` from one Dockerfile (`node:24-trixie-slim`), `SERVICE_ENTRY` picks the entry. IaC in `.railway/railway.ts`, variables unmanaged. `railway up` from a clean tree, not GitHub-linked | D-13, D-14 |
| Secrets | `backend/.env` (gitignored) locally, Railway variables in prod, GH secret `TEST_DATABASE_URL` (dev direct) in CI. Always piped via stdin, never printed | D-10, D-15 |
| CI | GitHub Actions: `backend.yml` (npm ci, tsc, vitest, Node 24, integration suites when the secret exists) and `app.yml` (npm ci, expo lint, tsc), path-filtered | Not EAS CI minutes (D-15, FND-05) |

## Stack Touched in Phase 1

- [ ] Project scaffold: `backend/` builds (tsc), tests (vitest), CI workflows for backend + app (plans 01-01, 01-03, 01-04, 01-07)
- [ ] Routing: `/healthz`, `/readyz`, plus the kept `/v1/me/quota` and `/v1/worlds` routes (plan 01-05)
- [ ] Database: real read (`/readyz` migrations count, local + Railway) AND real write (local dev-auth request upserts a `users` row and creates a `worlds` row on Neon `dev`; Railway's preDeploy migration writes the schema) (plans 01-04, 01-05, 01-06)
- [ ] UI: not in this phase. Backend-only skeleton by roadmap design. The app shell and its first API call come in Phase 3
- [ ] Deployment: api + worker live on the new Railway project, `/readyz` 200 on the generated domain (plan 01-06). Per D-06/D-09 the deployed api uses Neon `production` + `virtumetry-prod`; dev branch + `virtumetry-dev` are proven by the local run (01-05) and CI (01-07)

## Out of Scope (Deferred to Later Slices)

- Echo-3 provider (mock generalisation in Phase 2, live in Phase 6), bundle pipeline, session format
- Better Auth, email login, Sign in with Apple in the app (Phases 3, 8). The deployed api has no working authenticated route until Phase 3
- Any app UI or app → API call (Phase 3)
- Push notifications / APNs (Phase 7)
- R2 CORS (Phases 4/5), R2 lifecycle/retention rules (Phase 9)
- Upgrading vitest/TS/zod (separate commit after the phase)
- Bucket-scoped R2 token (owner follow-up, non-blocking)

## Subsequent Slice Plan

Each later phase adds one vertical slice on top of this skeleton without changing its architectural decisions:

- Phase 2: a recorded fixture session is packed into an Echo-3 bundle on R2 and runs through the mock provider to a ready world
- Phase 3: the owner logs in in Expo Go and sees their scan library
- Phase 4: fixture capture → check → quote → approve → upload → mock process → ready, in Expo Go
- Phase 5: walk, measure and share a ready world in the app and the browser
- Phase 6: one approved scan on live Echo-3, exactly once, within budget
- Phase 7: native build readiness (macOS CI, EAS dev build, push, crash reporting)
- Phase 8: native ARKit capture + Sign in with Apple
- Phase 9: retention/purge hardening + on-device upload survival
