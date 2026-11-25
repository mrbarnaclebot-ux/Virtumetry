---
phase: 06-live-echo-3-provider
plan: 08
subsystem: deploy
tags: [railway-dev, mock-mode, uat, runbook, money-path]
requires: [06-01..06-07]
provides: [Phase 6 backend on Railway dev (mock), 06-HUMAN-UAT.md (paid-run runbook + $0 Expo Go checklist)]
affects: [owner UAT, Phase 6 verification, first paid run (owner-only)]
tech-stack:
  added: []
  patterns: [count-only / word-only Railway variable checks (no --json/--kv)]
key-files:
  created:
    - .planning/phases/06-live-echo-3-provider/06-HUMAN-UAT.md
  modified: []
decisions:
  - "Runbook sets live vars with one `railway variable set --skip-deploys` per service plus `railway redeploy` on both (CLI 5.75 has set/delete/redeploy), and reverts with `variable delete` on both"
  - "fixture:e2e refuses PROVIDER_MODE != mock, so the runbook's tiny-fixture paid option says to start from the app or ask for a one-off live variant, instead of documenting a command that would refuse"
metrics:
  duration: ~25 min (test:pg alone ~10.5 min)
  completed: 2026-11-25
---

# Phase 6 Plan 08: Mock-mode deploy to dev + paid-run runbook Summary

Phase 6 (live Echo-3 provider, retry, budget alert) now runs on Railway dev in mock mode. The owner has 06-HUMAN-UAT.md with a $0 Expo Go checklist for retry and the budget banner, and a copy-paste paid-run runbook that no agent ran.

## Tasks

| Task | Commit | Notes |
|------|--------|-------|
| 1 Gates + deploy + smoke | (no repo files) | Railway dev state only |
| 2 06-HUMAN-UAT.md | b8ac9c3 | runbook (a)-(i), R1-R6, B1-B3, Z, pending list |

## Task 1: gates, deploy, smoke

Money check: `grep -rnE "^(PROVIDER_MODE=live|ALLOW_PAID_PROVIDER=)" backend/.env backend/.env.example .github` gave 0 matches (count only).

Gates (at d781fba):
- virtumetry: `expo lint` ok, `tsc --noEmit` ok, `jest --ci` 30 suites / 341 tests passed
- backend: `tsc --noEmit` ok, `vitest run` 511 passed (164 skipped pg), `npm run test:pg` 18 files / 178 tests passed (1 skipped)

Deploy: commit **d781fba** from a clean tree (`git status --porcelain -- . ':!.planning'` empty), from the repo root:
- `railway up -s api -e dev -p 162ef8a1-afac-4a01-8253-4e3f75d8b3b3 --ci -m "phase 6 live provider (mock mode)"` → `Deploy complete`
- `railway up -s worker -e dev -p 162ef8a1-afac-4a01-8253-4e3f75d8b3b3 --ci -m "phase 6 live provider (mock mode)"` → `Deploy complete`
- api deploy log: `[migrate] applying migrations from /app/drizzle` → `[migrate] up to date` (0005 was already applied to Neon dev by 06-02's migrate:dev), then `Server listening … :8080`
- worker log: `[worker] … started; kinds=pack,submit,track,purge poll=2000ms`
- Variable check by key name only (plain `variable list` piped to `grep -o`, values never printed): both services have `PROVIDER_MODE` = `mock`, and no `ALLOW_PAID_PROVIDER` or `SPAITIAL_*`.

Smoke:
- `curl -m 20 …/healthz` → `{"status":"ok"}`
- `GET /v1/worlds` without auth → `401`
- `npm run fixture:e2e -- --remote`: packing → submitting → processing → importing → **ready** in 84 s, credits 930 (mock). Assets were thumbnail, splat, collider, floorplan json/png and cameras. Purged afterwards (0 objects left). $0.

Production: unchanged. PROVIDER_MODE=live / ALLOW_PAID_PROVIDER: set nowhere. No Railway variables changed.

## Task 2: 06-HUMAN-UAT.md

- **Setup:** deployed SHA, services, migration 0005, "Production: unchanged. Paid provider: off everywhere."
- **$0 checks:** R1-R6 (MOCK_SCENARIO failed / happy / 409, with exact `railway variable set … -s worker -e dev -p …` lines). The copy is taken from 06-UI-SPEC plus the WR-08 retryable headline. B1-B3 cover the budget banner (`budget:reset-dev`, DAILY_CREDIT_BUDGET=1100 on both services → 84%, `[budget-alert]` + `[push:stub]`, dismiss, restore). Z checks that everything is restored.
- **Runbook:**
  - (a) A-07 input recommendation and the "900-credit base dominates" line
  - (b) preconditions
  - (c) live vars on both services with `<paste>` placeholders, plus the boot guards
  - (d) run
  - (e) watch, with read-only SQL for worlds, credit_events, webhook_deliveries and budget_alerts
  - (f) exactly-once checklist and `npm run record:echo3 <worldId>`
  - (g) abort via delete → provider cancel, plus the review-fix error behaviours (503 `quote_unavailable` / 502 `quote_failed`, `PROVIDER_AUTH`, `SUBMIT_UNCERTAIN`)
  - (h) revert to mock
  - (i) the four SpAItial questions
- **Pending:** SC2 live half and SC4 live alert, both owner-only.

## Deviations from Plan

1. **[Accuracy] Setup row:** the plan assumed `PROVIDER_MODE` was unset on dev. The key-name check found `PROVIDER_MODE=mock` already set explicitly on both services from an earlier phase. The UAT says so. Nothing was changed.
2. **[Accuracy] Tiny-fixture paid option:** `fixture-e2e.ts` hard-refuses when `PROVIDER_MODE` isn't mock, so `npm run fixture:e2e -- --remote` can't start a paid run. The runbook notes this and doesn't present it as a working paid command.
3. **Task 1 has no commit:** it produced no repo files, as the plan states.

## Known Stubs

None.

## Threat Flags

None. T-06-35..39 were handled as planned: no variable changes, every railway command carried `-e dev -p 162ef8a1-…`, no `--json`/`--kv`, the UAT uses placeholders only and passed the secret grep, and vars are set and reverted on both services.

## Self-Check: PASSED

- 06-HUMAN-UAT.md exists. Commit b8ac9c3 found. The UAT grep gate passed (ALLOW_PAID_PROVIDER=1, record:echo3, MOCK_SCENARIO=failed, Revert to mock; no connection strings or keys).
- STATE.md / ROADMAP.md / REQUIREMENTS.md not modified. Not pushed.
