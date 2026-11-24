---
phase: 03-owner-account-scan-library
plan: 05
subsystem: app-auth
tags: [expo, better-auth, jest, expo-router, securestore]
requires: [03-01 approved package list, 03-02 Better Auth session backend]
provides:
  - virtumetry/src/config/api.ts resolveApiUrl / API_URL / APP_ENV / PROD_API_HOST
  - virtumetry/src/lib/auth-client.ts authClient (expoClient, SecureStore, prefix virtumetry)
  - virtumetry/src/lib/session.ts endSession / consumeSessionEndedNotice
  - virtumetry/src/lib/query-client.ts queryClient
  - Stack.Protected session gate, sign-in screen, (tabs) Library + Settings
  - app jest harness (jest-expo 58, Jest 30, RNTL 14) + CI step
affects: [03-06 library list, 03-09 eas.json/.env + on-device check]
tech-stack:
  added: [better-auth 1.7.27, "@better-auth/expo 1.7.27", expo-secure-store, expo-network, "@tanstack/react-query", jest-expo, jest 30, "@types/jest", "@testing-library/react-native 14"]
  patterns: [Stack.Protected guard on useSession, ".mjs jest transformer reusing jest-expo babel options", "in-memory SecureStore mock in jest.setup.ts"]
key-files:
  created:
    - virtumetry/jest.setup.ts
    - virtumetry/jest.mjs-transformer.js
    - virtumetry/src/config/api.ts
    - virtumetry/src/lib/auth-client.ts
    - virtumetry/src/lib/session.ts
    - virtumetry/src/lib/query-client.ts
    - virtumetry/src/app/sign-in.tsx
    - virtumetry/src/app/(tabs)/_layout.tsx
    - virtumetry/src/app/(tabs)/index.tsx
    - virtumetry/src/app/(tabs)/settings.tsx
    - virtumetry/src/__tests__/api-config.test.ts
    - virtumetry/src/__tests__/auth-client.test.ts
    - virtumetry/src/__tests__/sign-in.test.tsx
    - virtumetry/src/__tests__/settings.test.tsx
  modified:
    - virtumetry/package.json
    - virtumetry/package-lock.json
    - virtumetry/tsconfig.json
    - virtumetry/app.json
    - .github/workflows/app.yml
    - virtumetry/src/app/_layout.tsx
    - virtumetry/src/components/app-tabs.tsx
    - virtumetry/src/components/app-tabs.web.tsx
    - virtumetry/src/components/themed-text.tsx
    - virtumetry/src/constants/theme.ts
decisions:
  - "Jest .mjs: Better Auth is ESM-only .mjs and Node 22 can't require() ESM; a 6-line transformer reuses jest-expo's exact babel-jest options for \\.mjs$"
  - "endSession offline fallback also nulls the session atom directly (not only $sessionSignal) so an offline refetch can't keep the user signed in"
  - "Tests set EXPO_PUBLIC_APP_ENV=test / EXPO_PUBLIC_API_URL=https://api.test.invalid in jest.setup.ts so modules resolving the URL at import load"
metrics:
  duration: 30min
  completed: 2026-11-24
---

# Phase 3 Plan 05: App sign-in, session gate and Settings log-out Summary

Expo Go app now opens to a Better Auth email/password sign-in (expoClient + SecureStore, prefix `virtumetry`), gates on `Stack.Protected`, lands on a Library/Settings tab shell, and logs out from Settings with a local wipe even when the network sign-out fails; jest-expo harness with 28 tests runs locally and in CI.

## Tasks

| # | Task | Commit |
|---|------|--------|
| 1 | Jest harness, resolveApiUrl, persistent auth client, CI jest step | ef4e7fc |
| 2 | RED sign-in tests (+ starter deletions, see deviations) | c3678e7 |
| 2 | Session gate, sign-in, tabs, theme, session helpers | 161bce6 |
| 3 | Settings with signed-in email and Log out (+ tests) | ff29324 |

Verification: `npx jest --ci` 4 suites / 28 tests pass; `npx tsc --noEmit` and `npx expo lint` clean.

## Deviations from Plan

1. **[Rule 3 - Blocking] `.mjs` transform for Better Auth in jest.** Extending `transformIgnorePatterns` was not enough: jest-expo only transforms `\.[jt]sx?$`, and Better Auth / `@better-auth/core` ship `.mjs`. Added `virtumetry/jest.mjs-transformer.js` (reuses jest-expo's babel-jest options) mapped to `\\.mjs$`. Commit ef4e7fc.
2. **[Rule 3 - Blocking] jest env + CSS.** `API_URL` resolves at import, so jest.setup.ts sets public test values; `theme.ts` imports `global.css`, mocked in jest.setup.ts. Commits ef4e7fc, 161bce6.
3. **[Rule 3] `npx expo install ... -- --dev` dropped the dev flag under Git Bash**; jest/RNTL/@types/jest were moved to devDependencies by hand and the lockfile re-synced with `npm install`. Versions unchanged from what expo install chose.
4. **`npx expo install expo-secure-store` added the `expo-secure-store` config plugin to app.json.** It is a no-op in Expo Go and is what the future dev build needs; kept. No build run.
5. **Commit hygiene:** the starter-file deletions (`git rm` of explore, index, hint-row, web-badge, external-link, collapsible, animated-icon*) were already staged and landed in the RED test commit c3678e7 instead of 161bce6. Intentional deletions, history not rewritten.
6. **Web tab href** is `/index` (typed routes list the grouped index as `/index`, not `/`).
7. TDD: Task 1 tests were written alongside the implementation (no separate RED commit); Tasks 2 and 3 had RED observed (missing module) before GREEN, Task 2 RED committed separately.

## Known Stubs

- `virtumetry/src/app/(tabs)/index.tsx`: Library shows only the header and the empty state; the real list (and pull-to-refresh that the empty-state copy mentions) arrives in 03-06 per plan.

## Threat Flags

None. T-03-22..26 mitigations implemented and tested (SecureStore prefix, https/prod-host refusal, offline logout wipe, single mismatch message).

## Self-Check: PASSED

Files and commits ef4e7fc, c3678e7, 161bce6, ff29324 verified present.
