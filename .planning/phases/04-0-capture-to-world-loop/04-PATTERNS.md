# Phase 4: $0 Capture-to-World Loop - Pattern Map

**Mapped:** 2026-11-24
**Files analyzed:** 52 (new + modified + deleted)
**Analogs found:** 44 / 52 (the rest are greenfield: the fixture source, the reconciler, the mini-map, the dark scan screen)

All paths are relative to the repo root `C:/Users/Uzi/Documents/GitHub/Virtumetry`. Line numbers come from the files as they are at commit `afc3c99`.

## File Classification

### Backend

| New/Modified File | Role | Data Flow | Closest Analog | Match Quality |
|---|---|---|---|---|
| `backend/src/routes/scans.ts` (NEW) | route | request-response + CRUD | `backend/src/routes/worlds.ts` (create 173-269, frames:done 324-388, helpers 527-654) | exact |
| `backend/src/routes/worlds.ts` (MOD: remove create / uploads:refresh / frames:done, export helpers) | route | CRUD | itself | exact |
| `backend/src/routes/index.ts` (MOD: register `scansRoutes` in authed scope) | config | — | itself, lines 76-82 | exact |
| `backend/src/routes/deps.ts` (MOD: add `provider: ReconProvider`) | config | — | itself + `WorkerDeps` in `backend/src/worker.ts:104-110` | exact |
| `backend/src/server.ts` (MOD: pass `provider: createProvider(config)`) | config | — | itself, line 31 | exact |
| `backend/src/capture-config.ts` (NEW) | config/utility | transform | `backend/src/config.ts` (zod env + `refine`), `backend/src/bundle/manifest.ts` (zod schema style) | role-match |
| `backend/src/config.ts` (MOD: `CAPTURE_CONFIG_JSON: z.string().optional()`, parse in `refine`) | config | — | itself, lines 80-130, 156-252 | exact |
| `backend/src/bundle/validate.ts` (MOD: required `rules` arg, TRACKING_GAP, coverage, blur share, FORWARD_MOTION_MISMATCH, INTRINSICS_ASPECT, tightened principal point) | utility | transform (pure) | itself | exact |
| `backend/src/bundle/pack.ts` (MOD: export `readManifest`, add `validateStored`, pass rules) | service | file-I/O | itself, lines 23-59 | exact |
| `backend/src/pipeline.ts` (MOD: `handlePack` passes `captureConfig(config).precheck`) | service | batch/event-driven | itself, lines 83-92 | exact |
| `backend/src/budget.ts` (MOD: extract `spentCredits(db, mode)`) | service | CRUD (read) | itself, lines 87-100 | exact |
| `backend/src/storage/index.ts`, `s3.ts`, `local.ts` (MOD: `ttlSeconds` arg on `presignUpload`) | service | file-I/O | `s3.ts:33-57` | exact |
| `Dockerfile`, `.dockerignore` (MOD: ship `backend/test/fixtures/mock-outputs`) | config | — | `Dockerfile:22-27`, `.dockerignore` | exact |
| `backend/scripts/budget-reset-dev.ts` (NEW, optional D-24) + `package.json` script | utility | batch | `backend/scripts/seed-library.ts` + `scripts/dev-guard.mjs` | exact |
| `backend/test/capture-config.test.ts` (NEW) | test | — | `backend/test/config.test.ts` | role-match |
| `backend/test/scans.quote.test.ts` (NEW) | test | — | `backend/test/worlds.idempotency.test.ts` (Fastify + fake db) | exact |
| `backend/test/bundle/validate.test.ts` (MOD) | test | — | itself, lines 1-60 (`run(mut, opts)` helper) | exact |
| `backend/test/integration/scans.pg.test.ts` (NEW) | test | — | `backend/test/integration/ownership.pg.test.ts` | exact |
| `backend/test/integration/scans-e2e.pg.test.ts` (NEW) | test | — | `backend/test/integration/pipeline.pg.test.ts` + `test/helpers/pipeline.ts` | exact |
| `backend/test/helpers/pipeline.ts` (MOD: dev `CAPTURE_CONFIG_JSON` in `loadConfig`) | test helper | — | itself, lines 61-71 | exact |
| `backend/test/worlds.idempotency.test.ts`, `quota.charge.test.ts` (REWRITE for `/v1/scans`) | test | — | themselves | exact |
| `backend/test/upload-size.test.ts` (REPURPOSE), `zod-contract.test.ts` (EDIT) | test | — | themselves | exact |
| `backend/test/frames-done.test.ts`, `worlds.uploads-refresh.test.ts` (DELETE) | — | — | — | — |

### App (`virtumetry/`)

| New/Modified File | Role | Data Flow | Closest Analog | Match Quality |
|---|---|---|---|---|
| `src/capture/types.ts` (NEW) | model | — | `backend/src/bundle/manifest.ts` (hand-copy `Session`/`FrameLine`), `src/library/display-state.ts` (type style) | exact (copy) |
| `src/capture/rules.ts` (NEW, mirrored constants) | config | — | `backend/src/bundle/validate.ts:9-18` (named, documented constants) | exact (copy) |
| `src/capture/config.ts` (NEW: `CaptureConfig`, defaults, `useCaptureConfig()`) | hook | request-response | `src/lib/api.ts:49-56` (`useWorlds`) | role-match |
| `src/capture/readiness.ts`, `cost.ts`, `coverage.ts`, `precheck.ts` (NEW) | utility | transform (pure) | `src/library/display-state.ts` (pure, copy-in-code, jest-tested) + `backend/src/bundle/validate.ts` (issue list) | role-match |
| `src/capture/source.ts` (NEW: `getCaptureSource`) | provider | — | none (RESEARCH §Code Examples "Native-or-fixture source") | no analog |
| `src/capture/fixture-source.ts` (NEW) | service | event-driven + file-I/O | listener set from `src/library/local-scans.ts:7-17`; rest greenfield | partial |
| `src/capture/fixture-assets.ts` + `assets/fixtures/tiny-session/{000001..030.jpg, frames.json, README.md}` (NEW) | config/asset | — | `backend/test/fixtures/tiny-session/` (source bytes + licence) | exact (copy) |
| `src/capture/store.ts` (NEW, replaces `src/library/local-scans.ts`) | store | file-I/O + pub-sub | `src/library/local-scans.ts` (whole file) | exact |
| `src/upload/reconcile.ts` (NEW) | service | request-response (pure, injected) | none (RESEARCH Pattern 2) | no analog |
| `src/upload/uploader.ts` (NEW) | utility | file-I/O | none (RESEARCH §Code Examples "Uploader adapter") | no analog |
| `src/upload/manager.ts` (NEW) | service | event-driven | `src/app/_layout.tsx:12-15` (module-level `AppState` listener) | partial |
| `src/lib/api.ts` (MOD: scans/quote/config calls) | service | request-response | itself (`apiFetch`, `renameWorld`, `useRenameWorld`) | exact |
| `src/library/display-state.ts` (MOD: richer `LocalScan`, validate-stage mapping, local upload states) | utility | transform | itself, lines 20-21, 57-69, 97-109 | exact |
| `src/app/_layout.tsx` (MOD: `capture` screen, start manager when signed in) | route/layout | — | itself | exact |
| `src/app/capture/_layout.tsx` (NEW) | route/layout | — | `src/app/_layout.tsx:31-38` (Stack, `headerShown:false`) | exact |
| `src/app/capture/prep.tsx` (NEW) | component (screen) | request-response | `src/app/sign-in.tsx` (SafeArea + ScrollView + accent button) + `src/app/(tabs)/settings.tsx` (card) | role-match |
| `src/app/capture/scan.tsx` (NEW) | component (screen) | event-driven | `src/app/sign-in.tsx` (button/busy), `src/components/library-row.tsx` (SymbolView+tone) | partial |
| `src/app/capture/[id].tsx` (NEW: review / quote / upload steps) | component (screen) | request-response | `src/app/(tabs)/settings.tsx` (cards, hairline), `src/app/sign-in.tsx` (primary button), `library-row.tsx:60-73` (progress bar), `(tabs)/index.tsx:84-104` (error + Try again) | role-match |
| `src/app/(tabs)/index.tsx` (MOD: "New scan" pill + empty-state button, store, Discard copy) | component (screen) | CRUD | itself | exact |
| `src/components/library-row.tsx` (MOD: pressable local rows) | component | — | itself | exact |
| `src/components/readiness-pill.tsx` (NEW) | component | — | `src/components/library-row.tsx:13, 48-59` (tone map + SymbolView) | role-match |
| `src/components/coverage-map.tsx` (NEW, react-native-svg) | component | transform | none | no analog |
| `src/__tests__/capture-{readiness,cost,coverage,precheck}.test.ts` (NEW) | test | — | `src/__tests__/display-state.test.ts` | exact |
| `src/__tests__/capture-store.test.ts`, `capture-fixture-source.test.ts`, `upload-reconcile.test.ts` (NEW) | test | — | `src/__tests__/display-state.test.ts` (pure) + jest-expo FS mock | role-match |
| `src/__tests__/capture-{prep,review,quote}.test.tsx` (NEW) | test | — | `src/__tests__/library.test.tsx` | exact |
| `src/__tests__/library.test.tsx` (MOD: `__setLocalScansForTest` → store test seam) | test | — | itself | exact |
| `virtumetry/package.json` (MOD via `npx expo install expo-file-system expo-asset expo-camera react-native-svg expo-keep-awake`) | config | — | — | — |

---

## Pattern Assignments — Backend

### `backend/src/routes/scans.ts` (route, request-response + CRUD)

**Analog:** `backend/src/routes/worlds.ts`

**Imports** (worlds.ts lines 1-9) — copy, add provider + bundle imports:
```ts
import { and, desc, eq, isNull } from 'drizzle-orm';
import { z } from 'zod';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { getDb } from '../db/client.js';
import { captures, worlds, type World } from '../db/schema.js';
import { enqueue } from '../queue.js';
import { chargeScanQuota, releaseScanQuota, type QuotaChargeResult } from '../quota.js';
import { MAX_FRAME_BYTES, type StorageDriver } from '../storage/index.js';
import type { RouteDeps } from './deps.js';
```

**Auth guard** (worlds.ts 104-110) — every handler starts with this:
```ts
function requireUserId(req: FastifyRequest, reply: FastifyReply): string | null {
  if (!req.userId) {
    reply.code(401).send({ error: 'unauthenticated' });
    return null;
  }
  return req.userId;
}
```
Ownership on every `:id` route (worlds.ts 638-654): `findOwnedWorld(db, id, userId)` → `404 { error: 'world_not_found' }`. Already swallows SQLSTATE 22P02 for non-uuid ids. **Export it** (plus `isUniqueViolation`, `findWorldByClientRequestId`, `serializeWorld`, `sendScanQuotaExceeded`) from `worlds.ts`, or move them into `scans.ts` and import back into `worlds.ts`. Don't duplicate them.

**Rate-limited create + Idempotency-Key + quota** (worlds.ts 173-247) — copy verbatim into `POST /v1/scans`, then swap the body schema and the response:
```ts
app.post('/v1/worlds', {
  config: {
    rateLimit: {
      max: config.RATE_LIMIT_CREATE_MAX,
      timeWindow: config.RATE_LIMIT_WINDOW_MS,
      keyGenerator: (req: FastifyRequest) => `create:${req.userId ?? req.ip}`,
    },
  },
}, async (req, reply) => {
  const userId = requireUserId(req, reply);
  if (!userId) return;
  const parsed = createBody.safeParse(req.body);
  if (!parsed.success) {
    return reply.code(400).send({ error: 'invalid_body', issues: parsed.error.issues });
  }
  ...
  const keyHeader = req.headers['idempotency-key'];
  const rawKey = Array.isArray(keyHeader) ? keyHeader[0] : keyHeader;
  ...
  const key = z.guid().safeParse(rawKey.trim());   // z.guid(), NOT z.uuid() (comment lines 200-201)
  ...
  const existing = await findWorldByClientRequestId(db, userId, clientRequestId);
  if (existing) return replayCreate(...);
  const charge = await chargeScanQuota(db, userId, config.DAILY_SCAN_QUOTA);
  if (!charge.userFound) return reply.code(401).send({ error: 'unknown_user' });
  if (!charge.allowed) return sendScanQuotaExceeded(reply, charge);
  try {
    const [row] = await db.insert(worlds).values({ ownerId: userId, ..., status: 'uploading', clientRequestId }).returning();
  } catch (err) {
    if (!clientRequestId || !isUniqueViolation(err)) throw err;
    await releaseScanQuota(db, userId);
    const winner = await findWorldByClientRequestId(db, userId, clientRequestId);
    if (!winner) throw err;
    return replayCreate(...);
  }
```
Differences for scans: make the Idempotency-Key **required** (the local sessionId). Add `approvedMaxCredits: body.approved_max_credits` to the `worlds` insert. Validate `approved_max_credits >= (await provider.quote(frame_count)).credits`, else `400 approval_below_quote`. The capture row gets `frameCount`, `imageW`, `imageH` and `r2FramesPrefix: \`captures/${id}\`` (lines 249-258; use `captureKey(cid, '')` from `storage/index.ts:52`). The response has **no** presigned URLs (presign is its own route). Keep the soft-deleted 409 from `replayCreate` (lines 599-604).

**Presign batch** (`POST /v1/scans/:id/uploads`): copy `presignFrameUploads` (lines 504-525) shape, but driven by a validated path list:
```ts
const key = `${prefix}/${kind.name(i)}`;
const presigned = await storage.presignUpload(key, kind.contentType, kind.maxBytes, sizes.get(i));
return { index: i, key, ...presigned };
```
Body `{ files: [{ path, bytes }] }` with at most 200 entries. Allow only paths matching `^frames/\d{6}\.jpg$` (index ≤ `capture.frameCount`) or exactly `frames.jsonl` / `session.json`. Build keys server-side with `captureKey(cid, rel)`. Size ceilings: `MAX_FRAME_BYTES` for jpg, `MANIFEST_MAX_BYTES` (export from `pack.ts:21`) for JSON. Pass `ttlSeconds = 21600`.

**Missing** (`GET /v1/scans/:id/uploads::missing`): `storage.list(captureKey(cid, ''))`, then strip the prefix exactly as `pack.ts:54-55` does:
```ts
const prefix = captureKey(captureId, '');
const all = (await storage.list(prefix)).map((o) => ({ key: o.key.slice(prefix.length), size: o.size }));
```
Response: `{ status, missingFrames: string[], manifestPresent: boolean }`. Include `status` because the reconciler stops when status ≠ `uploading`.

**Complete — conditional flip + enqueue in one transaction** (worlds.ts 345-386). Copy it and drop the poses write:
```ts
const flipped = await db.transaction(async (tx) => {
  const [row] = await tx
    .update(worlds)
    .set({ status: 'packing', progress: null, updatedAt: new Date() })
    .where(and(eq(worlds.id, world.id), eq(worlds.status, 'uploading'), isNull(worlds.deletedAt)))
    .returning();
  if (!row) return null;
  ...
  const jobId = await enqueue(tx, 'pack', world.id, { captureId: capture?.id ?? null });
  return { row, jobId };
});
if (!flipped) {
  // Replay: 200, not 409 — a 409 would make client recovery retry forever.
  const current = await findOwnedWorld(db, world.id, userId);
  return reply.send({ world: serializeWorld(current ?? world), job_id: null });
}
```
Before the flip, run `validateStored(...)` (see pack.ts below). If it returns issues, call `failWorld(db, id, ['uploading'], 'validate', codes[0], codes.join(', '))` (pipeline.ts 23-44) and answer 200 `{ world, issues }`. If frames or the manifest are missing, answer `409 upload_incomplete` and **leave the world as it is**.

**Route path (blocking, RESEARCH Pitfall 1):** `'/v1/scans/:id([0-9a-fA-F-]{36})::complete'` and `'/v1/scans/:id/uploads::missing'`.

**Read routes** (`GET /v1/quote`, `GET /v1/capture/config`) — analog `backend/src/routes/me.ts` lines 13-33 (small authed GET):
```ts
app.get('/v1/me/quota', async (req, reply) => {
  if (!req.userId) return reply.code(401).send({ error: 'unauthenticated' });
  ...
  return reply.send({ scans_remaining: ..., quota_resets_at: ..., daily_quota: ... });
});
```
Query parsing: copy `listQuery` + `safeParse` → `400 invalid_query` (worlds.ts 96-99, 413-418), e.g. `z.object({ frames: z.coerce.number().int().min(1).max(limits.maxFrames) })`. Use snake_case JSON keys like the existing routes (`budget_remaining`, `within_budget`) unless the planner locks camelCase. Pick one and use it in both the app and the backend.

---

### `backend/src/routes/index.ts` / `deps.ts` / `server.ts` (config)

Register inside the authed scope (index.ts 76-82):
```ts
await app.register(async (authed) => {
  authed.addHook('onRequest', makeAuthPreHandler(config, authFailures, deps.auth));
  worldsRoutes(authed, deps);
  // + scansRoutes(authed, deps);
  devicesRoutes(authed);
  accountRoutes(authed, deps.auth);
  meRoutes(authed, deps);
});
```
deps.ts: add `provider: ReconProvider` (import from `../provider/index.js`), mirroring `WorkerDeps.provider` (worker.ts:109). server.ts line 31 becomes `registerRoutes(app, { config, storage, auth, provider: createProvider(config) })`. `test/helpers/auth-app.ts` goes through `buildServer`, so it picks this up automatically.

---

### `backend/src/capture-config.ts` (config, transform) + `config.ts` (MOD)

**Analog:** `backend/src/config.ts`. Env fields are declared in `baseSchema` (lines 36-130). Cross-field checks live in `refine()` (156-252), which throws `Error` messages that **name the var, never the value**:
```ts
if (cfg.AUTH_MODE === 'apple' && !cfg.APPLE_BUNDLE_ID) {
  throw new Error('AUTH_MODE=apple requires APPLE_BUNDLE_ID');
}
```
Add `CAPTURE_CONFIG_JSON: z.string().optional(),` next to the budget vars (lines 90-95). In `refine()`, call `captureConfig(cfg)` inside try/catch → `throw new Error('CAPTURE_CONFIG_JSON is invalid')`, so a bad value fails at boot. Schema style: copy `manifest.ts` (`z.object`, `.strict()`, `z.infer` types). The merge code is in RESEARCH §"Capture config env (backend)". Pricing `{ baseCredits: 900, perFrameCredits: 1, usdPerCredit: 0.01 }` is a code constant, not env.

---

### `backend/src/bundle/validate.ts` (utility, pure transform) — MOD

**Analog:** itself. Keep these conventions:
- File header comment "Pure, never throws: returns named issues" (lines 1-2).
- Each threshold is an exported, doc-commented constant (lines 9-18):
```ts
/** D-06 semantic check: adjacent camera centres further apart than this (metres) mean a tracking jump. */
export const MAX_CENTRE_JUMP_M = 0.5;
```
- Issues are pushed through the local `add(code, message)` closure (line 36). Messages are built from numbers, never from manifest strings.
- Change the signature to require `rules` (Pitfall 4, so TypeScript flags every caller):
```ts
opts: { minFrames: number; maxFrames: number }   // line 33 → add `rules: PrecheckRules`
```
- Replace the per-frame line 64 `TRACKING_NOT_NORMAL` with one share-based `TRACKING_GAP` added after the loop.
- Keep the code `INTRINSICS_PRINCIPAL_POINT` (line 60) but tighten it to the ±25 % band. Add `INTRINSICS_ASPECT`.
- Add `FORWARD_MOTION_MISMATCH` using `forwardMotionMedianDeg` (RESEARCH §Code Examples). Reuse `cameraCentre` from `convert.ts:27-30`.
- Coverage-sector yaw = `atan2(-T[8], -T[10])` (skip when horizontal forward < 0.3). Use the same formula in the app's `coverage.ts`.

---

### `backend/src/bundle/pack.ts` (service, file-I/O) — MOD

**Analog:** itself. Export `readManifest` (lines 23-47) and lift lines 54-59 into an exported `validateStored(storage, captureId, opts)` that both `packCapture` and `:complete` call:
```ts
const prefix = captureKey(captureId, '');
const all = (await storage.list(prefix)).map((o) => ({ key: o.key.slice(prefix.length), size: o.size }));
const { session, frames } = await readManifest(storage, captureId, new Map(all.map((o) => [o.key, o.size])));
const objects = all.filter((o) => o.key.startsWith('frames/'));
const issues = validateSession(session, frames, objects, opts);
if (issues.length) throw new BundleInvalidError(issues);
```
`:complete` must catch `BundleInvalidError` (line 12) and turn `.issues` into codes, the same way `pipeline.ts:88-91` does.

### `backend/src/pipeline.ts` — MOD (handlePack lines 83-92)
```ts
const limits = await provider.limits();
res = await packCapture(storage, cap.id, { ...limits, onProgress: heartbeat(deps, job) });
// → add rules: captureConfig(deps.config).precheck ; minFrames = max(precheck.minFrames, limits.minFrames)
```
`deps.config` already exists on `WorkerDeps` (worker.ts:107).

### `backend/src/budget.ts` — MOD
Extract the SELECT at lines 87-100 into `export async function spentCredits(db: Pick<Db,'execute'>, mode): Promise<{ day: number; month: number }>`. Keep the double `AT TIME ZONE 'UTC'` and its comment (lines 77-86). `reserveCredits` then calls it inside its transaction. `/v1/quote` computes `budgetRemaining = min(daily - day, monthly - month)` and `withinBudget = !wouldExceedBudget(...)` (line 37) for both windows, and returns which window binds (the UI needs "left today" or "left this month"). Mode comes from `provider.mode`.

### `backend/src/storage/{index,s3,local}.ts` — MOD
Interface (index.ts 29-34): add `ttlSeconds?: number` after `exactBytes`. s3.ts line 49 `expiresIn: 900` → `expiresIn: ttlSeconds ?? 900`. Mirror the param in `local.ts` (the local driver can ignore it). `list(prefix)` already exists on both drivers (index.ts 48-49, s3.ts 119-130), so **do not add `listKeys`**.

### `Dockerfile` / `.dockerignore` — MOD
`.dockerignore` excludes `backend/test` (line under "Rebuilt inside the image"). Add `!backend/test/fixtures/mock-outputs` after it. In `Dockerfile`, after line 27 (`COPY --chown=node:node backend/drizzle ./drizzle`), add `COPY --chown=node:node backend/test/fixtures/mock-outputs ./test/fixtures/mock-outputs`. Watch out: `*.md` is also ignored, which only drops the README. That's fine.

### `backend/scripts/budget-reset-dev.ts` (optional)
**Analog:** `backend/scripts/seed-library.ts` lines 1-20. Header comment states what it touches and that it never prints secrets. Imports `assertDevDb`/`assertDevBucket` from `./dev-guard.mjs` (dev-guard.mjs 8-32). Package script uses the same shape as `"seed:library": "node --env-file=.env --import tsx scripts/seed-library.ts"`. Delete only `credit_events WHERE provider_mode='mock' AND created_at >= today UTC`.

---

## Pattern Assignments — Backend tests

### `backend/test/scans.quote.test.ts` / rewritten `worlds.idempotency.test.ts` → scans
**Analog:** `backend/test/worlds.idempotency.test.ts` lines 1-70: mock `getDb` before importing routes, use `loadConfig` with minimal env, and a fake-db chain.
```ts
let currentDb: unknown;
vi.mock('../src/db/client.js', () => ({ getDb: () => currentDb }));
import { worldsRoutes, isUniqueViolation } from '../src/routes/worlds.js';
const config = loadConfig({ DATABASE_URL: 'postgres://u:p@localhost:5432/db', DEV_AUTH_TOKEN: 't' } as NodeJS.ProcessEnv);
```
For `RouteDeps.provider`, pass `createMockProvider({})` from `src/provider/mock.js`.

### `backend/test/integration/scans.pg.test.ts`
**Analog:** `backend/test/integration/ownership.pg.test.ts` lines 1-60: `describe.skipIf(!url)`, `createTestSchema`, `buildSessionApp`/`seedOwner`/`signIn`, the `call()` inject wrapper with cookie, and the two-owner 404 check. Add `'POST'` to the `call` method union. Tests touch only rows they create (Phase 3 D-14).

### `backend/test/integration/scans-e2e.pg.test.ts`
**Analog:** `backend/test/helpers/pipeline.ts` (`startPipeline`, `readFixture` at lines 24-33 already returns `session.json`, `frames.jsonl`, `frames/*`) + `pipeline.pg.test.ts`. Pass the fixture-friendly `CAPTURE_CONFIG_JSON` in the `loadConfig` block (helpers/pipeline.ts 61-71). Assert zero `credit_events` rows for the broken fixtures.

### `backend/test/bundle/validate.test.ts` — extend
Reuse the `run(mut, opts)` mutation helper (lines 19-23) and the "one failing rule per code" `describe` (line 37+). `OPTS` (line 15) gains `rules`. Broken fixtures are built in-test: reversed poses → `FORWARD_MOTION_MISMATCH`, +0.6 m x from frame 15 → exactly `['CAMERA_JUMP']`.

---

## Pattern Assignments — App

### `src/capture/store.ts` (store, file-I/O + pub-sub) — replaces `src/library/local-scans.ts`

**Analog:** `src/library/local-scans.ts` (entire file, 26 lines). Keep the external-store shape and the test seam:
```ts
let scans: LocalScan[] = [];
const listeners = new Set<() => void>();
function set(next: LocalScan[]) {
  scans = next;
  listeners.forEach((l) => l());
}
const subscribe = (l: () => void) => { listeners.add(l); return () => listeners.delete(l); };
export function useLocalScans() {
  return { scans: useSyncExternalStore(subscribe, () => scans), remove: (id: string) => set(scans.filter((s) => s.id !== id)) };
}
export const __setLocalScansForTest = set;
```
Add persistence: `set()` also writes `new File(Paths.document, 'sessions', 'index.json')`, and a `load()` reads it at startup. `remove()` deletes `new Directory(Paths.document, 'sessions', sessionId)`. Callers to update: `src/app/(tabs)/index.tsx:12,18` and `src/__tests__/library.test.tsx:7,59,75`. Either keep the hook name `useLocalScans` and the seam name `__setLocalScansForTest`, or update both call sites. Extend `LocalScan` in `display-state.ts:21` (it is the shared type).

### `src/capture/readiness.ts`, `cost.ts`, `coverage.ts`, `precheck.ts` (pure utilities)

**Analog:** `src/library/display-state.ts`. Pure functions take `now`/inputs explicitly, user copy lives in module constants, and nothing imports React:
```ts
const UPLOAD = "Upload didn't finish";
const REJECTED = "The scan couldn't be turned into a room";
...
export function toDisplayState(item: ..., now: Date): DisplayState { ... }
```
Readiness/precheck reason copy comes verbatim from 04-UI-SPEC §Readiness and §Check reasons. `precheck.ts` returns `{ code, ... }[]` like the backend `BundleIssue` (validate.ts 20, 36) so codes line up with the server. `rules.ts` constants copy validate.ts's doc-comment-per-constant style, and a pinning test in each repo half holds the numbers equal.

### `src/capture/config.ts` (hook, request-response)

**Analog:** `src/lib/api.ts` lines 47-56:
```ts
export const listWorlds = () => apiFetch<WorldsPage>('/v1/worlds?limit=100');
export function useWorlds() {
  return useQuery({ queryKey: ['worlds'], queryFn: listWorlds, refetchInterval: ... });
}
```
`useCaptureConfig()` = `useQuery({ queryKey: ['capture-config'], queryFn: () => apiFetch('/v1/capture/config') })`, and the caller uses `data ?? DEFAULT_CAPTURE_CONFIG` (offline fallback, no UI for the fetch state).

### `src/lib/api.ts` (MOD)

Add plain functions next to `renameWorld`/`deleteWorld` (lines 58, 75), all through `apiFetch` (lines 22-42; it adds the cookie, uses `credentials:'omit'`, sets the JSON content type only with a body, and turns 401 into a sign-out):
```ts
export const renameWorld = (id: string, title: string) =>
  apiFetch<LibraryItem>(`/v1/worlds/${id}`, { method: 'PATCH', body: JSON.stringify({ title }) });
```
New: `createScan(scan, approvedMax)` (sets the `Idempotency-Key` header through `init.headers`, which `apiFetch` merges at line 29), `presignUploads`, `getMissing`, `completeScan`, `getQuote(frames)`, `getCaptureConfig`. Watch out: `apiFetch` throws `ApiError(status)` on non-2xx (line 39). The reconciler needs the 409 `upload_incomplete` body, so either catch `ApiError` with `status === 409` or have `completeScan` read the body itself. These functions form the `ScansApi` injected into `reconcile.ts`.

### `src/library/display-state.ts` (MOD)

Extend `LocalScan` (line 21) with `{ sessionId, dir, frameCount, durationS, readiness, precheck, serverWorldId?, uploadState }`. Local branch (lines 100-109) gains the UI-SPEC "Library row status lines" variants. In `failureText` (lines 61-69), put `stage === 'validate'` → `"Didn't pass checks"` **first**, ahead of the code families (UI-SPEC: "maps ahead of the Phase 3 code families"). Note the existing `UPLOAD_CODE` regex catches `IMAGE_`, which would otherwise swallow `IMAGE_LONG_EDGE`. Add a client `failure_code → reason` table for the upload step. Never render `failure_message` (comment line 13).

### `src/upload/manager.ts` (service, event-driven)

**Analog:** `src/app/_layout.tsx` lines 12-15 (module-level AppState hook, skipped on web):
```ts
if (Platform.OS !== 'web') {
  AppState.addEventListener('change', (state) => focusManager.setFocused(state === 'active'));
}
```
The manager exposes `start()`/`stop()` (idempotent singleton) and a `runOnce()` guarded by an in-flight flag, triggered on launch and on `'active'`. Root layout calls it in a `useEffect` keyed on `!!data` (session present, `_layout.tsx:19`). Progress fans out with the same listener-set pattern as `store.ts`.

### `src/upload/reconcile.ts` / `uploader.ts`
No analog. Use RESEARCH Pattern 2 and §"Uploader adapter" verbatim. Keep `reconcile.ts` free of expo imports (it takes injected `api` + `uploader`). Rules: only 2xx counts, never mark anything uploaded locally, send `frames.jsonl` then `session.json` last, call `:complete` once. Hand the whole presign batch to the native session (don't cap at 4 in JS; RESEARCH Anti-Patterns).

### `src/app/capture/_layout.tsx` (layout)

**Analog:** `src/app/_layout.tsx` lines 31-38:
```tsx
<Stack screenOptions={{ headerShown: false }}>
  <Stack.Protected guard={!!data}>
    <Stack.Screen name="(tabs)" />
  </Stack.Protected>
```
Capture layout: `<Stack screenOptions={{ headerShown: false }} />`. In the root layout, add `<Stack.Screen name="capture" options={{ presentation: 'fullScreenModal' }} />` **inside** the `guard={!!data}` block.

### `src/app/capture/prep.tsx` (screen)

**Analog:** `src/app/sign-in.tsx`.
- Imports block (lines 1-21): RN primitives, `SafeAreaView` from `react-native-safe-area-context`, `ThemedText`/`ThemedView`, `MaxContentWidth, Spacing`, `useTheme`.
- Screen shell (lines 81-90): `ThemedView flex → SafeAreaView → ScrollView contentContainerStyle={styles.content}` + `ThemedText type="title" accessibilityRole="header"`.
- Primary accent button with busy spinner (lines 155-173), reused for "Continue" / "Open Settings":
```tsx
<Pressable
  accessibilityRole="button"
  accessibilityLabel="Log in"
  accessibilityState={{ disabled: !canSubmit, busy: submitting }}
  disabled={!canSubmit}
  onPress={submit}
  style={({ pressed }) => [styles.button, { backgroundColor: theme.accent }, !canSubmit && !submitting && styles.disabled, pressed && styles.pressed]}>
  <View style={styles.buttonRow}>
    {submitting && <ActivityIndicator color={theme.onAccent} />}
    <ThemedText type="smallBold" themeColor="onAccent" maxFontSizeMultiplier={1.6}>...</ThemedText>
  </View>
</Pressable>
```
  with styles `button: { height: 52, borderRadius: 12, ... }`, `disabled: { opacity: 0.4 }`, `pressed: { opacity: 0.8 }` (lines 203-212).
- Live-region error + iOS announce (lines 50-52, 145-153) for the denied state.
- Priming card: `ThemedView type="backgroundElement" style={{ borderRadius: 12 }}` (settings.tsx 33, 73).
- Flags persisted with `expo-secure-store` (`setItemAsync`/`getItemAsync`; already mocked in `jest.setup.ts:7-18`; same lib as `src/lib/session.ts:1,18`).

### `src/app/capture/scan.tsx` (screen, event-driven)

Partial analogs only. Use the sign-in button pattern for Start (accent) and the busy states. Readiness pill and tone colors follow `library-row.tsx` (below). Always dark: read `Colors.dark` from `@/constants/theme` directly instead of `useTheme()`. Cancel confirmation copies the `Alert.alert` cancel/destructive shape from `(tabs)/index.tsx:35-48`:
```ts
Alert.alert(title, message, [
  { text: 'Cancel', style: 'cancel' },
  { text: 'Delete', style: 'destructive', onPress: () => ... },
]);
```
`useKeepAwake()` from `expo-keep-awake`. Subscribe to source events in `useEffect` and call `.remove()` on cleanup.

### `src/app/capture/[id].tsx` (screen, three steps)

- Stats / checks / quote cards: `settings.tsx` lines 33-53 (card + `row` + hairline `{ height: StyleSheet.hairlineWidth, backgroundColor: theme.backgroundSelected }`).
- Upload progress bar: `library-row.tsx` lines 60-73 (the `accessibilityRole="progressbar"` track/fill, styles 104-105).
- Quote error + "Try again": `(tabs)/index.tsx` lines 84-104 (styles `retry` 157-163).
- "Discard" destructive text button: `settings.tsx` lines 41-52 (`themeColor="destructive"`, `minHeight 52`).
- Neutral "Back to Library" button: `text` on `backgroundSelected`, as in the index.tsx retry button.
- Approve button = sign-in primary button. On press, call `createScan` (react-query `useMutation` like `useRenameWorld`, api.ts 62-73), update the store, then kick the manager.

### `src/app/(tabs)/index.tsx` (MOD)

Header (lines 64-75): wrap the title in a row and add the "New scan" pill (`router.push('/capture/prep')` via `useRouter` from `expo-router`). Empty state (lines 106-118): add the button and the new body copy from the UI-SPEC. `openRowMenu` (24-31): local rows offer "Discard" with the UI-SPEC confirmation copy instead of the current "Delete" text. Items merge (58-61) stays, but hide a local row once the server list has its `serverWorldId` past `uploading`.

### `src/components/library-row.tsx` (MOD) + `readiness-pill.tsx` (NEW)

Tone map + icon pattern to reuse (lines 13-14, 48-59):
```tsx
const TONE = { muted: 'textSecondary', accent: 'accent', destructive: 'destructive' } as const;
...
{state.icon && <SymbolView name={state.icon} size={14} tintColor={theme[TONE[state.tone]]} />}
<ThemedText type="small" themeColor={TONE[state.tone]} maxFontSizeMultiplier={1.6} style={styles.tabular}>
```
For the pill, map `green|amber|red` → `accent|warning|destructive` + `checkmark.circle.fill|exclamationmark.circle.fill|xmark.circle.fill`. Row MOD: wrap `styles.main` (line 30) in a `Pressable` only when `'local' in item`, with pressed `backgroundSelected` (the same idiom as the `more` button, line 90) and the `accessibilityHint` from the UI-SPEC.

---

## Pattern Assignments — App tests

### Pure-module tests (`capture-{readiness,cost,coverage,precheck}.test.ts`, `upload-reconcile.test.ts`)
**Analog:** `src/__tests__/display-state.test.ts` lines 1-30: named imports from `@/...`, fixed `NOW`, small `item(over)` factory. Reconciler: fake `api`/`uploader` objects with `jest.fn()`. No module mocks.

### Screen tests (`capture-{prep,review,quote}.test.tsx`)
**Analog:** `src/__tests__/library.test.tsx`.
- Module mocks (lines 10-14):
```ts
jest.mock('@/config/api', () => ({ API_URL: 'https://api.test.invalid', APP_ENV: 'test' }));
jest.mock('@/lib/auth-client', () => ({ authClient: { getCookie: jest.fn(async () => 'better-auth.session_token=abc') } }));
jest.mock('@/lib/session', () => ({ endSession: jest.fn(async () => {}) }));
```
- `fetch` mock + `ok()` helper (lines 50-58), `QueryClientProvider` render helper with `retry:false` (63-71), `await fireEvent.press(screen.getByRole('button', { name: ... }))` (127), and `jest.spyOn(Alert, 'alert')` (166).
- Add `jest.mock('expo-camera', () => ({ useCameraPermissions: ... }))` and an `expo-router` mock for `useLocalSearchParams`/`useRouter` as needed.

### FS-backed tests (`capture-store.test.ts`, `capture-fixture-source.test.ts`)
Use jest-expo's built-in in-memory `expo-file-system` mock (RESEARCH "Don't Hand-Roll"), with no custom FS mock. Inject `resolveFrame` + clock into `FixtureCaptureSource` (Pitfall 7). Add a test that `assets/fixtures/tiny-session/frames.json` deep-equals `../backend/test/fixtures/tiny-session/frames.jsonl` (Pitfall 8).

---

## Shared Patterns

### Authentication / ownership (backend)
**Source:** `backend/src/routes/index.ts:76-82` (authed scope + `makeAuthPreHandler`), `worlds.ts:104-110` (`requireUserId`), `worlds.ts:638-654` (`findOwnedWorld`, 404 on foreign or non-uuid)
**Apply to:** every route in `scans.ts`, including `/v1/quote` and `/v1/capture/config`.

### Input validation (backend)
**Source:** `worlds.ts:185-188`, `413-418`
```ts
const parsed = createBody.safeParse(req.body);
if (!parsed.success) return reply.code(400).send({ error: 'invalid_body', issues: parsed.error.issues });
```
**Apply to:** all scans bodies and queries. Use `z.guid()` for UUID headers. Never `parse()` (a ZodError would become a 500).

### Replay-safe state transitions (backend)
**Source:** `worlds.ts:345-386` (conditional UPDATE … WHERE status = from, enqueue in the same tx, replay → 200 with current state), `pipeline.ts:23-44` (`failWorld` scrubs URLs, caps the message at 500 chars)
**Apply to:** `:complete` success and failure paths.

### Money / budget (backend)
**Source:** `budget.ts:57-120` (advisory lock, UTC windows, mode partition), `pipeline.ts:136-146` (`NOT_APPROVED` / `QUOTE_ABOVE_APPROVAL`, already enforced at submit)
**Apply to:** `/v1/quote` (read-only via `spentCredits`), `POST /v1/scans` (`approvedMaxCredits` persisted at insert). No reservation before validation passes.

### Error copy + no raw server text (app)
**Source:** `src/app/sign-in.tsx:23-36` (COPY table + status→copy fn), `display-state.ts:51-69` (code→copy), comment at line 13
**Apply to:** quote errors, approve-failed, upload-step blocked reasons, library rows.

### Authenticated fetch (app)
**Source:** `src/lib/api.ts:22-42` (`apiFetch`)
**Apply to:** every new app→backend call, including those inside the upload manager. Never call `fetch` directly except the R2 PUT fallback in `uploader.ts`, because presigned URLs must NOT carry the cookie.

### Theming / layout tokens (app)
**Source:** `src/constants/theme.ts` (`Colors`, `Spacing.one..six`, `MaxContentWidth`), `src/hooks/use-theme.ts`, `ThemedText` types (`title|subtitle|default|smallBold|small`), `ThemedView type="backgroundElement"`
**Apply to:** all new screens and components. The scan screen is the only one that uses `Colors.dark` directly.

### Destructive confirmations (app)
**Source:** `src/app/(tabs)/index.tsx:33-48`, `settings.tsx:17-21` (`Alert.alert` with `cancel` + `destructive` styles)
**Apply to:** scan cancel, Discard (review + row menu), Discard-failed alert.

### Persisted flags (app)
**Source:** `expo-secure-store` (already a dependency; mocked in `virtumetry/jest.setup.ts:7-18`; used in `src/lib/session.ts`)
**Apply to:** prep "seen" and "Don't show again" flags. Don't add AsyncStorage.

## No Analog Found

| File | Role | Data Flow | Reason / use instead |
|---|---|---|---|
| `virtumetry/src/capture/source.ts` | provider | — | First native-optional module. RESEARCH §"Native-or-fixture source" (`requireOptionalNativeModule` from `expo`) |
| `virtumetry/src/capture/fixture-source.ts` | service | event-driven + file-I/O | No timer/event emitter or FS writer exists yet. RESEARCH §"Copy fixture frames into the session dir" + Pitfalls 7 and 9. Reuse only the listener-set idiom from `local-scans.ts` |
| `virtumetry/src/upload/reconcile.ts` | service | request-response | RESEARCH Pattern 2 |
| `virtumetry/src/upload/uploader.ts` | utility | file-I/O | RESEARCH §"Uploader adapter" (`File.upload`, non-2xx resolves) |
| `virtumetry/src/components/coverage-map.tsx` | component | transform | No SVG usage in the app yet. UI-SPEC §4 mini-map geometry. Math stays in `coverage.ts` |
| `virtumetry/src/app/capture/scan.tsx` (dark HUD parts) | screen | event-driven | No camera/HUD screen exists. UI-SPEC §4 layout |
| `virtumetry/src/capture/fixture-assets.ts` | config | — | 30 static `require()` calls, no existing asset table. Metro needs literal paths |
| `backend/src/capture-config.ts` (merge logic) | config | transform | Partial-over-defaults merge has no precedent. RESEARCH §"Capture config env" |

## Metadata

**Analog search scope:** `backend/src/**`, `backend/test/**`, `backend/scripts/**`, `Dockerfile`, `.dockerignore`, `virtumetry/src/**`, `virtumetry/jest.setup.ts`, `virtumetry/package.json`
**Files scanned:** ~170 listed, 30 read
**Pattern extraction date:** 2026-11-24
