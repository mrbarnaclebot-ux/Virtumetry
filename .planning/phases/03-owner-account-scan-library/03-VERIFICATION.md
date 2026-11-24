---
phase: 03-owner-account-scan-library
verified: 2026-11-24T00:00:00Z
status: human_needed
score: 5/5 roadmap success criteria verified in code; on-device Expo Go checks pending
overrides_applied: 0
human_verification:
  - test: "Sign-in screen and rejected login (HUMAN-UAT 1, 2)"
    expected: "Sign-in shows Virtumetry, Email, Password, Log in, with no sign-up link. A wrong password and a non-allowlisted email both show the same error text."
    why_human: "Real Expo Go render and live dev backend."
  - test: "Login and library states after seed:library (HUMAN-UAT 3)"
    expected: "Five rows: Uploading with a percentage and bar, Processing with the estimate, Ready with a thumbnail, Failed with 'Not charged', muted Cancelled."
    why_human: "Visual check on the iPhone in Expo Go."
  - test: "Pull to refresh, rename, delete (HUMAN-UAT 4, 5)"
    expected: "Rename shows the new name. Delete removes the row and it stays gone after a refresh."
    why_human: "On-device interaction against the live dev backend and worker."
  - test: "Force-quit persistence (HUMAN-UAT 6)"
    expected: "After swiping Expo Go away and reopening, the app lands on the library, still signed in."
    why_human: "SecureStore persistence across a real process kill."
  - test: "Settings and logout (HUMAN-UAT 7)"
    expected: "Settings shows the email and 'Virtumetry 1.0.0 · development'. Log out returns to sign-in."
    why_human: "On-device flow."
---

# Phase 3: Owner Account & Scan Library Verification Report

**Phase Goal:** The owner logs into their own account in Expo Go and sees a library of their scans with honest states, and can rename and delete them.
**Status:** human_needed. No code gaps found. Only the owner's on-device UAT remains (`03-HUMAN-UAT.md`, all 7 rows pending).
**Re-verification:** No, initial verification.

## Roadmap Success Criteria

| # | Criterion | Status | Evidence |
|---|-----------|--------|----------|
| 1 | Email and password login, sign-up unavailable, non-allowlisted rejected | VERIFIED (code and automated); on-device check is human | `backend/src/auth/better-auth.ts` sets `emailAndPassword.disableSignUp: true` and a `before` hook on `/sign-in/email` that gates on `OWNER_ALLOWLIST`, returning the same error as a bad password. `backend/src/auth.ts` adds a second allowlist gate on every session request. `test/integration/auth-session.pg.test.ts` covers allowlisted sign-in, identical 401 for wrong password and non-allowlisted, sign-up refused with no user row, an empty allowlist, a session whose email left the list, origin 403, and the rate limit. |
| 2 | Stays logged in after force-quit; logout from Settings | VERIFIED in code; persistence is human | `virtumetry/src/lib/auth-client.ts` uses `expoClient` with `SecureStore`. `_layout.tsx` gates on `authClient.useSession()` through `Stack.Protected` and holds the splash while the stored session loads. `settings.tsx` has a Log out confirm that calls signOut and shows the user's email. The sign-out revoke is tested in `auth-session.pg.test.ts` ("old cookie then gets 401"). `settings.test.tsx` and `auth-client.test.ts` pass in jest. |
| 3 | Library lists only the account's scans with honest states; other accounts' scans are unreadable | VERIFIED | The list query filters `ownerId = userId AND deletedAt IS NULL`. GET, PATCH and DELETE all go through `findOwnedWorld`, which returns 404 for another owner's id. `ownership.pg.test.ts` covers the two-account list, the 404s on another account's id, and the `ba:<id>` ownership mapping (AUTH-05). `display-state.ts` maps saved on phone, uploading with percent, processing with estimate and stalled hint, ready, failed with a charged flag, and cancelled. `display-state.test.ts` and `library.test.tsx` pass. |
| 4 | Rename; delete removes DB rows and R2 objects and sends a provider deletion | VERIFIED | PATCH accepts a strict title (trimmed, 1 to 80 characters), re-checks owner and not-deleted, and returns 404 otherwise. DELETE soft-deletes and enqueues `purge` in one transaction. `handlePurge` in `worker.ts` calls `provider.deleteWorld` (tolerating 404), purges the `worlds/`, `captures/` and `bundles/` prefixes, nulls poses, and hard-deletes the share_slugs, jobs, captures and worlds rows, with credit_events kept at `world_id` NULL. `purge-cascade.pg.test.ts` covers ready, retry, never-submitted, framesOnly and not-soft-deleted worlds. The app uses `useDeleteWorld` (optimistic with rollback) and `RenameModal`. `library-actions.test.tsx` passes. The dev worker is deployed with the `purge` kind (03-08 summary). |
| 5 | Each build profile points only to its own API; dev refuses a production URL | VERIFIED | `virtumetry/src/config/api.ts` `resolveApiUrl` throws when `appEnv` is not production and the host is the production host, and when the URL is not https (except dev on LAN). `eas.json` maps development and preview to the dev API and production to the production API. `.env.development` points at the dev API. `api-config.test.ts` passes. |

## Requirements Coverage

| Req | Status | Evidence |
|-----|--------|----------|
| AUTH-01 | SATISFIED (device-confirm pending) | Criterion 1 |
| AUTH-02 | SATISFIED (device-confirm pending) | Criterion 2 |
| AUTH-03 | SATISFIED (device-confirm pending) | Criterion 2 |
| AUTH-05 | SATISFIED | Criterion 3, and the `ba:<id>` mapping test |
| LIB-01 | SATISFIED | Criterion 3. The "saved on phone" state is wired through `useLocalScans` for Phase 4 to feed. |
| LIB-03 | SATISFIED | Criterion 4 |

No orphaned requirements. AUTH-04 (Phase 8) and LIB-02 (Phase 6) are mapped to later phases.

## Automated Checks Run

| Check | Result |
|-------|--------|
| `backend` `tsc --noEmit` | exit 0 |
| `backend` `vitest run` | 316 passed, 75 skipped (the pg tests, which need a DB), 35 files passed |
| `backend` `npm run test:pg` against the guarded Neon dev branch | 82 passed, 1 skipped, 11 files passed |
| `virtumetry` `tsc --noEmit` | exit 0 |
| `virtumetry` `jest --ci` | 7 suites, 99 tests passed |
| `virtumetry` `expo lint` | clean |
| Live dev backend `/readyz` | `{"status":"ready","migrations":4}` |
| Unauthenticated `GET /v1/worlds` on the dev backend | 401 |

## Anti-Patterns

The TBD, FIXME and XXX scan found no markers in `virtumetry/src` or `backend/src`. No stubs were found in the library, rename, delete or auth paths. `failure_message` is deliberately never rendered.

## Warnings (non-blocking)

- In session mode, any request carrying an `Authorization` header is routed to the dev-bearer path whenever `DEV_AUTH_TOKEN` is set (`auth.ts`, `devBearer`). Production boot refuses `DEV_AUTH_TOKEN`, so this is dev and test only. On the dev Railway service, keep `DEV_AUTH_TOKEN` unset unless it is needed.
- The delete cascade is asynchronous: the row is soft-deleted at once, and the hard delete, R2 purge and provider delete happen when the worker runs the purge job. The deployed dev worker claims `purge`, so this is by design and tested.

## Human Verification Required

The owner runs `03-HUMAN-UAT.md` rows 1 to 7 in Expo Go on the iPhone 17 Pro, using the setup in `virtumetry/README.md`. These cover the sign-in screen, rejected logins, the five library states, pull to refresh and rename, delete, force-quit persistence, and Settings with logout. These are classified `human_needed`, not gaps.

## Gaps Summary

None. All five success criteria are backed by code and passing automated tests, and the live dev backend is healthy. Phase 3 can be marked complete once the owner records the on-device results in `03-HUMAN-UAT.md`.

_Verifier: Claude (gsd-verifier)_
