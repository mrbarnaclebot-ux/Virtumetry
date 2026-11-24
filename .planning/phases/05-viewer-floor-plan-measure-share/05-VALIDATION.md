---
phase: 5
slug: viewer-floor-plan-measure-share
status: draft
nyquist_compliant: false
wave_0_complete: false
created: 2026-11-24
---

# Phase 5 — Validation Strategy

> Per-phase validation contract for feedback sampling during execution. Source: 05-RESEARCH.md §Validation Architecture.

---

## Test Infrastructure

| Property | Value |
|----------|-------|
| **Framework** | App: jest 30 + jest-expo 58 + RNTL 14. Backend: vitest 2.1 |
| **Config file** | `virtumetry/package.json` ("jest"), `backend/vitest.config.ts` |
| **Quick run command** | `cd virtumetry && npx jest --ci src/__tests__/viewer-` / `cd backend && npx vitest run test/share*.test.ts test/demo-room.test.ts` |
| **Full suite command** | `cd virtumetry && npx jest --ci && npx tsc --noEmit && npx expo lint` ; `cd backend && npx tsc --noEmit && npx vitest run && npm run test:pg` |
| **Estimated runtime** | ~120 seconds (app) + ~180 seconds (backend incl. Neon) |

---

## Sampling Rate

- **After every task commit:** the quick jest/vitest file(s) for that task + typecheck of the touched package
- **After every plan wave:** full suite of the touched package(s)
- **Before `/gsd:verify-work`:** both full suites green + local web export smoke test
- **Max feedback latency:** 180 seconds

---

## Per-Task Verification Map

Filled by the planner per task (`<automated>` blocks). Requirement → test map:

| Requirement | Test Type | Automated Command | File Exists | Status |
|-------------|-----------|-------------------|-------------|--------|
| VIEW-01 | unit + RNTL + vitest | `npx jest src/__tests__/viewer-progress.test.ts src/__tests__/world-screen.test.tsx`; worlds detail returns `floorplan_meta` | ❌ W0 | ⬜ pending |
| VIEW-02 | unit | `npx jest src/__tests__/viewer-coords.test.ts` | ❌ W0 | ⬜ pending |
| VIEW-03 | unit | `npx jest src/__tests__/viewer-walk.test.ts` | ❌ W0 | ⬜ pending |
| VIEW-04 | unit | `npx jest src/__tests__/viewer-floorplan.test.ts` | ❌ W0 | ⬜ pending |
| VIEW-05 | unit | `npx jest src/__tests__/viewer-measure.test.ts` | ❌ W0 | ⬜ pending |
| VIEW-06 | unit | `npx jest src/__tests__/viewer-recovery.test.ts` | ❌ W0 | ⬜ pending |
| SHARE-01/02/03/04/05 | vitest pg + RNTL | `npm run test:pg -- test/integration/share.pg.test.ts`; `npx jest src/__tests__/share-sheet.test.tsx src/__tests__/share-web-route.test.tsx` | ❌ W0 | ⬜ pending |
| SHARE-03 (fixtures) | vitest | `npx vitest run test/demo-room.test.ts` + mock outputs set test | ❌ W0 | ⬜ pending |

*Status: ⬜ pending · ✅ green · ❌ red · ⚠️ flaky*

---

## Wave 0 Requirements

- [ ] Viewer trio installed with exact pins (`@sparkjsdev/spark@2.4.0`, `three@0.187.0`, `three-mesh-bvh@0.9.18`, `@types/three@0.187.0`) — packages verified on npm by orchestrator 2026-11-24 (MIT, official repos)
- [ ] `0004` share_slugs migration + `migrate-folder.test.ts` expected list
- [ ] `config.ts`: `MOCK_OUTPUTS_SET`, `WEB_SHARE_ORIGIN`, `PUBLIC_BASE_URL` + config tests
- [ ] Local `expo export -p web` smoke test for `/r/[slug]`

---

## Manual-Only Verifications

| Behavior | Requirement | Why Manual | Test Instructions |
|----------|-------------|------------|-------------------|
| Smooth orbit, start view, reset on iPhone 17 Pro | VIEW-01/02 | GPU/frame rate on device | Expo Go: open demo-room world, orbit, Reset |
| Walk feel + wall collision | VIEW-03 | Touch input on device | Walk mode joystick into wall |
| WebView/WebGL crash recovery | VIEW-06 | Needs process kill | Safari Web Inspector `WEBGL_lose_context`, background under memory pressure |
| Messaging app preview | SHARE-03 | Third-party scraper | Paste `/s/<slug>` link into iMessage/WhatsApp |
| Desktop + mobile browser viewer | SHARE-01 | Real browsers | Open link on desktop Chrome/Safari and iPhone Safari |

---

## Validation Sign-Off

- [ ] All tasks have `<automated>` verify or Wave 0 dependencies
- [ ] Sampling continuity: no 3 consecutive tasks without automated verify
- [ ] Wave 0 covers all MISSING references
- [ ] No watch-mode flags
- [ ] Feedback latency < 180s
- [ ] `nyquist_compliant: true` set in frontmatter

**Approval:** pending
