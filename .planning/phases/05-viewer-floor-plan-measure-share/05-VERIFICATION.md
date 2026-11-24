---
phase: 05-viewer-floor-plan-measure-share
verified: 2026-11-24T19:30:00Z
status: human_needed
score: 5/5 roadmap criteria verified in code (automated halves); manual halves pending
overrides_applied: 0
human_verification:
  - test: "UAT 1-2: fixture scan to Ready, open, orbit, Reset on iPhone 17 Pro in Expo Go"
    expected: "Honest download percent, opens at start camera, smooth orbit/pinch (fps), Reset returns to start"
    why_human: "fps and first-open feel need a real device"
  - test: "UAT 3-5: Walk, Plan teleport, Measure"
    expected: "Stops at walls/table; plan dot follows and tap teleports; table measures about 1.00 m (approx.)"
    why_human: "Touch feel and on-device rendering"
  - test: "UAT 6: forced crash/context loss"
    expected: "Reconnecting viewer, then same view, without leaving screen"
    why_human: "Real WebView kill / WebGL loseContext"
  - test: "UAT 7-9: create link, messaging-app preview, open in desktop and mobile browsers"
    expected: "Title and thumbnail in iMessage/WhatsApp; same viewer works in browsers"
    why_human: "Third-party unfurl and real browsers"
  - test: "UAT 10-13: password link, open counts, revoke, noindex source"
    expected: "As in 05-HUMAN-UAT.md"
    why_human: "Requires owner session to create links"
---

# Phase 5: Viewer, Floor Plan, Measure and Share Verification Report

**Phase Goal:** Owner opens a ready world, orbits, walks with collision, uses floor plan and measure, and shares a public link opening the same viewer in any browser.
**Status:** human_needed. All automated checks pass. The 13-step manual checklist (05-HUMAN-UAT.md) is still `pending`.
**Re-verification:** No

## Observable Truths (ROADMAP success criteria)

| # | Truth | Status | Evidence |
|---|-------|--------|----------|
| 1 | Opens from sensible start, honest progress, LoD, reset; coordinate util tested | VERIFIED (auto); fps manual | `src/viewer/{coords,progress,engine,world-viewer}.ts*`, wired in `src/app/world/[id]/index.tsx` (imports and renders WorldViewer). Tests viewer-coords/progress/tokens pass |
| 2 | Walk with collision, floor plan you-are-here and teleport, approximate measure | VERIFIED (auto); feel manual | `walk.ts`, `floorplan.ts`, `measure.ts` with viewer-walk/floorplan/measure tests passing (jest: 9 suites, 58 tests) |
| 3 | WebView/WebGL loss recovers by itself | VERIFIED (auto); forced crash manual | `recovery.ts` plus viewer-recovery test passing |
| 4 | Unguessable slug, revoke immediate, optional password, open count | VERIFIED (auto); browser manual | `backend/src/routes/share.ts` (revoked_at re-checked in the atomic count update, line ~200; open_count; password in `share-password.ts`). `test/integration/share.pg.test.ts` (pg suite, 126 pass per gates; skipped without DB in my local run); share-cors and share-password vitest pass |
| 5 | OG preview and noindex | VERIFIED (auto); paste test manual | share.ts emits og:title/og:image and `noindex,nofollow`. Live: dev API `/s/<unknown>` returns 404 with `x-robots-tag: noindex, nofollow`. Hosted `/r/<unknown>` returns 200 with the robots meta and header |

**Score:** 5/5 automated halves verified; 0/5 manual halves done.

## Requirements Coverage

All 11 IDs appear in PLAN frontmatter (05-01 through 05-08, 05-08 lists all 11) and in REQUIREMENTS.md. No orphans.

| Req | Status | Evidence |
|-----|--------|----------|
| VIEW-01 | SATISFIED in code; fps manual | engine/progress/LoD, UAT 2 |
| VIEW-02 | SATISFIED | start pose + Reset, tests |
| VIEW-03 | SATISFIED in code; feel manual | walk.ts + test |
| VIEW-04 | SATISFIED in code | floorplan.ts + test |
| VIEW-05 | SATISFIED in code | measure.ts + test |
| VIEW-06 | SATISFIED in code; crash manual | recovery.ts + test |
| SHARE-01 | SATISFIED in code; browser manual | share.ts, `r/[slug].tsx` lazy-loads the viewer, live hosted route 200 |
| SHARE-02 | SATISFIED | revoked_at checks, pg test |
| SHARE-03 | SATISFIED in code; unfurl manual | og tags, noindex live |
| SHARE-04 | SATISFIED | share-password.ts + tests |
| SHARE-05 | SATISFIED | atomic open_count |

(REQUIREMENTS.md traceability still shows "Pending". Update it after UAT.)

## Behavioral Spot-Checks

| Check | Result |
|-------|--------|
| `npx jest src/__tests__/viewer src/__tests__/share` | 9 suites, 58 tests pass |
| `npx vitest run share` (backend) | 12 passed; the pg suite skipped locally (no DB), reported green in the gates (126) |
| curl dev API `/s/<unknown>` | 404, noindex header |
| curl hosted `/r/<unknown>` | 200, noindex header and meta |

## Anti-Patterns

No TBD/FIXME/XXX in the viewer files or share.ts. Review iterations 1-2 are fixed per 05-REVIEW-FIX.md. A jest worker "failed to exit gracefully" warning appears (info only).

## Gaps Summary

No code gaps found. Phase goal is not fully confirmed until the owner completes the 13 manual checks. Check 8 (real messaging-app preview) and checks 6 and 12 (live revoke and crash) are the likeliest to expose real-world surprises.

_Verifier: Claude (gsd-verifier)_
