# Phase 3: Owner Account & Scan Library - Research

**Researched:** 2026-11-24
**Domain:** Better Auth 1.7 on Fastify 5 + Drizzle/Neon, `@better-auth/expo` in Expo Go (SDK 58), Expo Router auth gating, React Query library polling, world deletion cascade, Railway dev environment
**Confidence:** HIGH for the backend and auth mechanics (read from the 1.7.27 package source and the generated schema). MEDIUM for the Railway environment steps and the jest setup for the app's Better Auth client.

## Summary

Better Auth 1.7.27 does everything Phase 3 needs. The decisive facts come from reading the published package source in this session, not from memory. (1) `emailAndPassword.disableSignUp` makes `/sign-up/email` throw `EMAIL_PASSWORD_SIGN_UP_DISABLED` **even when called server-side** through `auth.api.signUpEmail`. So `owner:create` has to copy what the sign-up route does internally: `ctx.password.hash` → `internalAdapter.createUser` → `internalAdapter.linkAccount({ providerId: 'credential', accountId: user.id, password })`, and `internalAdapter.updatePassword(userId, hash)` for a reset. (2) The `expo()` server plugin copies the client's `expo-origin` header into `Origin`. In **Expo Go** that origin is `exp://<LAN-IP>:8081` (from `Linking.createURL`). The plugin auto-trusts `exp://` **only when `NODE_ENV === "development"`**, and the bare pattern `"exp://"` matches any `exp://` origin. The Railway dev environment must therefore run with `NODE_ENV=development` or list `exp://` explicitly. The plan should list it explicitly. (3) Better Auth's rate limiter is **off unless `NODE_ENV=production`**, and by default it keys on raw `X-Forwarded-For`. Enable it explicitly and feed it Fastify's already hop-trusted `req.ip` through a header the bridge overwrites.

The backend is already well shaped for this phase. Every integration test runs in a **throwaway Postgres schema** built from the committed migrations (`test/helpers/pg-schema.ts`). The two `DELETE FROM` statements in tests run inside such schemas, so the shared Neon dev branch is safe for D-14 with no changes. Ownership already flows through `findOwnedWorld` (→ 404). Purge already exists and only needs `deleteWorld` plus a hard-delete step. Hard delete has real traps. The purge job's own `jobs` row has a foreign key to the world. `credit_events.world_id` points at the world and the budget ledger must survive. The reaper's `framesOnly` purge must never hard-delete.

On the app side, Expo Go supports everything: `expo-secure-store` and `expo-network` are SDK-58 bundled modules. The root layout becomes a `Stack` with `Stack.Protected` guards around `sign-in` and a `(tabs)` group that renders the existing `NativeTabs`. API calls use `authClient.getCookie()` with `credentials: 'omit'`. One locked decision conflicts with the repo: D-12 says to **commit `virtumetry/.env`**, but both the root `.gitignore` and `virtumetry/.gitignore` ignore `.env`. Committing it needs a negation rule, and a committed `.env` also feeds into local `eas update` bundles (see Pitfall 7).

**Primary recommendation:** Build a `createAuth({ db, config })` factory (Drizzle adapter, `disableSignUp`, allowlist `before` hook, explicit `rateLimit`, explicit `trustedOrigins`). Mount it in an encapsulated Fastify scope with a raw-buffer body parser and a Fetch-API bridge. Add `session` to `makeAuthPreHandler`. In the app, gate on `authClient.useSession()` with `Stack.Protected`.

## Architectural Responsibility Map

| Capability | Primary Tier | Secondary Tier | Rationale |
|------------|-------------|----------------|-----------|
| Credential check, session issue/revoke, sign-up refusal, allowlist (first gate) | API / Backend (Better Auth in Fastify) | Database (`user`/`session`/`account`) | Secrets and password hashes never leave the server |
| Allowlist second gate + identity link (`ba:<id>` → `users`) | API / Backend (`makeAuthPreHandler`) | Database (`users`) | Every `/v1` request resolves to exactly one `users` row (AUTH-05) |
| Session persistence across force-quit | Browser/Client (SecureStore via `expoClient`) | — | Cookie + session cache live in the iOS keychain |
| Route gating (sign-in vs tabs) | Client (Expo Router `Stack.Protected`) | — | UX only. Real enforcement is the API's 401/404 |
| Library list, states, polling | Client (React Query + pure display mapper) | API (`GET /v1/worlds`) | Server owns truth. Client maps status → copy |
| Rename | API (`PATCH /v1/worlds/:id`) | Client modal | Validation (1–80 chars) is enforced server-side |
| Delete cascade (DB + R2 + provider) | Backend worker (`purge` job) | API (soft-delete + enqueue in one tx) | Slow, retryable, must be idempotent, so it belongs in a job |
| API URL per build profile | Client config (`resolveApiUrl`, `eas.json`, `.env`) | — | Pure function, testable in jest |
| Dev backend for the phone | Railway `dev` env (api + worker) | Neon dev branch, R2 `virtumetry-dev` | Expo Go reaches an HTTPS URL with nothing running locally |

<user_constraints>
## User Constraints (from CONTEXT.md)

### Locked Decisions

#### Auth backend (Better Auth)
- **D-01:** Better Auth 1.7.x (`better-auth`) mounted in the Fastify API at `/api/auth/*` with the Drizzle adapter on Neon. `@fastify/cors` registered **before** the auth route. Better Auth's own tables (`user`, `session`, `account`, `verification`) are added to `backend/src/db/schema.ts` and created with `drizzle-kit generate` + the dev guard migrate script (never `push`); prod via Railway preDeploy.
- **D-02:** `emailAndPassword: { enabled: true, disableSignUp: true }`. No sign-up route reachable from the app or API.
- **D-03:** Allowlist: `OWNER_ALLOWLIST` env (comma-separated, trimmed, lowercased). Enforced twice: (a) in a Better Auth `before` hook on sign-in (non-allowlisted email → generic "invalid email or password" style rejection, no account-existence leak), and (b) in the API auth hook (a session whose user email is not allowlisted → 401). Empty/unset allowlist in session mode = nobody can log in (fail closed). The owner's email is **never** committed anywhere — only set as an env var by the owner.
- **D-04:** Identity linking: the existing `users` table stays the FK target of `worlds.owner_id`. On each authenticated request, `upsertUserBySub(db, 'ba:' + betterAuthUserId, email)` maps the Better Auth user to our `users` row. No change to worlds/captures ownership columns. (AUTH-05: every world belongs to exactly one `users` row; no anonymous path.)
- **D-05:** `AUTH_MODE` enum becomes `dev | session | apple`. `session` = Better Auth session cookie (sent by the Expo client as a `Cookie` header) is the app's auth. In `session` mode, `Authorization: Bearer <DEV_AUTH_TOKEN>` + `x-dev-user` is additionally accepted **only when `DEV_AUTH_TOKEN` is set**, which `refine()` already forbids under `NODE_ENV=production` — so tests and local scripts keep working while production refuses dev auth. `session` mode requires `BETTER_AUTH_SECRET` (≥32 chars) and `BETTER_AUTH_URL` at boot. Production must use `session` (or `apple`); `dev` stays refused in production.
- **D-06:** Better Auth's built-in rate limiting on (sign-in tightly limited), plus the existing per-IP failure throttle. Trusted origins include the app scheme (`virtumetry://`) and the Expo Go dev scheme (`exp://` — researcher confirms exact Expo Go handling for `@better-auth/expo`).
- **D-07:** Owner account creation: a guarded one-shot script `npm run owner:create` (backend) that reads `OWNER_EMAIL` / `OWNER_PASSWORD` from env or prompts for them (password hidden), refuses the Virtumetry prod endpoint and any denylisted host (reuse `scripts/dev-guard.mjs`), refuses an email not in `OWNER_ALLOWLIST`, and creates-or-updates (password reset) the Better Auth user via Better Auth's server API/internal adapter despite `disableSignUp`. Never prints the password. The owner runs it themselves.

#### App auth client
- **D-08:** `better-auth/react` `createAuthClient` + `@better-auth/expo` `expoClient({ scheme: 'virtumetry', storagePrefix: 'virtumetry', storage: SecureStore })`. Session persists in SecureStore → survives force-quit (AUTH-02). API calls attach `authClient.getCookie()` as the `Cookie` header. Peers `expo-secure-store`, `expo-network` installed with `npx expo install` (both are in Expo Go). Same Better Auth version in app and backend.
- **D-09:** Routing: Expo Router root layout gates on session — `Stack.Protected` (or redirect) between a `sign-in` screen and the signed-in tabs. Tabs: **Library** (home) and **Settings**. The starter `explore` screen and starter demo content are removed. Settings shows the signed-in email and a **Log out** button (confirm, then `authClient.signOut()`, clear query cache, back to sign-in) (AUTH-03).
- **D-10:** Sign-in screen: email + password fields, one primary button, inline error text, no "sign up" or "forgot password" links (owner-only v1; password reset = re-run `owner:create`).

#### API URL per build profile (success criterion 5)
- **D-11:** A pure module `virtumetry/src/config/api.ts` exports `resolveApiUrl({ appEnv, apiUrl })`: requires a URL, requires `https://` unless `appEnv === 'development'` *and* host is localhost/LAN, and **throws if `appEnv !== 'production'` and the URL's host is the production API host** (`api-production-adfc8f68.up.railway.app`). Inputs come from `EXPO_PUBLIC_APP_ENV` + `EXPO_PUBLIC_API_URL`.
- **D-12:** Create `virtumetry/eas.json` with `development`, `preview`, `production` profiles, each setting its own `env` (`EXPO_PUBLIC_APP_ENV`, `EXPO_PUBLIC_API_URL`). Commit a non-secret `virtumetry/.env` (Expo loads it for `npx expo start`) with `EXPO_PUBLIC_APP_ENV=development` and the Railway **dev** API URL, so Expo Go works with zero setup. A jest test covers each profile and the refusal. (No EAS build is run.)

#### Dev backend for the phone
- **D-13:** Add a **`dev` environment** to the existing Virtumetry Railway project (162ef8a1-…): `api` + `worker` services, Neon **dev** branch (endpoint ep-mute-fog-arwonnkz; pooler for runtime, direct for preDeploy migrate), bucket `virtumetry-dev`, `NODE_ENV=development`, `AUTH_MODE=session`, `PROVIDER_MODE=mock`, `ALLOW_PAID_PROVIDER` unset, `DEV_AUTH_TOKEN` **unset** (public URL), own `BETTER_AUTH_SECRET`, `BETTER_AUTH_URL` = the dev public domain, `OWNER_ALLOWLIST` set by the owner. Boot guards must pass (never the prod endpoint or `virtumetry-prod`). Generate a public domain for dev api. Production environment redeployed with `AUTH_MODE=session` + its own secret (allowlist may stay empty → nobody can log in to prod yet; that is fine).
- **D-14:** Shared dev DB caveat: local tests and Railway dev both use the Neon dev branch. Tests must only touch rows they create (no global truncates); researcher verifies existing tests behave.

#### Library API (backend)
- **D-15:** Existing `GET /v1/worlds` (list, owner-only, excludes soft-deleted) and `GET /v1/worlds/:id` are kept; list items gain what the library needs: `id, title, status, progress, failure_stage/code/message, created_at, updated_at (heartbeat), thumbnail_url`, and a processing **estimate** field (see D-19). Every `/:id` route resolves through `findOwnedWorld` → **404** (not 403) for another account's world.
- **D-16:** New `PATCH /v1/worlds/:id` `{ title }`: trimmed, 1–80 chars, zod-validated, owner-only, bumps `updated_at`. Rename only — no other fields.
- **D-17:** Delete: `DELETE /v1/worlds/:id` keeps soft-delete + enqueue `purge` in one transaction (library hides it immediately). The `purge` job is extended to: (1) if `provider_request_id` is set, call a new `ReconProvider.deleteWorld(requestId)` (mock records the call; live throws "Phase 6" like the rest), tolerating "already gone"; (2) purge `worlds/{id}/`, capture frames and `bundles/{captureId}/` prefixes (exists); (3) **hard-delete** the world's captures, jobs (other than the running purge) and the world row. Idempotent on retry. Automated cascade test asserts DB rows gone, storage prefixes empty, and exactly one provider delete call.
- **D-18:** Upload/approval routes are not reshaped (Phase 4). Only touch them if needed for compile/tests.

#### Library UI states (LIB-01)
- **D-19:** Display-state mapping (pure function, unit-tested):
  - `saved_on_phone` — client-only local scan (Phase 3 has no local capture source yet: the type + rendering exist and are RNTL-tested with a seeded local item; the local store is empty in practice).
  - `uploading` → "Uploading" with progress bar (`progress` %).
  - `packing | submitting | processing | importing` → "Processing" with phase label and an estimate: "About N min left" from progress when available, else "Usually 30 min – 2 h" (Echo-3 guidance). Shows "Stalled?" hint when `updated_at` is older than 15 min.
  - `ready` → "Ready" (thumbnail if present).
  - `failed` → "Failed" + human message from `failure_code`/`failure_message` and whether it was charged.
  - `cancelled` → "Cancelled" (muted).
- **D-20:** Data: `@tanstack/react-query`; list polls every 5 s only while any item is non-terminal, otherwise no polling; pull-to-refresh; empty state with a short line explaining scans appear here (no capture button yet — capture is Phase 4/7).
- **D-21:** Row actions: tapping the "…" on a row opens an Alert/action sheet with **Rename** and **Delete**. Rename opens a small modal with a TextInput (cross-platform; not `Alert.prompt`). Delete asks for confirmation ("removes it from your phone, our servers and SpAItial"), then optimistic removal with rollback on error.

#### Seed data for phone testing
- **D-22:** Guarded dev-only script `npm run seed:library` (backend) that, given `OWNER_EMAIL` from env (never committed), finds that owner's `users` row (via the Better Auth user) and inserts ~5 fixture worlds in states uploading (40%), processing (60%), ready (with a small thumbnail uploaded to `virtumetry-dev` under the world prefix), failed, cancelled. Refuses prod endpoints/buckets via the dev guard. Re-runnable (`--reset` removes only previously seeded worlds, tagged via `client_request_id` prefix `seed:`).

#### Testing
- **D-23:** App: `jest-expo@58` + Jest 30 + `@testing-library/react-native@14` (via `npx expo install … --dev`), `"jest": { "preset": "jest-expo" }`. Tests: `resolveApiUrl` profiles/refusal; display-state mapping; RNTL library list rendering each state from seeded data; session persistence (auth client configured with SecureStore — mock `expo-secure-store`, assert stored session is read on boot); sign-in screen error path. App CI (`.github/workflows/app.yml`) adds `npx jest --ci`. Every command bounded (no watch mode).
- **D-24:** Backend (vitest, Neon dev via `TEST_DATABASE_URL`): sign-in allowed for allowlisted email, rejected for non-allowlisted, sign-up endpoint refused; session cookie authenticates `/v1/worlds`; two-account ownership tests (list/get/patch/delete of another's world → 404, list never shows it); rename validation; deletion cascade (D-17); config tests: `session` mode requires secrets, prod refuses dev auth. Existing suite stays green; `tsc --noEmit` clean.

### Claude's Discretion
- Exact Better Auth integration mechanics (Fastify handler bridging, cookie vs bearer plugin) — follow official Fastify + Expo docs; prefer cookie via `getCookie()`.
- Plan split / waves, file layout under `virtumetry/src/` (non-route code outside `src/app/`).
- Visual details are fixed by the UI-SPEC (gsd-ui-phase), own Virtumetry branding.

### Deferred Ideas (OUT OF SCOPE)
- Sign in with Apple (AUTH-04) — Phase 8.
- Password reset by email / forgot-password flow — not needed for owner-only v1.
- Retry failed scan (LIB-02) — Phase 6.
- Scan detail screen / viewer — Phase 5.
- Broker accounts / organization plugin — marketplace milestone.
</user_constraints>

<phase_requirements>
## Phase Requirements

| ID | Description | Research Support |
|----|-------------|------------------|
| AUTH-01 | Email+password login, sign-up disabled, allowlist only | `disableSignUp` blocks the route and server calls (verified source). Allowlist `before` hook on `/sign-in/email` throws the same `INVALID_EMAIL_OR_PASSWORD` the real route uses. Second gate in `makeAuthPreHandler`. `owner:create` uses internalAdapter (Pattern 4) |
| AUTH-02 | Session survives restart (SecureStore) | `expoClient` stores the cookie under `virtumetry_cookie` and the session cache under `virtumetry_session_data` in SecureStore, then rehydrates before `/get-session` (verified source). Expo Go ships `expo-secure-store` ~58.0.3 |
| AUTH-03 | Log out from Settings | `authClient.signOut()` → server deletes the session row even when it is already invalid. The client clears both SecureStore keys on success. Network-failure fallback in Pattern 8 |
| AUTH-05 | Every scan belongs to one account | `ba:<id>` → `users.apple_sub` upsert per request. `worlds.owner_id NOT NULL`. `findOwnedWorld` → 404. No anonymous path, because `/v1` sits entirely inside the authed scope |
| LIB-01 | Library with honest states | List item gains `failure_*`, `charged`, `heartbeat_at` (exists), `thumbnail_url` (exists). Pure `toDisplayState()`. React Query `refetchInterval` function |
| LIB-03 | Rename + delete (DB + storage + provider) | `PATCH` route. Purge extended with `deleteWorld` + ordered hard delete (Pattern 6) |
</phase_requirements>

## Project Constraints (from CLAUDE.md)

- Windows dev machine. No Mac. iOS native builds only on EAS. **Never run `eas build` without asking.** Phase 3 needs no build: everything runs in Expo Go.
- Always `npx expo install <pkg>` in `virtumetry/`. Run `npx expo lint` and `npx tsc --noEmit` before declaring done (virtumetry/AGENTS.md).
- Fetch versioned Expo docs (SDK 58). Do not trust memory for Expo APIs.
- Routes only in `src/app/`. Non-route code (auth client, api, display mapper, config) goes outside it. Tests must not live in `src/app/`.
- Money: mock provider only. Never call real SpAItial. `PROVIDER_MODE=live` is refused without `ALLOW_PAID_PROVIDER=1`.
- Data isolation: never touch VirtSpace. The dev env never uses the prod Neon endpoint or `virtumetry-prod` (enforced by `config.ts refine()` and `scripts/dev-guard.mjs`).
- Never print `.env` values. Never run `railway variable list`. Use `--stdin` for secrets (Phase 1 practice).
- Privacy: the repo is public. The owner email and password live only in env vars and Railway variables.
- Branding: Virtumetry's own (UI-SPEC is approved).
- Don't upgrade VirtSpace-copied deps (vitest 2, TS 5) in this phase.
- GSD workflow: edits only through GSD execute commands.

## Standard Stack

### Core
| Library | Version | Purpose | Why Standard |
|---------|---------|---------|--------------|
| `better-auth` | 1.7.27 (published 2026-11-20) [VERIFIED: npm registry] | Server auth + `better-auth/react` client | Locked (D-01). Peer `drizzle-orm ^0.45.2` matches installed 0.45.2. Peer `vitest 2–5` allows our vitest 2 [VERIFIED: npm view peerDependencies] |
| `@better-auth/expo` | 1.7.27 [VERIFIED: npm registry] | `expo()` server plugin + `expoClient` | Locked (D-08). Peers: `better-auth ^1.7.27`, `@better-auth/core ^1.7.27`, `better-call ~1.4.5`. Expo peers are optional [VERIFIED: npm view] |
| `@fastify/cors` | 11.4.3 [VERIFIED: npm registry] | CORS before the auth route | Locked (D-01), Better Auth Fastify guide [CITED: better-auth.com/docs/integrations/fastify] |
| `expo-secure-store` | ~58.0.3 [VERIFIED: expo/bundledNativeModules.json] | Cookie/session storage | Required by `expoClient` storage. In Expo Go |
| `expo-network` | ~58.0.5 [VERIFIED: bundledNativeModules.json] | Online detection used by `expoClient` | The client dynamically `import("expo-network")` and falls back to "online" if missing [VERIFIED: client.js source]. Install anyway (docs say required) |
| `@tanstack/react-query` | 5.108.4 [VERIFIED: npm registry] | Library list, polling, optimistic delete | CLAUDE.md stack. `refetchInterval` accepts `(query) => number \| false` [CITED: tanstack.com useQuery reference] |

### Supporting / Dev
| Library | Version | Purpose | When to Use |
|---------|---------|---------|-------------|
| `jest-expo` | ~58.0.15 [VERIFIED: bundledNativeModules.json] | Jest preset | App tests |
| `jest` + `@types/jest` | 30.x (SDK 58 requires Jest 30) [CITED: docs.expo.dev/develop/unit-testing] | Runner | — |
| `@testing-library/react-native` | 14.1.0 [VERIFIED: npm registry] | Component + router tests | v14+ required on SDK 58 [CITED: docs.expo.dev/router/reference/testing] |
| `auth` (Better Auth CLI) | 1.7.27 [VERIFIED: npm registry; docs use `npx auth@latest generate`] | One-off schema generation (already done in research, output below) | Optional. `@better-auth/cli` is stale at 1.4.21, so don't use it |

No new backend runtime dependency besides `better-auth` and `@fastify/cors`. Use `better-auth/adapters/drizzle` (a re-export inside `better-auth`, which already depends on `@better-auth/drizzle-adapter`) [VERIFIED: package.json exports `./adapters/drizzle`]. Use `better-auth/node` for `fromNodeHeaders`.

### Alternatives Considered
| Instead of | Could Use | Tradeoff |
|------------|-----------|----------|
| Fetch-API bridge (official Fastify guide) | `toNodeHandler` + `reply.hijack()` | Bypasses Fastify's reply pipeline (rate-limit headers, error handler). Stick with the guide |
| Cookie via `getCookie()` | `bearer()` plugin | Locked preference: cookie |
| Session cookie DB lookup per request | `session.cookieCache` | Adds a second signed cookie. Owner-only traffic is tiny. Skip |

**Installation:**
```bash
# backend/
npm install better-auth@1.7.27 @fastify/cors@11.4.3
# virtumetry/
npx expo install better-auth @better-auth/expo expo-secure-store expo-network @tanstack/react-query
npx expo install jest-expo jest @types/jest @testing-library/react-native --dev
```
Pin `better-auth` and `@better-auth/expo` to the **same exact version** in the app and backend (`1.7.27`). `npx expo install` resolves non-Expo packages to npm latest, so check the lockfile afterwards.

## Package Legitimacy Audit

slopcheck could not be installed in this environment, so per protocol every package is tagged `[ASSUMED]`. All of them are named in official docs (Better Auth Expo/Fastify guides, Expo unit-testing guide, TanStack docs, `expo/bundledNativeModules.json`). None has a `postinstall` script (`npm view <pkg> scripts.postinstall` was empty for all).

| Package | Registry | Age | Downloads | Source Repo | slopcheck | Disposition |
|---------|----------|-----|-----------|-------------|-----------|-------------|
| better-auth | npm | ~2 yrs, 1.7.27 on 2026-11-20 | high | github.com/better-auth/better-auth | unavailable | Approved [ASSUMED], doc-named |
| @better-auth/expo | npm | 1.7.27 on 2026-11-20 | — | same monorepo | unavailable | Approved [ASSUMED], doc-named |
| @fastify/cors | npm | many yrs | high | github.com/fastify/fastify-cors | unavailable | Approved [ASSUMED] |
| expo-secure-store / expo-network / jest-expo | npm | Expo SDK | high | github.com/expo/expo | unavailable | Approved [ASSUMED], in SDK 58 bundledNativeModules |
| @tanstack/react-query | npm | many yrs | very high | github.com/TanStack/query | unavailable | Approved [ASSUMED] |
| jest, @types/jest, @testing-library/react-native | npm | many yrs | very high | jestjs / callstack | unavailable | Approved [ASSUMED] |

**Packages removed due to slopcheck [SLOP] verdict:** none
**Packages flagged as suspicious [SUS]:** none. The planner should still gate installs per protocol, because slopcheck was unavailable.

## Architecture Patterns

### System Architecture Diagram

```
iPhone (Expo Go)                                   Railway "dev" env (HTTPS)                  Neon dev / R2 dev
───────────────                                    ─────────────────────────                  ─────────────────
sign-in screen ──authClient.signIn.email──► POST /api/auth/sign-in/email
  (expoClient adds expo-origin: exp://LAN:8081)       │ expo() plugin: expo-origin → Origin
                                                      │ origin check vs trustedOrigins [exp://, virtumetry://]
                                                      │ rate limit (key = x-vm-client-ip = Fastify req.ip)
                                                      │ before hook: email ∈ OWNER_ALLOWLIST? else 401 generic
                                                      │ verify scrypt hash ───────────────────────────► user/account/session
  ◄── Set-Cookie: __Secure-better-auth.session_token ─┘
SecureStore[virtumetry_cookie, virtumetry_session_data]

Library tab ──fetch GET /v1/worlds  Cookie: getCookie()  credentials:'omit'──►  authed scope onRequest:
  React Query, refetchInterval 5s while any non-terminal   │ session mode: auth.api.getSession(headers)
                                                           │   null → 401 (throttle.record)
                                                           │   email ∉ allowlist → 401
                                                           │   upsertUserBySub('ba:'+user.id) → req.userId
                                                           │ (DEV_AUTH_TOKEN set? Bearer+x-dev-user also ok)
                                                           ▼
                                               worlds routes (owner-scoped; foreign id → 404) ──► worlds
  PATCH /v1/worlds/:id {title}  ──────────────►  zod 1..80 → UPDATE … WHERE id AND owner_id
  DELETE /v1/worlds/:id ──────────────────────►  tx{ soft-delete; enqueue purge }
                                                           │
                                               worker: purge job
                                                 1 provider.deleteWorld(rid) (mock records; 404 = gone)
                                                 2 purgePrefix worlds/{id}/, captures/{cid}/, bundles/{cid}/ ──► R2
                                                 3 tx{ share_slugs del; credit_events.world_id=NULL;
                                                       jobs del (incl. self); captures del; worlds del } ──► Neon
  401 anywhere → signOut + queryClient.clear() → Stack.Protected shows sign-in
```

### Recommended Project Structure
```
backend/src/
├── auth/better-auth.ts      # createAuth({db, config}), isAllowlisted(), parseAllowlist()
├── auth.ts                  # makeAuthPreHandler: + session mode (existing file)
├── routes/auth-handler.ts   # encapsulated scope: raw parser + Fetch bridge at /api/auth/*
├── routes/worlds.ts         # + PATCH, list item fields
├── provider/{types,mock,index}.ts   # + deleteWorld
├── worker.ts                # purge: deleteWorld + hardDeleteWorld()
└── db/schema.ts             # + user, session, account, verification (timestamptz)
backend/scripts/owner-create.ts, seed-library.ts   # guarded via dev-guard.mjs
backend/drizzle/0003_*.sql   # drizzle-kit generate
virtumetry/src/
├── app/_layout.tsx          # QueryClientProvider + Stack.Protected gate
├── app/sign-in.tsx
├── app/(tabs)/_layout.tsx   # renders <AppTabs/> (NativeTabs)
├── app/(tabs)/index.tsx     # Library
├── app/(tabs)/settings.tsx
├── lib/auth-client.ts       # createAuthClient + expoClient
├── lib/api.ts               # apiFetch (cookie, 401 handling), worlds queries/mutations
├── config/api.ts            # resolveApiUrl (pure) + API_URL
├── library/display-state.ts # toDisplayState (pure)
└── __tests__/…              # jest (never under src/app)
virtumetry/eas.json, virtumetry/.env (see Pitfall 7)
```

### Pattern 1: Better Auth factory (backend)
```ts
// backend/src/auth/better-auth.ts. Option names verified against 1.7.27 types/source.
import { betterAuth } from 'better-auth';
import { drizzleAdapter } from 'better-auth/adapters/drizzle';
import { APIError, createAuthMiddleware } from 'better-auth/api';
import { expo } from '@better-auth/expo';
import { user, session, account, verification } from '../db/schema.js';

export const parseAllowlist = (raw?: string) =>
  new Set((raw ?? '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean));

export function createAuth({ db, config }: { db: Db; config: Config }) {
  const allow = parseAllowlist(config.OWNER_ALLOWLIST);
  return betterAuth({
    secret: config.BETTER_AUTH_SECRET,
    baseURL: config.BETTER_AUTH_URL,           // basePath defaults to /api/auth
    database: drizzleAdapter(db, { provider: 'pg', schema: { user, session, account, verification } }),
    emailAndPassword: { enabled: true, disableSignUp: true },
    plugins: [expo()],
    // Explicit: expo() only auto-adds exp:// when NODE_ENV==='development'.
    trustedOrigins: ['virtumetry://', ...(config.NODE_ENV === 'production' ? [] : ['exp://'])],
    rateLimit: {
      enabled: config.AUTH_RATE_LIMIT !== '0',  // default is off outside production
      window: 60, max: 100,
      customRules: { '/sign-in/email': { window: 60, max: 5 } },
    },                                            // memory storage: api is single replica
    advanced: { ipAddress: { ipAddressHeaders: ['x-vm-client-ip'] } }, // set by our bridge
    hooks: {
      before: createAuthMiddleware(async (ctx) => {
        if (ctx.path !== '/sign-in/email') return;
        const email = String(ctx.body?.email ?? '').trim().toLowerCase();
        if (!allow.has(email)) {
          throw new APIError('UNAUTHORIZED', {
            message: 'Invalid email or password', code: 'INVALID_EMAIL_OR_PASSWORD',
          }); // byte-identical to the real failure (core/error/codes INVALID_EMAIL_OR_PASSWORD)
        }
      }),
    },
  });
}
export type Auth = ReturnType<typeof createAuth>;
```
Notes: telemetry is **off by default** (`telemetry.enabled ?? false` and the env var defaults false) [VERIFIED: @better-auth/telemetry source]. Session defaults: `expiresIn` 7 days, `updateAge` 1 day [VERIFIED: init-options.d.mts], which is fine for v1.

### Pattern 2: Fastify bridge (encapsulated, raw body, multi Set-Cookie safe)
```ts
// backend/src/routes/auth-handler.ts. Same raw-parser pattern as routes/webhooks.ts.
import cors from '@fastify/cors';
import { fromNodeHeaders } from 'better-auth/node';
export async function authHandlerRoutes(app: FastifyInstance, { auth, config }: { auth: Auth; config: Config }) {
  await app.register(async (scope) => {
    await scope.register(cors, { origin: false }); // no browser origin needs auth yet (web share page is later)
    scope.removeAllContentTypeParsers();
    scope.addContentTypeParser('*', { parseAs: 'buffer', bodyLimit: 64 * 1024 }, (_r, b, done) => done(null, b));
    scope.route({
      method: ['GET', 'POST'], url: '/api/auth/*',
      async handler(req, reply) {
        const headers = fromNodeHeaders(req.headers);
        headers.set('x-vm-client-ip', req.ip);           // overwrite any client value
        const body = req.body as Buffer | undefined;
        const res = await auth.handler(new Request(new URL(req.url, config.BETTER_AUTH_URL), {
          method: req.method, headers, body: body && body.length ? body : undefined,
        }));
        reply.status(res.status);
        res.headers.forEach((v, k) => { if (k !== 'set-cookie') reply.header(k, v); });
        const cookies = res.headers.getSetCookie();       // forEach would comma-join cookies
        if (cookies.length) reply.header('set-cookie', cookies);
        return reply.send(Buffer.from(await res.arrayBuffer()));
      },
    });
  });
}
```
Register it in `registerRoutes` **outside** the authed scope (like webhooks) and after the global rate limiter. Build the URL from `BETTER_AUTH_URL`, not `req.protocol`/host: Railway terminates TLS, so Fastify sees `http`.

### Pattern 3: `session` mode in `makeAuthPreHandler`
```ts
if (config.AUTH_MODE === 'session') {
  if (config.DEV_AUTH_TOKEN && req.headers['authorization']) { /* existing dev branch */ }
  const s = await auth.api.getSession({ headers: fromNodeHeaders(req.headers) }).catch(() => null);
  if (!s) return fail(401, 'unauthenticated');
  if (!allow.has(s.user.email.toLowerCase())) return fail(401, 'unauthenticated');
  const u = await upsertUserBySub(getDb(), `ba:${s.user.id}`, s.user.email);
  if (u.deletedAt) return replyAccountDeleted(reply);
  throttle?.reset(ip); req.userId = u.id; return;
}
```
`makeAuthPreHandler(config, throttle)` needs the `auth` instance. Thread it through `RouteDeps`, and create it once in `buildServer` (`createAuth({ db: getDb(), config })`). `getDb()` only constructs a Pool and doesn't connect, so `/healthz` without a DB keeps working.

### Pattern 4: `owner:create` despite `disableSignUp`
```ts
// backend/scripts/owner-create.ts: node --env-file=.env --import tsx scripts/owner-create.ts
// assertDevDb('MIGRATE_DATABASE_URL') first; build db on that URL; email must be in OWNER_ALLOWLIST.
const ctx = await auth.$context;
const email = OWNER_EMAIL.trim().toLowerCase();
const hash = await ctx.password.hash(password);
const found = await ctx.internalAdapter.findUserByEmail(email);
if (!found) {
  const u = await ctx.internalAdapter.createUser({ email, name: 'Owner', emailVerified: true });
  await ctx.internalAdapter.linkAccount({ userId: u.id, providerId: 'credential', accountId: u.id, password: hash });
} else if (!found.accounts.some((a) => a.providerId === 'credential')) {
  await ctx.internalAdapter.linkAccount({ userId: found.user.id, providerId: 'credential', accountId: found.user.id, password: hash });
} else {
  await ctx.internalAdapter.updatePassword(found.user.id, hash);   // matches on providerId=credential, accountId=userId
}
console.log('owner account ready');  // never echo the email or password
```
Source: `api/routes/sign-up.mjs` (the exact sequence) and `db/internal-adapter.mjs` (`createUser`, `findUserByEmail`, `linkAccount`, `updatePassword`) in better-auth 1.7.27 [VERIFIED]. Hidden password prompt: Node has no built-in one, so use `readline` with `_writeToOutput` muted (~10 lines) or read env only. Revoking old sessions on reset is optional (`internalAdapter.deleteSessions(userId)`).

### Pattern 5: Better Auth tables (generated by `npx auth generate` 1.7.27 in this session)
`user(id text pk, name text not null, email text not null unique, email_verified bool default false not null, image text, created_at, updated_at)`. `session(id text pk, expires_at not null, token text not null unique, created_at, updated_at, ip_address, user_agent, user_id text not null → user.id on delete cascade)` with index `session_userId_idx`. `account(id, account_id, provider_id, user_id → user cascade, access_token, refresh_token, id_token, access_token_expires_at, refresh_token_expires_at, scope, password, created_at, updated_at)` with index `account_userId_idx`. `verification(id, identifier, value, expires_at, created_at, updated_at)` with index `verification_identifier_idx`. Text ids, generated by Better Auth. Table `user` (singular) does not collide with our `users`. Paste into `schema.ts` with **`timestamp(..., { withTimezone: true })`** (Pitfall 4). Relations are only needed with `advanced.database.joins`, which we skip. The CLI emits `$onUpdate` on `updated_at`. Keep it.

### Pattern 6: Purge with provider delete + ordered hard delete
```ts
async function handlePurge(deps, job) {
  const framesOnly = /* existing */;
  const w = await getWorldRaw(db, job.worldId);          // includes soft-deleted
  if (!w) return completeJob(...);                      // already hard-deleted: idempotent
  if (!framesOnly && w.providerRequestId) {
    try { await provider.deleteWorld(w.providerRequestId); }
    catch (e) { if (!(e instanceof ProviderError && e.status === 404)) throw e; } // gone = ok
  }
  /* existing prefix purges */
  if (framesOnly) { /* existing poses_json null */ return completeJob(...); }  // reaper: NEVER hard-delete
  await db.transaction(async (tx) => {
    await tx.delete(shareSlugs).where(eq(shareSlugs.worldId, w.id));
    await tx.update(creditEvents).set({ worldId: null }).where(eq(creditEvents.worldId, w.id)); // keep ledger
    await tx.delete(jobs).where(eq(jobs.worldId, w.id));   // includes THIS purge job row
    await tx.delete(captures).where(eq(captures.worldId, w.id));
    await tx.delete(worlds).where(and(eq(worlds.id, w.id), isNotNull(worlds.deletedAt)));
  });
  // no completeJob: the row is gone (completeJob would be a 0-row UPDATE anyway)
}
```
FK graph verified in `schema.ts`: `captures`, `jobs`, `share_slugs` have NOT NULL FKs to `worlds` without ON DELETE. `credit_events.world_id` is nullable. `webhook_deliveries` has no FK (keep it, it holds no personal data). The budget guard sums `credit_events.amount` by date, so nulling `world_id` leaves the daily and monthly caps correct. Guarding the world delete on `deleted_at IS NOT NULL` means a stray purge can never remove a live world. Mock `deleteWorld`: `calls.deleteWorld.push(requestId)`, and throw the mock's existing `NOT_FOUND` 404 for an unknown id. Live: `throw new Error('no live provider in this build (Phase 6)')`, which already happens in `createProvider`.

### Pattern 7: App auth client + API fetch
```ts
// virtumetry/src/lib/auth-client.ts
import { createAuthClient } from 'better-auth/react';
import { expoClient } from '@better-auth/expo/client';
import * as SecureStore from 'expo-secure-store';
import { API_URL } from '@/config/api';
export const authClient = createAuthClient({
  baseURL: API_URL,                                  // client appends /api/auth
  plugins: [expoClient({ scheme: 'virtumetry', storagePrefix: 'virtumetry', storage: SecureStore })],
});
// virtumetry/src/lib/api.ts
export async function apiFetch(path: string, init: RequestInit = {}) {
  const res = await fetch(`${API_URL}${path}`, {
    ...init, credentials: 'omit',                    // docs: 'include' interferes with the manual cookie
    headers: { ...init.headers, Cookie: await authClient.getCookie(), 'content-type': 'application/json' },
  });
  if (res.status === 401) { await onUnauthorized(); throw new UnauthorizedError(); }
  if (!res.ok) throw new ApiError(res.status);
  return res.json();
}
```
[CITED: better-auth.com/docs/integrations/expo], storage keys `${storagePrefix}_cookie` / `${storagePrefix}_session_data` [VERIFIED: client.js]. Expo Go: the client reads `Constants.expoConfig.scheme` if `scheme` is omitted. We pass it.

### Pattern 8: Root gate (Stack.Protected) + 401
```tsx
// src/app/_layout.tsx
SplashScreen.preventAutoHideAsync();
export default function Root() {
  const { data, isPending } = authClient.useSession();
  useEffect(() => { if (!isPending) SplashScreen.hideAsync(); }, [isPending]);
  if (isPending) return null;
  return (
    <QueryClientProvider client={queryClient}>
      <Stack screenOptions={{ headerShown: false }}>
        <Stack.Protected guard={!!data}><Stack.Screen name="(tabs)" /></Stack.Protected>
        <Stack.Protected guard={!data}><Stack.Screen name="sign-in" /></Stack.Protected>
      </Stack>
    </QueryClientProvider>
  );
}
```
[CITED: docs.expo.dev/router/advanced/authentication]. `(tabs)/_layout.tsx` returns the existing `<AppTabs/>` with triggers `index` + `settings` (`NativeTabs.Trigger.Icon sf={{ default, selected }}`) [CITED: docs.expo.dev/router/advanced/native-tabs]. Keep `ThemeProvider` and `AnimatedSplashOverlay` only if still used. `onUnauthorized`: `await authClient.signOut().catch(() => {})`. Sign-out succeeds server-side even for an invalid session [VERIFIED: sign-out.mjs]. If the network call fails, delete both SecureStore keys and call `authClient.$store.notify('$sessionSignal')` so `useSession` refetches to null. Then `queryClient.clear()` and set the "session ended" notice flag.

### Pattern 9: Polling only while non-terminal
```ts
const TERMINAL = new Set(['ready', 'failed', 'cancelled']);
useQuery({
  queryKey: ['worlds'], queryFn: () => apiFetch('/v1/worlds?limit=100'),
  refetchInterval: (q) => q.state.data?.worlds.some((w) => !TERMINAL.has(w.status)) ? 5000 : false,
});
// once at app root: focusManager + AppState so polling pauses in background
AppState.addEventListener('change', (s) => Platform.OS !== 'web' && focusManager.setFocused(s === 'active'));
```
[CITED: tanstack.com/query/latest/docs/framework/react/react-native]. `refetchIntervalInBackground` defaults to false. `@better-auth/expo` installs its own focus/online managers for its session atom, not React Query's, so wire React Query separately.

### Pattern 10: Pure `resolveApiUrl` + eas.json
```ts
export const PROD_API_HOST = 'api-production-adfc8f68.up.railway.app';
export function resolveApiUrl({ appEnv, apiUrl }: { appEnv?: string; apiUrl?: string }): string {
  if (!apiUrl) throw new Error('EXPO_PUBLIC_API_URL is required');
  const u = new URL(apiUrl);
  const local = /^(localhost|127\.0\.0\.1|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(u.hostname);
  if (u.protocol !== 'https:' && !(appEnv === 'development' && local)) throw new Error('API URL must be https');
  if (appEnv !== 'production' && u.hostname === PROD_API_HOST) throw new Error('non-production build refuses the production API');
  return u.origin;
}
export const API_URL = resolveApiUrl({
  appEnv: process.env.EXPO_PUBLIC_APP_ENV, apiUrl: process.env.EXPO_PUBLIC_API_URL, // static refs only
});
```
Expo inlines only `process.env.EXPO_PUBLIC_X` dot-access (no destructuring) [CITED: docs.expo.dev/guides/environment-variables]. In `eas.json`, each of `development` / `preview` / `production` sets **both** vars in `env`. The jest test parses `eas.json` + `.env` and runs `resolveApiUrl` per profile.

### Anti-Patterns to Avoid
- **Calling `auth.api.signUpEmail` from `owner:create`:** throws `EMAIL_PASSWORD_SIGN_UP_DISABLED` [VERIFIED].
- **Letting Fastify's JSON parser feed the bridge:** an empty-body `POST` with `content-type: application/json` (e.g. sign-out) is a Fastify 400 `FST_ERR_CTP_EMPTY_JSON_BODY` [ASSUMED from Fastify behavior]. Re-serialized JSON is not the original bytes. Use the scoped raw parser.
- **Copying response headers with `forEach` only:** joins multiple `Set-Cookie` into one header. Use `getSetCookie()`.
- **Hard-deleting on the reaper's `framesOnly` purge:** the reaper keeps the row by design.
- **Computing "stalled"/estimate copy on the server:** the UI-SPEC copy lives in the pure client mapper.
- **A `(tabs)` group *and* top-level `index.tsx`:** move `src/app/index.tsx` into `(tabs)/` and delete `explore.tsx`, otherwise `/` is ambiguous.

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| Password hashing | bcrypt/scrypt wrapper | `ctx.password.hash` (Better Auth scrypt) | Hash format must match what sign-in verifies |
| Session cookies, CSRF/origin check | custom JWT/cookie | Better Auth session + origin middleware | Signed cookies, `__Secure-` prefix on https, Fetch-Metadata CSRF |
| Cookie persistence on device | AsyncStorage token juggling | `expoClient` + SecureStore | Keychain, expiry filtering, session cache rehydrate |
| Polling/backoff/optimistic rollback | `setInterval` + state | React Query `refetchInterval`, `onMutate`/`onError` | Focus-aware, dedupes |
| Client IP for rate-limit | parse X-Forwarded-For | Fastify `req.ip` (existing hop-trusted) → `x-vm-client-ip` | Already measured (`TRUST_PROXY_HOPS=2` prod) |
| Dev DB guard in scripts | new checks | `scripts/dev-guard.mjs` `assertDevDb` / `assertDevBucket` | Existing, mirrors `isolation.ts` |
| Prefix deletion in R2 | new loop | `purgePrefix` (worker.ts) | Existing, idempotent |

**Key insight:** almost all of the auth risk is in the glue (body bytes, cookies, origin, IP), not the crypto. Keep the bridge small and test it through `app.inject` against a real schema.

## Common Pitfalls

### Pitfall 1: Expo Go origin rejected (403 INVALID_ORIGIN)
**What goes wrong:** sign-in works in curl but fails from the phone.
**Why:** `expoClient` sends `expo-origin: exp://<LAN-IP>:8081` (Expo Go ignores the custom scheme). The `expo()` plugin turns it into `Origin`. Origin is force-validated on first login when an Origin is present, and on every cookie-bearing POST. `exp://` is auto-trusted only when `NODE_ENV=development`. The Dockerfile sets `ENV NODE_ENV=production`, so the Railway dev env must override it with a variable.
**Avoid:** list `exp://` explicitly in `trustedOrigins` for non-production configs. The bare `exp://` pattern matches any authority [VERIFIED: trusted-origins.mjs `matchesOriginPattern`].
**Warning sign:** server log "Invalid origin: exp://…".

### Pitfall 2: Better Auth rate limit silently off / spoofable
**Why:** `enabled` defaults to `isProduction`. Railway dev and vitest are not production. The IP comes from `x-forwarded-for` (client-controllable leftmost) [VERIFIED: core utils/ip.mjs].
**Avoid:** set `rateLimit.enabled: true` explicitly and use `ipAddressHeaders: ['x-vm-client-ip']` set by the bridge from `req.ip`. Tests that sign in repeatedly will trip `/sign-in/email` max 5/60 s. Either give each test a distinct `remoteAddress` in `app.inject`, or expose `AUTH_RATE_LIMIT=0` for tests only (refuse it in production in `refine()`).

### Pitfall 3: Worker refuses to boot after `AUTH_MODE=session`
**Why:** the worker goes through the same `refine()`. If `session` requires `BETTER_AUTH_SECRET`/`BETTER_AUTH_URL`, the worker needs them too. Leaving `AUTH_MODE` unset on the worker → default `dev` → refused in production.
**Avoid:** set `AUTH_MODE=session` and both secrets on **both** services (Railway reference variable `${{api.BETTER_AUTH_SECRET}}` [ASSUMED syntax]). Or relax the check for `SERVICE_ENTRY=worker`, which is less simple. Also update the prod error text "set AUTH_MODE=apple" to mention session.

### Pitfall 4: `timestamp without time zone` + node-pg local-time parsing
**Why:** the CLI output uses plain `timestamp`. node-pg reads those as **local** time. `owner:create` runs on a Windows laptop (non-UTC) while Railway runs UTC, so session and account timestamps shift by the offset [ASSUMED: node-pg default type parser behavior].
**Avoid:** `{ withTimezone: true }` on every Better Auth timestamp column (also the repo convention). Better Auth reads and writes `Date` objects either way.

### Pitfall 5: Hard delete breaks FKs / ledger / idempotency
**Why:** the purge job's own `jobs` row references the world. `credit_events` references it. After hard delete, `findWorldByClientRequestId` can no longer return 409 for a deleted world's idempotency key, so a replayed create would mint a new world.
**Avoid:** Pattern 6 order. Null `credit_events.world_id`. Accept the idempotency loss: the client deletes its local scan too, and Phase 4 reshapes create anyway. Note it in the plan.

### Pitfall 6: Custom fetches don't refresh the cookie
**Why:** only Better Auth client calls (`/get-session` etc.) store refreshed `Set-Cookie`. Our `/v1` calls drop it. `getCookie()` skips cookies past their stored expiry [VERIFIED: client.js `getCookie`].
**Avoid:** rely on `useSession()` (it refetches on app focus through the expo focus manager). 7-day expiry with a 1-day `updateAge` is plenty for an owner who opens the app.

### Pitfall 7: Committing `virtumetry/.env` (D-12)
**Why:** root `.gitignore` (`.env`, `.env.*`) and `virtumetry/.gitignore` (`.env`) both ignore it [VERIFIED: `git check-ignore -v virtumetry/.env` → virtumetry/.gitignore:46]. Expo's FAQ warns that committed `.env` files cause "confusing overrides during cloud jobs". `eas update` bundles locally with whatever `.env` exists [CITED: docs.expo.dev/eas/environment-variables/faq].
**Avoid:** add `!.env` after the `.env` line in `virtumetry/.gitignore` and `!virtumetry/.env` in the root file, keep the file to the two public `EXPO_PUBLIC_*` keys, and have every eas.json profile set both vars. The jest config test asserts each profile defines both, so `.env` never decides a build's target. Simpler alternative if the planner prefers (needs owner OK, since D-12 is locked): don't commit `.env`, and default `API_URL` to the dev URL in code when `EXPO_PUBLIC_APP_ENV` is unset.

### Pitfall 8: Jest can't parse Better Auth's ESM
**Why:** `better-auth`, `@better-auth/*`, `better-call`, `nanostores`, `@better-fetch/fetch` ship ESM. The jest-expo default `transformIgnorePatterns` doesn't include them [ASSUMED].
**Avoid:** UI tests `jest.mock('@/lib/auth-client')`. The single persistence test imports the real client with `transformIgnorePatterns` extended by `better-auth|@better-auth/.*|better-call|nanostores|@better-fetch/.*`. Mock `expo-secure-store` with an in-memory map (`getItemAsync`/`setItemAsync`/`deleteItemAsync`).

### Pitfall 9: Railway environment creation copies prod secrets
**Why:** "Duplicate Environment … including services, variables" (staged, not auto-deployed) [CITED: docs.railway.com/environments]. A duplicate would carry the prod `DATABASE_URL` and `S3_BUCKET=virtumetry-prod` into dev.
**Avoid:** `railway environment new dev` (**empty**), then `railway config plan --environment dev` and read the diff (expect create api + worker, no deletes), then `railway config apply --environment dev`. Set variables with `railway variable set … -e dev -s <svc> --skip-deploys` (`--stdin` for secrets), run `railway domain -s api -e dev`, then `railway up -s api -e dev --ci` and the same for worker. The IaC file is diffed against the **selected environment only** (`--environment` flag verified in CLI 5.75 help). Phase 1's Windows workaround for `config plan` (`env _=…railway.exe`) may still be needed.

### Pitfall 10: Local Node is 22, backend `engines` says >=24
Local `node -v` = v22.21.1. Backend CI uses 24. `Response.headers.getSetCookie()` exists in Node ≥19.7, so it's fine on both [ASSUMED]. Don't rely on Node-24-only APIs in scripts the owner runs locally.

## Code Examples

### Two-account ownership + session cookie integration test (shape)
```ts
// backend/test/integration/auth-session.pg.test.ts
let currentDb: unknown;
vi.mock('../../src/db/client.js', () => ({ getDb: () => currentDb }));
describe.skipIf(!process.env.TEST_DATABASE_URL)('session auth', () => {
  // createTestSchema(url) → currentDb = schema.db; auth = createAuth({ db: schema.db, config })
  // seed two owners via the owner-create helper (internalAdapter) — both allowlisted
  // POST /api/auth/sign-in/email (json, origin 'virtumetry://') → set-cookie → cookie A
  // GET /v1/worlds with Cookie A → 200, only A's worlds
  // GET/PATCH/DELETE /v1/worlds/<B's id> with Cookie A → 404
  // sign-in non-allowlisted → 401 body.code === 'INVALID_EMAIL_OR_PASSWORD'
  // POST /api/auth/sign-up/email → 400 code EMAIL_PASSWORD_SIGN_UP_DISABLED
});
```
Pattern source: `test/worlds.idempotency.test.ts` (getDb mock) + `test/helpers/pg-schema.ts` (throwaway schema from real migrations, so the new `0003` auth migration is exercised automatically).

### Display-state mapper signature
```ts
export type DisplayState =
  | { kind: 'saved_on_phone' } | { kind: 'uploading'; progress: number | null }
  | { kind: 'processing'; phaseLabel: string; estimate: string; stalledMin: number | null }
  | { kind: 'ready' } | { kind: 'failed'; message: string; chargeNote: string } | { kind: 'cancelled' };
export function toDisplayState(item: LibraryItem, now: Date): DisplayState
```
`now` is injected so the stalled and estimate branches are deterministic in jest.

## State of the Art

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|--------------|--------|
| `npx @better-auth/cli generate` | `npx auth@latest generate` | CLI renamed (`@better-auth/cli` stuck at 1.4.21) | Use `auth` |
| `import { drizzleAdapter } from "better-auth/adapters/drizzle"` | Docs now show `@better-auth/drizzle-adapter`. The old path is still exported | 1.5+ | Either works. Old path avoids a new dep |
| Redirect-based auth gating | `Stack.Protected guard={…}` | Expo Router SDK 53+ | Used here |
| `react-test-renderer` | RNTL 14 (React 19) | SDK 58 | Don't install react-test-renderer |
| `renderRouter` sync | `await renderRouter(...)` and awaited `testRouter` methods | SDK 58 | [CITED: docs.expo.dev/router/reference/testing] |

**Deprecated/outdated:** `@better-auth/cli` package (use `auth`). Expo SDK 58 no longer loads `.env.staging`-style files.

## Assumptions Log

| # | Claim | Section | Risk if Wrong |
|---|-------|---------|---------------|
| A1 | Empty-body JSON POST is a Fastify 400 without the raw parser | Anti-Patterns | Low: the raw parser is recommended anyway |
| A2 | node-pg parses `timestamp` (no tz) as local time | Pitfall 4 | Low: timestamptz is recommended regardless |
| A3 | jest-expo transformIgnorePatterns must be extended for Better Auth ESM | Pitfall 8 | Low: discovered on the first jest run |
| A4 | Railway reference-variable syntax `${{api.VAR}}` and IaC `apply --environment dev` creates service instances (not duplicate services) in an empty env | Pitfall 3/9 | Medium: run `config plan` and read it before apply |
| A5 | Railway variable `NODE_ENV=development` overrides the Dockerfile `ENV NODE_ENV=production` at runtime | Pitfall 1 | Medium: if not, `exp://` must be explicit (it is, in Pattern 1) |
| A6 | `getSetCookie()` available on Node 22/24 | Pitfall 10 | Low |
| A7 | All packages legit (slopcheck unavailable) | Audit | Low: all are named in official docs |

## Open Questions

1. **Processing estimate ("About N min left")**
   - What we know: `progress` is 0–100 within the current status and reset on transitions. No column records when the current status began. `updated_at` is a heartbeat.
   - What's unclear: there is no honest basis for a minutes figure in Phase 3 (mock only).
   - Recommendation: add a nullable `eta_seconds` to the list item, always `null` for now (filled in Phase 6 from provider data or a `status_changed_at` column). The client shows "Usually 30 min – 2 h" when null. The mapper still implements and unit-tests the minutes branch.
2. **List-item field names**
   - D-15 says `updated_at (heartbeat)`, but the existing contract emits `heartbeat_at` and `assets.thumbnail_url`. Recommendation: keep the existing names and add `failure_stage`, `failure_code`, `failure_message` (not displayed raw), and `charged`.
3. **Purge while another job for the world is running**
   - The single worker processes jobs sequentially, so it can't conflict in practice. A stale lease from a crashed worker could. Recommendation: the hard-delete tx deletes all of the world's jobs, and the pipeline handlers already treat a missing world as "complete". No extra locking.
4. **Prod redeploy with `AUTH_MODE=session` (D-13)** requires `BETTER_AUTH_SECRET`/`BETTER_AUTH_URL` on prod api **and** worker, and a prod migration (`0003`) via preDeploy. It touches production, so the planner should make it a `checkpoint:human-verify` task.

## Environment Availability

| Dependency | Required By | Available | Version | Fallback |
|------------|------------|-----------|---------|----------|
| Node | backend tests/scripts, app jest | ✓ (local 22, CI 24) | v22.21.1 | — |
| Railway CLI | dev environment | ✓ | 5.75.0. Project linked, env list = `production` only | — |
| Neon dev branch (MIGRATE_DATABASE_URL in backend/.env) | pg tests, migrate, owner:create, seed | ✓ (var name present, value not printed) | — | — |
| R2 `virtumetry-dev` | seed thumbnail, purge test | ✓ (Phase 2 used it) | — | local storage driver in tests |
| Expo Go on iPhone 17 Pro | manual AUTH-02/03 check | owner device | SDK 58 | — |
| EAS build | — | not needed | — | — |
| slopcheck | package audit | ✗ | — | [ASSUMED] tags |

**Missing dependencies with no fallback:** none.

## Validation Architecture

### Test Framework
| Property | Value |
|----------|-------|
| Framework (backend) | vitest ^2.1 (`backend/vitest.config.ts`, 30 s test timeout) |
| Framework (app) | jest 30 + jest-expo ~58.0.15 + RNTL 14 (Wave 0 install) |
| Config file | backend: exists. App: `"jest": { "preset": "jest-expo", "transformIgnorePatterns": [...] }` in `virtumetry/package.json` (Wave 0) |
| Quick run (backend unit) | `cd backend && npx vitest run test/<file>.test.ts` |
| Quick run (backend pg) | `cd backend && npm run test:pg -- test/integration/<file>.pg.test.ts` |
| Quick run (app) | `cd virtumetry && npx jest --ci <path>` |
| Full suite | `cd backend && npx tsc --noEmit && npx vitest run && npm run test:pg` · `cd virtumetry && npx expo lint && npx tsc --noEmit && npx jest --ci` |

### Phase Requirements → Test Map
| Req / SC | Behavior | Test Type | Automated Command | File Exists? |
|--------|----------|-----------|-------------------|-------------|
| AUTH-01 / SC1 | allowlisted sign-in → cookie; non-allowlisted → 401 `INVALID_EMAIL_OR_PASSWORD`; sign-up → 400 disabled; empty allowlist → nobody | integration (pg) | `npm run test:pg -- test/integration/auth-session.pg.test.ts` | ❌ Wave 0 |
| AUTH-01 | `parseAllowlist` trims/lowercases; empty = fail closed | unit | `npx vitest run test/allowlist.test.ts` | ❌ |
| AUTH-01 | `owner:create` creates then resets password (sign-in with new pw works, old fails) | integration (pg) | `npm run test:pg -- test/integration/owner-create.pg.test.ts` | ❌ |
| AUTH-01 / D-05 | `session` needs secret ≥32 + URL; prod refuses `dev` and DEV_AUTH_TOKEN; prod accepts `session` | unit | `npx vitest run test/config.test.ts` | ✅ extend |
| AUTH-02 / SC2 | auth client uses SecureStore + `virtumetry_` prefix; `getCookie()` returns the stored cookie from the mocked store | unit (jest) | `npx jest --ci src/__tests__/auth-client.test.ts` | ❌ |
| AUTH-02 | survives a real force-quit on iPhone | manual | Expo Go: log in, force-quit, reopen → Library | manual-only (needs device keychain) |
| AUTH-03 / SC2 | Settings Log out → confirm → `signOut` called, query cache cleared | RNTL | `npx jest --ci src/__tests__/settings.test.tsx` | ❌ |
| AUTH-03 | after sign-out, the old cookie is rejected by `/v1/worlds` (401) | integration (pg) | in `auth-session.pg.test.ts` | ❌ |
| AUTH-05 / SC3 | session cookie maps to one `users` row (`ba:<id>`); A cannot list/get/patch/delete B's world (404) | integration (pg) | `npm run test:pg -- test/integration/ownership.pg.test.ts` | ❌ |
| LIB-01 / SC3 | `toDisplayState` all 8 statuses + saved_on_phone, stalled >15 min, estimate fallback, failure-code families, charge note | unit (jest) | `npx jest --ci src/__tests__/display-state.test.ts` | ❌ |
| LIB-01 | Library renders each state (seeded list incl. local item), empty, error | RNTL | `npx jest --ci src/__tests__/library.test.tsx` | ❌ |
| LIB-01 | list item includes failure_*, charged, heartbeat_at, thumbnail_url | unit | `npx vitest run test/worlds.list.test.ts` | ✅ extend |
| LIB-01 | sign-in screen error copy for 401/429/network | RNTL | `npx jest --ci src/__tests__/sign-in.test.tsx` | ❌ |
| LIB-03 / SC4 | PATCH title trims, 1–80, 400 otherwise, owner-only 404, bumps updated_at | integration (pg) | in `ownership.pg.test.ts` | ❌ |
| LIB-03 / SC4 | delete → purge: DB rows gone (world, captures, jobs, slugs), credit_events kept with world_id NULL, storage prefixes empty, exactly 1 `deleteWorld` call, rerun idempotent, `framesOnly` keeps row | integration (pg, local storage) | `npm run test:pg -- test/integration/purge-cascade.pg.test.ts` (uses `startPipeline` harness) | ❌ |
| SC5 | each eas.json profile resolves; dev/preview refuse prod host; production resolves prod; `.env` is development + non-prod; http only for dev+LAN | unit (jest) | `npx jest --ci src/__tests__/api-config.test.ts` | ❌ |

### Sampling Rate
- **Per task commit:** the quick command for the touched file, plus `npx tsc --noEmit` in the touched package.
- **Per wave merge:** backend `npx vitest run` + `npm run test:pg`. App `npx jest --ci` + lint + tsc.
- **Phase gate:** full suite green, then the manual Expo Go check (log in, force-quit, library with seeded states, rename, delete, log out) against Railway dev.

### Wave 0 Gaps
- [ ] App: `npx expo install jest-expo jest @types/jest @testing-library/react-native --dev`, jest config in package.json, `"types": ["jest"]` in tsconfig, `src/__tests__/setup` mocks (`expo-secure-store` in-memory)
- [ ] `.github/workflows/app.yml`: add `- run: npx jest --ci`
- [ ] Backend: `test/integration/auth-session.pg.test.ts`, `ownership.pg.test.ts`, `purge-cascade.pg.test.ts`, `owner-create.pg.test.ts` (shared helper: build app with `createAuth` on a throwaway schema)
- [ ] Mock provider `calls.deleteWorld` for assertions

## Security Domain

### Applicable ASVS Categories
| ASVS Category | Applies | Standard Control |
|---------------|---------|-----------------|
| V2 Authentication | yes | Better Auth email/password (scrypt), sign-up disabled, allowlist ×2, rate limit on `/sign-in/email` + existing `FailureThrottle` |
| V3 Session Management | yes | Better Auth signed session cookie (`__Secure-` on https), 7 d expiry, server-side revoke on sign-out, SecureStore on device |
| V4 Access Control | yes | `findOwnedWorld` owner scoping → 404, `/v1` entirely inside authed scope |
| V5 Input Validation | yes | zod (`PATCH` title 1–80 trimmed), raw-body bridge with 64 KiB limit |
| V6 Cryptography | yes | No hand-rolled crypto: Better Auth hashing + signing. `BETTER_AUTH_SECRET` ≥32 chars, per environment |

### Known Threat Patterns
| Pattern | STRIDE | Standard Mitigation |
|---------|--------|---------------------|
| Account enumeration via sign-in | Info disclosure | Identical 401 `INVALID_EMAIL_OR_PASSWORD` for non-allowlisted. Note the allowlist rejection returns faster than a hash check, so timing reveals allowlist membership only. Optionally `await ctx.context.password.hash(body.password)` before throwing |
| Credential stuffing | Spoofing | Better Auth rate limit keyed on trusted `req.ip`, plus the `FailureThrottle` on `/v1` |
| CSRF via cookie | Tampering | Better Auth origin check (`trustedOrigins` without wildcards in prod) |
| IDOR on world ids | Elevation | Owner-scoped queries, 404 not 403 |
| Spoofed X-Forwarded-For to dodge limits | Spoofing | Bridge overwrites `x-vm-client-ip` with Fastify's hop-trusted `req.ip` |
| Dev auth on a public URL | Spoofing | `DEV_AUTH_TOKEN` unset in Railway dev, refused in prod by `refine()` |
| Secrets in repo | Info disclosure | Owner email/password only in env/Railway (`--stdin`). `.env` committed holds only `EXPO_PUBLIC_*` public URLs |
| Data retention after delete | Privacy | Hard delete + R2 purge + provider delete request. Ledger keeps only amounts |

## Sources

### Primary (HIGH confidence)
- better-auth 1.7.27 / @better-auth/expo 1.7.27 / @better-auth/core 1.7.27 / @better-auth/telemetry 1.7.27 package source (npm pack, read in session): sign-up.mjs, sign-in.mjs, sign-out.mjs, internal-adapter.mjs, origin-check.mjs, trusted-origins.mjs, rate-limiter/index.mjs, create-context.mjs, core utils/ip.mjs, init-options.d.mts, expo index.js/client.js
- `npx auth generate` (1.7.27) output for the Drizzle pg schema, run in a scratch dir
- npm registry: versions, peers, postinstall for all packages
- https://www.better-auth.com/docs/integrations/fastify, /integrations/expo, /concepts/hooks, /concepts/rate-limit, /adapters/drizzle, /concepts/database
- https://docs.expo.dev/router/advanced/authentication.md, /router/advanced/native-tabs.md, /router/reference/testing.md, /develop/unit-testing.md, /guides/environment-variables.md, /eas/environment-variables/faq.md
- `virtumetry/node_modules/expo/bundledNativeModules.json` (SDK 58 versions)
- Repo code: backend/src/{auth,config,server,worker,pipeline,queue}.ts, routes/{index,worlds,account,webhooks}.ts, db/schema.ts, provider/*, test/helpers/pg-schema.ts, scripts/*.mjs, Dockerfile, .railway/railway.ts, .github/workflows/*.yml, .gitignore files
- Railway CLI 5.75 `--help` (environment new/config plan/apply/up/variable/domain). `railway status` and `railway environment list` (read-only)

### Secondary (MEDIUM confidence)
- https://tanstack.com/query/latest/docs/framework/react/react-native and /reference/useQuery
- https://docs.railway.com/environments (duplicate vs empty, staged deploys)
- `.railway/node_modules/railway/README.md` (IaC is diffed against the linked/selected env)

### Tertiary (LOW confidence)
- Railway reference-variable syntax. Docker ENV override by Railway variables (A4, A5)

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH. Registry and source verified, versions pinned.
- Architecture: HIGH (backend, from repo + library source). MEDIUM (app gate details until the first Expo Go run).
- Pitfalls: HIGH for origin, rate limit, sign-up, FK and gitignore (all verified). MEDIUM for Railway env creation and jest ESM.

**Research date:** 2026-11-24
**Valid until:** 2026-12-08 (Better Auth releases weekly, so re-check the version before install)
