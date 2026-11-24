# Phase 3: Owner Account & Scan Library - Context

**Gathered:** 2026-11-24
**Status:** Ready for planning
**Mode:** --auto (recommended options picked; decisions logged in 03-DISCUSSION-LOG.md)

<domain>
## Phase Boundary

The owner opens the app in **Expo Go on an iPhone 17 Pro** (no dev build, no Apple Developer account), logs in with email + password, stays logged in after force-quit, logs out from Settings, sees a library of only their own scans with honest states, and can rename and delete a scan. Deleting removes DB rows + R2 objects and sends a deletion request to the provider (mock).

Requirements: AUTH-01, AUTH-02, AUTH-03, AUTH-05, LIB-01, LIB-03.

Out of scope (later phases): capture, upload reshaping (frame `.heic` presign → session format, `approved_max_credits`), cost approval, viewer, Sign in with Apple (AUTH-04, Phase 8), retry of failed scans (LIB-02, Phase 6), share links.

</domain>

<decisions>
## Implementation Decisions

### Auth backend (Better Auth)
- **D-01:** Better Auth 1.7.x (`better-auth`) mounted in the Fastify API at `/api/auth/*` with the Drizzle adapter on Neon. `@fastify/cors` registered **before** the auth route. Better Auth's own tables (`user`, `session`, `account`, `verification`) are added to `backend/src/db/schema.ts` and created with `drizzle-kit generate` + the dev guard migrate script (never `push`); prod via Railway preDeploy.
- **D-02:** `emailAndPassword: { enabled: true, disableSignUp: true }`. No sign-up route reachable from the app or API.
- **D-03:** Allowlist: `OWNER_ALLOWLIST` env (comma-separated, trimmed, lowercased). Enforced twice: (a) in a Better Auth `before` hook on sign-in (non-allowlisted email → generic "invalid email or password" style rejection, no account-existence leak), and (b) in the API auth hook (a session whose user email is not allowlisted → 401). Empty/unset allowlist in session mode = nobody can log in (fail closed). The owner's email is **never** committed anywhere — only set as an env var by the owner.
- **D-04:** Identity linking: the existing `users` table stays the FK target of `worlds.owner_id`. On each authenticated request, `upsertUserBySub(db, 'ba:' + betterAuthUserId, email)` maps the Better Auth user to our `users` row. No change to worlds/captures ownership columns. (AUTH-05: every world belongs to exactly one `users` row; no anonymous path.)
- **D-05:** `AUTH_MODE` enum becomes `dev | session | apple`. `session` = Better Auth session cookie (sent by the Expo client as a `Cookie` header) is the app's auth. In `session` mode, `Authorization: Bearer <DEV_AUTH_TOKEN>` + `x-dev-user` is additionally accepted **only when `DEV_AUTH_TOKEN` is set**, which `refine()` already forbids under `NODE_ENV=production` — so tests and local scripts keep working while production refuses dev auth. `session` mode requires `BETTER_AUTH_SECRET` (≥32 chars) and `BETTER_AUTH_URL` at boot. Production must use `session` (or `apple`); `dev` stays refused in production.
- **D-06:** Better Auth's built-in rate limiting on (sign-in tightly limited), plus the existing per-IP failure throttle. Trusted origins include the app scheme (`virtumetry://`) and the Expo Go dev scheme (`exp://` — researcher confirms exact Expo Go handling for `@better-auth/expo`).
- **D-07:** Owner account creation: a guarded one-shot script `npm run owner:create` (backend) that reads `OWNER_EMAIL` / `OWNER_PASSWORD` from env or prompts for them (password hidden), refuses the Virtumetry prod endpoint and any denylisted host (reuse `scripts/dev-guard.mjs`), refuses an email not in `OWNER_ALLOWLIST`, and creates-or-updates (password reset) the Better Auth user via Better Auth's server API/internal adapter despite `disableSignUp`. Never prints the password. The owner runs it themselves.

### App auth client
- **D-08:** `better-auth/react` `createAuthClient` + `@better-auth/expo` `expoClient({ scheme: 'virtumetry', storagePrefix: 'virtumetry', storage: SecureStore })`. Session persists in SecureStore → survives force-quit (AUTH-02). API calls attach `authClient.getCookie()` as the `Cookie` header. Peers `expo-secure-store`, `expo-network` installed with `npx expo install` (both are in Expo Go). Same Better Auth version in app and backend.
- **D-09:** Routing: Expo Router root layout gates on session — `Stack.Protected` (or redirect) between a `sign-in` screen and the signed-in tabs. Tabs: **Library** (home) and **Settings**. The starter `explore` screen and starter demo content are removed. Settings shows the signed-in email and a **Log out** button (confirm, then `authClient.signOut()`, clear query cache, back to sign-in) (AUTH-03).
- **D-10:** Sign-in screen: email + password fields, one primary button, inline error text, no "sign up" or "forgot password" links (owner-only v1; password reset = re-run `owner:create`).

### API URL per build profile (success criterion 5)
- **D-11:** A pure module `virtumetry/src/config/api.ts` exports `resolveApiUrl({ appEnv, apiUrl })`: requires a URL, requires `https://` unless `appEnv === 'development'` *and* host is localhost/LAN, and **throws if `appEnv !== 'production'` and the URL's host is the production API host** (`api-production-adfc8f68.up.railway.app`). Inputs come from `EXPO_PUBLIC_APP_ENV` + `EXPO_PUBLIC_API_URL`.
- **D-12:** Create `virtumetry/eas.json` with `development`, `preview`, `production` profiles, each setting its own `env` (`EXPO_PUBLIC_APP_ENV`, `EXPO_PUBLIC_API_URL`). Commit a non-secret `virtumetry/.env` (Expo loads it for `npx expo start`) with `EXPO_PUBLIC_APP_ENV=development` and the Railway **dev** API URL, so Expo Go works with zero setup. A jest test covers each profile and the refusal. (No EAS build is run.)

### Dev backend for the phone
- **D-13:** Add a **`dev` environment** to the existing Virtumetry Railway project (162ef8a1-…): `api` + `worker` services, Neon **dev** branch (endpoint ep-mute-fog-arwonnkz; pooler for runtime, direct for preDeploy migrate), bucket `virtumetry-dev`, `NODE_ENV=development`, `AUTH_MODE=session`, `PROVIDER_MODE=mock`, `ALLOW_PAID_PROVIDER` unset, `DEV_AUTH_TOKEN` **unset** (public URL), own `BETTER_AUTH_SECRET`, `BETTER_AUTH_URL` = the dev public domain, `OWNER_ALLOWLIST` set by the owner. Boot guards must pass (never the prod endpoint or `virtumetry-prod`). Generate a public domain for dev api. Production environment redeployed with `AUTH_MODE=session` + its own secret (allowlist may stay empty → nobody can log in to prod yet; that is fine).
- **D-14:** Shared dev DB caveat: local tests and Railway dev both use the Neon dev branch. Tests must only touch rows they create (no global truncates); researcher verifies existing tests behave.

### Library API (backend)
- **D-15:** Existing `GET /v1/worlds` (list, owner-only, excludes soft-deleted) and `GET /v1/worlds/:id` are kept; list items gain what the library needs: `id, title, status, progress, failure_stage/code/message, created_at, updated_at (heartbeat), thumbnail_url`, and a processing **estimate** field (see D-19). Every `/:id` route resolves through `findOwnedWorld` → **404** (not 403) for another account's world.
- **D-16:** New `PATCH /v1/worlds/:id` `{ title }`: trimmed, 1–80 chars, zod-validated, owner-only, bumps `updated_at`. Rename only — no other fields.
- **D-17:** Delete: `DELETE /v1/worlds/:id` keeps soft-delete + enqueue `purge` in one transaction (library hides it immediately). The `purge` job is extended to: (1) if `provider_request_id` is set, call a new `ReconProvider.deleteWorld(requestId)` (mock records the call; live throws "Phase 6" like the rest), tolerating "already gone"; (2) purge `worlds/{id}/`, capture frames and `bundles/{captureId}/` prefixes (exists); (3) **hard-delete** the world's captures, jobs (other than the running purge) and the world row. Idempotent on retry. Automated cascade test asserts DB rows gone, storage prefixes empty, and exactly one provider delete call.
- **D-18:** Upload/approval routes are not reshaped (Phase 4). Only touch them if needed for compile/tests.

### Library UI states (LIB-01)
- **D-19:** Display-state mapping (pure function, unit-tested):
  - `saved_on_phone` — client-only local scan (Phase 3 has no local capture source yet: the type + rendering exist and are RNTL-tested with a seeded local item; the local store is empty in practice).
  - `uploading` → "Uploading" with progress bar (`progress` %).
  - `packing | submitting | processing | importing` → "Processing" with phase label and an estimate: "About N min left" from progress when available, else "Usually 30 min – 2 h" (Echo-3 guidance). Shows "Stalled?" hint when `updated_at` is older than 15 min.
  - `ready` → "Ready" (thumbnail if present).
  - `failed` → "Failed" + human message from `failure_code`/`failure_message` and whether it was charged.
  - `cancelled` → "Cancelled" (muted).
- **D-20:** Data: `@tanstack/react-query`; list polls every 5 s only while any item is non-terminal, otherwise no polling; pull-to-refresh; empty state with a short line explaining scans appear here (no capture button yet — capture is Phase 4/7).
- **D-21:** Row actions: tapping the "…" on a row opens an Alert/action sheet with **Rename** and **Delete**. Rename opens a small modal with a TextInput (cross-platform; not `Alert.prompt`). Delete asks for confirmation ("removes it from your phone, our servers and SpAItial"), then optimistic removal with rollback on error.

### Seed data for phone testing
- **D-22:** Guarded dev-only script `npm run seed:library` (backend) that, given `OWNER_EMAIL` from env (never committed), finds that owner's `users` row (via the Better Auth user) and inserts ~5 fixture worlds in states uploading (40%), processing (60%), ready (with a small thumbnail uploaded to `virtumetry-dev` under the world prefix), failed, cancelled. Refuses prod endpoints/buckets via the dev guard. Re-runnable (`--reset` removes only previously seeded worlds, tagged via `client_request_id` prefix `seed:`).

### Testing
- **D-23:** App: `jest-expo@58` + Jest 30 + `@testing-library/react-native@14` (via `npx expo install … --dev`), `"jest": { "preset": "jest-expo" }`. Tests: `resolveApiUrl` profiles/refusal; display-state mapping; RNTL library list rendering each state from seeded data; session persistence (auth client configured with SecureStore — mock `expo-secure-store`, assert stored session is read on boot); sign-in screen error path. App CI (`.github/workflows/app.yml`) adds `npx jest --ci`. Every command bounded (no watch mode).
- **D-24:** Backend (vitest, Neon dev via `TEST_DATABASE_URL`): sign-in allowed for allowlisted email, rejected for non-allowlisted, sign-up endpoint refused; session cookie authenticates `/v1/worlds`; two-account ownership tests (list/get/patch/delete of another's world → 404, list never shows it); rename validation; deletion cascade (D-17); config tests: `session` mode requires secrets, prod refuses dev auth. Existing suite stays green; `tsc --noEmit` clean.

### Claude's Discretion
- Exact Better Auth integration mechanics (Fastify handler bridging, cookie vs bearer plugin) — follow official Fastify + Expo docs; prefer cookie via `getCookie()`.
- Plan split / waves, file layout under `virtumetry/src/` (non-route code outside `src/app/`).
- Visual details are fixed by the UI-SPEC (gsd-ui-phase), own Virtumetry branding.

</decisions>

<canonical_refs>
## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### Project & requirements
- `.planning/ROADMAP.md` §Phase 3 — goal + 5 success criteria
- `.planning/REQUIREMENTS.md` — AUTH-01/02/03/05, LIB-01, LIB-03
- `.planning/PROJECT.md` — constraints (money, privacy, isolation, Expo Go-first)
- `CLAUDE.md` — stack decisions (Better Auth, jest-expo, Expo Go constraints)
- `virtumetry/AGENTS.md` — Expo rules (versioned docs, `npx expo install`, lint + tsc), EAS quota rules (never `eas build`)
- `.planning/research/STACK.md` — Better Auth 1.7.x + `@better-auth/expo`, CORS ordering, peers, test stack
- `.planning/research/ARCHITECTURE.md` — world state machine, provider interface

### Prior phase
- `.planning/phases/02-bundle-pipeline-mock-provider/02-CONTEXT.md` — states, asset keys, provider interface (D-11, D-15)
- `.planning/phases/02-bundle-pipeline-mock-provider/02-VERIFICATION.md` — what exists and is verified
- `.planning/phases/01-isolated-backend-fork/01-CONTEXT.md` — isolation guards, Railway/Neon setup

### External docs (researcher fetches current versions)
- https://www.better-auth.com/docs/integrations/expo
- https://www.better-auth.com/docs/integrations/fastify
- https://www.better-auth.com/docs/authentication/email-password
- https://docs.expo.dev/versions/v58.0.0/ (secure-store, router `Stack.Protected`, environment variables)
- https://docs.expo.dev/develop/unit-testing.md

</canonical_refs>

<code_context>
## Existing Code Insights

### Reusable Assets
- `backend/src/auth.ts`: `secretEquals`, `parseDevAuth`, `makeAuthPreHandler` (onRequest hook, failure throttle) — extend with `session` mode.
- `backend/src/db/users.ts` `upsertUserBySub` — identity link for Better Auth users (`ba:<id>`).
- `backend/src/routes/worlds.ts`: `findOwnedWorld`, `serializeWorld`, `serializeWorldListItem`, list/get/delete already owner-scoped; `isInvalidTextRepresentation` → 404 for junk ids.
- `backend/src/worker.ts` `purgePrefix` + `purge` job; `backend/src/pipeline.ts` cancels provider on deleted worlds.
- `backend/src/config.ts` `refine()` — single boot choke point for guards; `backend/src/isolation.ts` endpoint/bucket denylists.
- `backend/scripts/dev-guard.mjs`, `migrate-dev.mjs`, `test-pg.mjs` — guarded dev DB access.
- App: `virtumetry/src/constants/theme.ts`, `themed-text`, `themed-view`, `use-theme`, `app-tabs(.web).tsx` (NativeTabs starter).

### Established Patterns
- Env loaded with `node --env-file=.env`; never print values.
- Migrations: `drizzle-kit generate` → `npm run db:migrate:dev`; prod via preDeploy `node dist/migrate.js`.
- Tests against Neon dev via `TEST_DATABASE_URL`, mock provider only.

### Integration Points
- `backend/src/server.ts` (register CORS + Better Auth handler before auth hook; exclude `/api/auth/*` from the `/v1` auth hook).
- `backend/src/provider/types.ts` + `mock.ts` (add `deleteWorld`).
- `virtumetry/src/app/_layout.tsx` (session gate), new `sign-in.tsx`, `(tabs)/index.tsx` library, `(tabs)/settings.tsx`.
- `.github/workflows/app.yml` (add jest).

</code_context>

<specifics>
## Specific Ideas

- First phase the owner tests on the phone: everything must work in Expo Go against the Railway dev HTTPS URL with nothing running locally.
- The repo is public: owner email/password only ever live in env vars / Railway variables set by the owner.
- Branding is Virtumetry's own (not SpAItial's look).

</specifics>

<deferred>
## Deferred Ideas

- Sign in with Apple (AUTH-04) — Phase 8.
- Password reset by email / forgot-password flow — not needed for owner-only v1.
- Retry failed scan (LIB-02) — Phase 6.
- Scan detail screen / viewer — Phase 5.
- Broker accounts / organization plugin — marketplace milestone.

</deferred>

---

*Phase: 03-owner-account-scan-library*
*Context gathered: 2026-11-24*
