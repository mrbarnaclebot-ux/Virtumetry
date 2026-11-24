---
phase: 03-owner-account-scan-library
source: 03-09-PLAN.md Task 2
status: pending
device: iPhone 17 Pro, Expo Go
backend: Railway dev (https://api-dev-d164ec0a.up.railway.app)
---

# Phase 3 Human UAT

Setup steps are in `virtumetry/README.md`, under "Test on your iPhone (Phase 3)", steps 1-6. They cover: OWNER_EMAIL/OWNER_ALLOWLIST in backend/.env, `npm run owner:create`, `railway variable set OWNER_ALLOWLIST=<your-email> -e dev -s api`, `npm run seed:library`, Expo Go, and `npx expo start` (or `--tunnel`).

| # | Check | Expected | Status | Observed |
|---|-------|----------|--------|----------|
| 1 | Sign-in screen | "Virtumetry", Email, Password, Log in. No sign-up or forgot-password link | pending | |
| 2 | Rejected login | Wrong password, and an email not on the allowlist, both show "That email and password don't match. Try again." | pending | |
| 3 | Login + library states (after seed:library) | 5 rows: "Uploading · 40%" with bar, "Processing" with "Usually 30 min – 2 h", "Ready" with thumbnail, "Failed · The scan couldn't be turned into a room" with "Not charged", muted "Cancelled" | pending | |
| 4 | Pull to refresh + rename | Refresh works. Rename on Ready, then Save Name, and the row shows the new name | pending | |
| 5 | Delete | Delete on Cancelled, then confirm. The row disappears and stays gone after refresh | pending | |
| 6 | Force-quit persistence | Swipe Expo Go away and reopen. You land on the library still signed in | pending | |
| 7 | Settings + logout | Shows your email and "Virtumetry 1.0.0 · development". Log out, confirm, and you're back on sign-in | pending | |

To record a failure, put the step number and the exact on-screen text in Observed.
