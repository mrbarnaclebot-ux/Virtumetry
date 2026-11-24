---
phase: 03-owner-account-scan-library
plan: 09
status: checkpoint-pending-owner
subsystem: app-config
tags: [eas, env, build-profiles, expo-go, uat]
requires: [03-07, 03-08]
provides:
  - "eas.json development/preview -> Railway dev, production -> Railway prod"
  - "Committed virtumetry/.env.development so Expo Go targets Railway dev with zero setup"
  - "Jest proof (SC5) that every profile resolves and dev/preview refuse the production URL"
  - "README 'Test on your iPhone (Phase 3)' checklist + 03-HUMAN-UAT.md"
affects: []
tech-stack:
  added: []
  patterns: ["Profile config tested by reading eas.json and .env.development from jest"]
key-files:
  created:
    - virtumetry/eas.json
    - virtumetry/.env.development
    - .planning/phases/03-owner-account-scan-library/03-HUMAN-UAT.md
  modified:
    - .gitignore
    - virtumetry/.gitignore
    - virtumetry/README.md
    - virtumetry/src/__tests__/api-config.test.ts
    - virtumetry/src/__tests__/library-actions.test.tsx
decisions:
  - "No developmentClient flag in eas.json yet: expo-dev-client isn't installed, so the native capture phase adds both together"
  - "A local backend override goes in .env.development.local (already gitignored) and isn't committed"
metrics:
  duration: ~15min
  completed: 2026-11-24
  tasks: "1/2 (Task 2 pending owner)"
  files: 7
---

# Phase 3 Plan 09: Build profiles + iPhone checklist Summary

Each build profile now points at its own backend. Expo Go uses Railway dev with no setup, through the committed `.env.development`, which holds public values only. Jest proves that development and preview can't reach production. The owner has a step-by-step phone checklist. **The on-device check (Task 2) is pending owner verification**, because the owner wasn't available during this run. Approval was not assumed.

## Commits

| Task | Commit | Message |
|------|--------|---------|
| 1 (RED) | a47518c | test(03-09): add failing build-profile tests for eas.json and .env.development |
| 1 (Rule 3) | 559a8dd | fix(03-09): wait for the optimistic delete row removal in library-actions test |
| 1 (GREEN) | 31158c9 | feat(03-09): build profiles, committed dev env and the iPhone checklist |
| 2 | — | checkpoint:human-verify: **pending owner** (see 03-HUMAN-UAT.md) |

## Evidence

- `npx jest --ci`: 7 suites, 99 tests passed (api-config adds 7 profile tests)
- `npx expo lint` clean; `npx tsc --noEmit` clean; `npx expo-doctor`: 20/20 checks passed
- `git check-ignore -q virtumetry/.env` exits 0; `git check-ignore -q virtumetry/.env.development` exits 1 (tracked)
- The production URL appears once in eas.json and 0 times in .env.development. .env.development has no keys other than the two EXPO_PUBLIC_* vars. The email-domain `git grep` finds nothing.
- `eas build` was not run. No dependency was added.

## Pending owner verification (Task 2)

Owner steps are in `virtumetry/README.md`, under "Test on your iPhone (Phase 3)". Do setup steps 1-6 first: backend/.env OWNER_EMAIL/OWNER_ALLOWLIST, `npm run owner:create`, `railway variable set OWNER_ALLOWLIST=<your-email> -e dev -s api`, optional `npm run seed:library`, Expo Go, and `npx expo start` (or `--tunnel`). Then run the 7 on-device checks tracked in `03-HUMAN-UAT.md`: login, rejected login, the library states, rename, delete, force-quit persistence, and logout. Reply "approved", or list the failing step numbers with the on-screen text.

## Deviations from Plan

**1. [Rule 3 - Blocking] Flaky optimistic-delete test**
- **Found during:** Task 1 full jest run
- **Issue:** In `library-actions.test.tsx`, "removes the row before the DELETE resolves" failed 2 of 5 runs, with or without the new env file. `onMutate` awaits `cancelQueries` before it removes the row, so the synchronous `queryByText` raced the re-render.
- **Fix:** Wrapped that assertion in `waitFor`. The DELETE promise is still unresolved during the wait, so the test still proves the optimistic removal. It then passed 4 of 4 in isolation and in the full suite.
- **Commit:** 559a8dd

**2. Test uses local type shims for fs/path**
- The app has no `@types/node`, and the plan allows no new dependencies. The test declares minimal `readFileSync` and `join` shapes plus `__dirname`.

**3. No `developmentClient: true` in the development profile**
- `expo-dev-client` isn't installed, so it gets added together with that package in the native capture phase.

## Known Stubs

None.

## Threat Flags

None. T-03-44, T-03-45 and T-03-46 are mitigated by the grep and check-ignore gates and the jest profile test.

## Self-Check: PASSED

- FOUND: eas.json, .env.development, 03-HUMAN-UAT.md
- FOUND commits: a47518c, 559a8dd, 31158c9
- Task 2 (owner phone check) is intentionally pending, not failed
