---
phase: 01-isolated-backend-fork
plan: 02
subsystem: infra
tags: [neon, r2, secrets, github-actions]
requires: []
provides:
  - "Neon project virtumetry (blue-star-06453943) with branches production (default) + dev"
  - "R2 buckets virtumetry-dev, virtumetry-prod"
  - "backend/.env (gitignored) with dev DB URLs and D-10 secret names"
  - "GH Actions secret TEST_DATABASE_URL (dev direct host)"
affects: [01-04, 01-05, 01-06]
tech-stack:
  added: []
  patterns: ["secrets only in backend/.env; app .env holds no backend secrets"]
key-files:
  created: [backend/.env (gitignored)]
  modified: [virtumetry/.env (deleted: all keys were backend secrets)]
decisions:
  - "Kept channel_binding=require in Neon URLs (A8); plan 01-04 migrate run confirms driver support"
  - "virtumetry/.env deleted because all 7 keys moved to backend/.env"
metrics:
  duration: ~10 min
  completed: 2026-11-23
---

# Phase 1 Plan 02: Isolated Infrastructure Provisioning Summary

A new Neon project `virtumetry` (aws-us-west-2) with `production` and `dev` branches, plus R2 buckets `virtumetry-dev`/`virtumetry-prod`. Backend secrets moved out of the Expo app into a gitignored `backend/.env`, and CI got a `TEST_DATABASE_URL` pointing at the dev direct host.

## Recorded IDs (non-secret)

| Item | Value |
|------|-------|
| Neon org | org-patient-pine-24176162 |
| Neon project id | `blue-star-06453943` (name `virtumetry`) |
| Region | aws-us-west-2 |
| Branches | `production` (default, renamed from `main`), `dev` (child of production) |
| Production endpoint id | `ep-cold-bread-arwg787p` (direct host `ep-cold-bread-arwg787p.c-4.us-west-2.aws.neon.tech`, pooler `ep-cold-bread-arwg787p-pooler.c-4.us-west-2.aws.neon.tech`) |
| Dev endpoint id | `ep-mute-fog-arwonnkz` (direct host `ep-mute-fog-arwonnkz.c-4.us-west-2.aws.neon.tech`, pooler `ep-mute-fog-arwonnkz-pooler.c-4.us-west-2.aws.neon.tech`) |
| R2 buckets created | `virtumetry-dev`, `virtumetry-prod` (locationHint `wnam`) |
| GH secret | `TEST_DATABASE_URL` on mrbarnaclebot-ux/Virtumetry = dev DIRECT URL (not pooled) |

Plan 01-05 should use `ep-cold-bread-arwg787p` as the production endpoint id constant.

## backend/.env contents (names only)

DATABASE_URL (dev pooled), MIGRATE_DATABASE_URL (dev direct), SPAITIAL_API_KEY, SPAITIAL_WEBHOOK_SECRET, CLOUDFLARE_API_TOKEN, CLOUDFLARE_ACCOUNT_ID, S3_ACCESS_KEY_ID, S3_SECRET_ACCESS_KEY, S3_ENDPOINT, S3_REGION=auto, S3_BUCKET=virtumetry-dev, STORAGE_DRIVER=s3, PROVIDER_MODE=mock, AUTH_MODE=dev, DEV_AUTH_TOKEN (fresh random 24-byte hex). NODE_ENV is not set. Both Neon URLs include `channel_binding=require`.

Ignored by the root `.gitignore:1:.env` rule (`git check-ignore` confirmed).

## Verification

- `neonctl branches list` returned `dev,production*`
- `DATABASE_URL` contains `-pooler`; `MIGRATE_DATABASE_URL` does not
- The Task 2 verify printed no `MISSING` lines and printed `app-env-clean`; `virtumetry/.env` no longer exists
- `npx expo lint` output mentions spAItial/CLOUDFLARE 0 times
- R2 listing: propestate-photos, virtspace-assets, virtumetry-dev, virtumetry-prod. Only the two new buckets were created. Nothing pre-existing was modified.
- VirtSpace Neon project `long-hat-19889473` was not touched. It appeared only in the read-only project list.

## Follow-up (manual, non-blocking)

The S3 key in backend/.env works for the whole R2 account and can reach `virtspace-assets` and `propestate-photos`. The owner should create an R2 API token scoped to `virtumetry-dev` + `virtumetry-prod` only (Object Read & Write), then put it into `S3_ACCESS_KEY_ID`/`S3_SECRET_ACCESS_KEY`. The code-level bucket guard from plan 01-05 ships either way.

## Deviations from Plan

None. The plan ran exactly as written. Per orchestrator instructions, nothing was committed and STATE.md/ROADMAP.md were not edited.

## Self-Check: PASSED

- backend/.env exists and is ignored; Neon branches, R2 buckets and the GH secret were all confirmed in live listings. No task commits (per instruction).
