---
phase: 04-0-capture-to-world-loop
source: 04-09-PLAN.md Task 2
status: passed
device: iPhone 17 Pro, Expo Go
backend: Railway dev
---

# Phase 4 Human UAT

## Orchestrator setup (before the owner tests)

Railway project, **dev environment only**. Values are exact; `CAPTURE_CONFIG_JSON` is one line.

| Variable | Service(s) | Value |
|----------|------------|-------|
| `CAPTURE_CONFIG_JSON` | api, worker | `{"readiness":{"minFramesGreen":25,"minFramesAmber":15,"minSectorsGreen":1,"minSectorsAmber":1},"precheck":{"minFrames":20,"minCoverageSectors":1}}` |
| `DAILY_CREDIT_BUDGET` | api, worker | `10000` |
| `MONTHLY_CREDIT_BUDGET` | api, worker | `100000` |
| `DAILY_SCAN_QUOTA` | api | `30` |
| `TRACK_POLL_SECONDS` (optional) | worker | `10` |
| `MOCK_PROCESSING_SECONDS` (optional) | worker | `20` |

Production: unchanged. ALLOW_PAID_PROVIDER: unset.

Redeploy dev api + worker from this commit (Dockerfile now ships mock-outputs).

Notes:
- Don't redeploy the worker during a test run. The mock provider keeps request state in memory, so a restart strands in-flight scans (research Pitfall 11).
- Lock-screen upload continuation in Expo Go is observational only (research Pitfall 6). Real background survival is verified in Phase 8 with the dev build.
- If the dev budget runs out, the owner runs `cd backend && npm run budget:reset-dev`. It clears only today's mock spend and refuses any database other than the Neon dev branch.

## Owner setup

Sign-in and app start are the same as Phase 3: `virtumetry/README.md`, "Test on your iPhone (Phase 3)", steps 1, 2, 5 and 6 (account already exists if Phase 3 passed). Then start a scan from the library's new-scan button. Scenarios are picked on the scan screen (Good / Too few / Jump).

| # | Check | Expected | Status | Observed |
|---|-------|----------|--------|----------|
| 1 | First-run prep | Prep shows the 4 items and a "Camera access" card; tapping it opens the system camera prompt | pending | |
| 2 | Compact prep | On the next scan prep is compact; "Don't show again" skips it afterwards | pending | |
| 3 | Good fixture scan (live HUD) | Readiness goes red → amber → green "Good to finish"; cost ends "$9.30 · 930 credits"; mini-map shows the path and 1 lit sector | pending | |
| 4 | Stop → review | Review shows 30 frames, duration, cost and "Checks passed" | pending | |
| 5 | Saved on phone | Close review: Library shows "Saved on phone · Not uploaded"; tapping the row reopens review | pending | |
| 6 | Too few blocked on device | "Too few" scenario → "Didn't pass checks", Upload disabled with the too-few reason | pending | |
| 7 | Quote + explicit approve | Quote shows "~930 credits ≈ $9.30" and the budget line; Approve is the only way forward | pending | |
| 8 | Approve → Ready | Good scan: Uploading % → "Uploaded · Processing started" → Library Processing → Ready | pending | |
| 9 | Pose jump blocked by server | "Jump" scenario → approve → "Didn't pass checks" with the camera-jump reason and "Not charged" (library row too) | pending | |
| 10 | Force-quit mid-upload | Start an upload, force-quit Expo Go (swipe away) within a few seconds, reopen: the upload resumes and the scan reaches Ready | pending | |
| 11 | Discard | Discard a saved scan: confirm copy shows, then the row is gone | pending | |

To record a failure, put the step number and the exact on-screen text in Observed.

## Owner result (2026-11-24)

Owner ran steps 1-11 on the iPhone 17 Pro in Expo Go against Railway dev: all passed ("all good"). Step 8 confirmed Processing -> Ready.
