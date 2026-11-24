---
phase: 05-viewer-floor-plan-measure-share
source: 05-08-PLAN.md Task 3
status: pending
device: iPhone 17 Pro, Expo Go + desktop browser (Chrome or Safari)
backend: Railway dev
---

# Phase 5 Human UAT

## Setup done by the executor

| What | Value |
|------|-------|
| Web share page (EAS Hosting, dev alias, never `--prod`) | `https://virtumetry--dev.expo.app` (EAS project `@uziman99/virtumetry`; EAS env `development`: `EXPO_PUBLIC_API_URL=https://api-dev-d164ec0a.up.railway.app`, `EXPO_PUBLIC_APP_ENV=development`) |
| Dev API | `https://api-dev-d164ec0a.up.railway.app` |
| Railway dev `api` | `MOCK_OUTPUTS_SET=demo-room`, `WEB_SHARE_ORIGIN=https://virtumetry--dev.expo.app`, `PUBLIC_BASE_URL=https://api-dev-d164ec0a.up.railway.app` (plus the Phase 4 dev variables, unchanged) |
| Railway dev `worker` | `MOCK_OUTPUTS_SET=demo-room` (plus the Phase 4 dev variables, unchanged) |
| R2 `virtumetry-dev` CORS | GET/HEAD from the share origin, `http://localhost:8081`, `http://localhost:8090`, `http://192.168.*`, `http://10.*`, `https://*.exp.direct` (Expo Go tunnel); header `Range`; exposes `Content-Range`, `Accept-Ranges`, `Content-Length`, `ETag`. Re-apply with `cd backend && npm run r2:cors-dev -- --origin https://virtumetry--dev.expo.app` |

Production: unchanged. ALLOW_PAID_PROVIDER: unset.

Live checks already passed on dev: `/healthz` ok; `/s/<unknown>` 404 with `x-robots-tag: noindex, nofollow`; `/v1/public` preflight allows only the share origin; hosted `/r/<unknown>` 200 with noindex; a fixture scan reached Ready with the demo-room thumbnail, splat, collider and floor plan.

Notes:
- Mock processing only ($0). Rooms are the bundled demo room: a box room with one table about 1.00 m long.
- Don't redeploy the dev worker during a test run (the mock keeps request state in memory).
- If the dev budget runs out: `cd backend && npm run budget:reset-dev`.

## How to get a share link

Share links need your signed-in session, so the executor didn't create one. You make it in the app (check 7). The link looks like `https://api-dev-d164ec0a.up.railway.app/s/<slug>`. Opening it shows a preview page that forwards to `https://virtumetry--dev.expo.app/r/<slug>`. Only share links to fixture/demo-room scans.

## Owner setup

Sign in and start the app as in `virtumetry/README.md` "Test on your iPhone (Phase 3)", steps 1, 2, 5 and 6. Reload the project in Expo Go so it picks up the Phase 5 code.

| # | Check | Expected | Status | Observed |
|---|-------|----------|--------|----------|
| 1 | Fixture scan to Ready | Run a Phase 4 "Good" fixture scan and approve it. The Library row reaches Ready with the demo-room thumbnail | pending | |
| 2 | Open + orbit + Reset | Tap the Ready row: "Downloading room" percent climbs, then the room opens at the first camera. One-finger orbit and pinch are smooth. Reset returns to the start view | pending | |
| 3 | Walk | Pick Walk: left side moves (joystick), right side looks. Walk into a wall and into the table: you stop, you don't pass through | pending | |
| 4 | Plan | Tap Plan: the floor plan shows a dot + wedge that follow you. Tap a spot on it: you move there and see "You're here now" | pending | |
| 5 | Measure | Pick Measure, tap both ends of the table's long edge: label "≈ 1.00 m (approx.)" within a few cm. Clear removes it | pending | |
| 6 | Crash recovery | Open several heavy apps, then come back to the viewer (memory pressure), or on desktop Chrome run `document.querySelector('canvas').getContext('webgl2').getExtension('WEBGL_lose_context').loseContext()` in DevTools on the web page: "Reconnecting viewer…", then the same view | pending | |
| 7 | Create link | In the viewer, tap Share (top right), then Create link: the iOS share sheet opens. Tap Copy | pending | |
| 8 | Link preview | Paste the link in iMessage or WhatsApp: the preview shows the title and the thumbnail | pending | |
| 9 | Open in browsers | Open the link in desktop Chrome or Safari and in iPhone Safari: the same room loads, and orbit, Walk, Plan and Measure work | pending | |
| 10 | Password link | Turn on password (6–64 characters), create a second link. Its preview has no image. The browser asks "This room is password protected"; a wrong password shows an error, the right one opens the room | pending | |
| 11 | Open counts | Back in the Share sheet, pull to refresh: the open counts went up after your browser opens | pending | |
| 12 | Revoke | Revoke a link and confirm. An already open browser tab keeps what it loaded; a reload shows "This link is no longer available" | pending | |
| 13 | noindex | View the source of `https://api-dev-d164ec0a.up.railway.app/s/<slug>` (and the `/r/<slug>` page): it has `<meta name="robots" content="noindex,nofollow">` | pending | |

To record a failure, put the step number and the exact on-screen text in Observed.
