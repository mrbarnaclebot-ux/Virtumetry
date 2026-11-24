---
phase: 3
slug: owner-account-scan-library
status: draft
nyquist_compliant: false
wave_0_complete: false
created: 2026-11-24
---

# Phase 3 — Validation Strategy

> Per-phase validation contract. Source of truth for the test map: 03-RESEARCH.md §Validation Architecture.

## Test Infrastructure

| Property | Value |
|----------|-------|
| **Framework** | backend vitest ^2.1; app jest 30 + jest-expo ~58 + RNTL 14 (Wave 0 install) |
| **Config file** | `backend/vitest.config.ts`; app `jest` key in `virtumetry/package.json` (Wave 0) |
| **Quick run command** | backend `npx vitest run test/<file>` / `npm run test:pg -- <file>`; app `npx jest --ci <path>` |
| **Full suite command** | `cd backend && npx tsc --noEmit && npx vitest run && npm run test:pg` · `cd virtumetry && npx expo lint && npx tsc --noEmit && npx jest --ci` |
| **Estimated runtime** | ~180 seconds (pg suite on Neon dev dominates) |

## Sampling Rate

- **After every task commit:** quick command for touched files + `npx tsc --noEmit` in the touched package
- **After every plan wave:** full suite for the touched package
- **Before verify:** full suite green in both packages
- **Max feedback latency:** 180 seconds. No watch mode anywhere (`vitest run`, `jest --ci`); every long command bounded with a timeout.

## Per-Task Verification Map

See 03-RESEARCH.md "Phase Requirements → Test Map" (AUTH-01/02/03/05, LIB-01, LIB-03, SC5). Planner maps each task to a row; executor fills status.

## Wave 0 Requirements

- [ ] App jest-expo + RNTL install/config, `expo-secure-store` in-memory mock
- [ ] `.github/workflows/app.yml` runs `npx jest --ci`
- [ ] Backend pg test helpers for `createAuth` on a throwaway schema
- [ ] Mock provider records `deleteWorld` calls

## Manual-Only Verifications

| Behavior | Requirement | Why Manual | Test Instructions |
|----------|-------------|------------|-------------------|
| Login in Expo Go against Railway dev | AUTH-01 | needs device + deployed env | Expo Go → sign in with owner creds |
| Session survives force-quit | AUTH-02 | real iOS keychain | log in, force-quit, reopen → Library |
| Log out | AUTH-03 | device | Settings → Log out → sign-in screen |
| Library states / rename / delete on phone | LIB-01, LIB-03 | device | run `seed:library`, check states, rename, delete |

## Validation Sign-Off

- [ ] All tasks have `<automated>` verify or Wave 0 dependencies
- [ ] Sampling continuity: no 3 consecutive tasks without automated verify
- [ ] Wave 0 covers all MISSING references
- [ ] No watch-mode flags
- [ ] Feedback latency < 180s
- [ ] `nyquist_compliant: true` set in frontmatter

**Approval:** pending
