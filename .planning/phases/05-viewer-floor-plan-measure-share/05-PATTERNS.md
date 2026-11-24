# Phase 5: Viewer, Floor Plan, Measure & Share - Pattern Map

**Mapped:** 2026-11-24
**Files analyzed:** 38 (new + modified)
**Analogs found:** 32 / 38 (the rest are the three/Spark/bvh viewer engine files; there's no WebGL code in the repo yet, so use RESEARCH Patterns 1-6)

All paths are relative to the repo root `C:/Users/Uzi/Documents/GitHub/Virtumetry`.

## File Classification

| New/Modified File | Role | Data Flow | Closest Analog | Match |
|---|---|---|---|---|
| `backend/src/routes/share.ts` (new: owner + public + `/s/:slug`) | route | request-response, CRUD | `backend/src/routes/worlds.ts` (owner CRUD) + `webhooks.ts` (unauth scope, per-route rateLimit) + `auth-handler.ts` (scoped cors) | exact (composite) |
| `backend/src/routes/index.ts` (mod: register share routes) | route registry | — | itself, lines 60-84 | exact |
| `backend/src/routes/worlds.ts` (mod: `floorplan_meta` on detail only) | route | request-response | itself, lines 104-117 | exact |
| `backend/src/share/password.ts` (new, or inline in share.ts: scrypt hash/verify) | utility | transform | `backend/src/auth.ts` `secretEquals` (lines 30-34) | role-match |
| `backend/src/db/schema.ts` (mod: `share_slugs` + 3 cols) | model | — | itself, lines 229-237 | exact |
| `backend/drizzle/0004_*.sql` + `meta/0004_snapshot.json` + `_journal.json` | migration | — | `backend/drizzle/0003_better_auth.sql` via `npm run db:generate` | exact |
| `backend/src/config.ts` (mod: `MOCK_OUTPUTS_SET`, `WEB_SHARE_ORIGIN`; `PUBLIC_BASE_URL` already exists) | config | — | itself: `MOCK_SCENARIO` enum (line 82) + https refine (lines 218-235) | exact |
| `backend/src/provider/index.ts` (mod: pass `outputsDir`) | factory | — | itself, lines 11-20 | exact |
| `backend/src/provider/mock.ts` (mod: add `thumbnail.jpg` to OUTPUTS, set dir) | service | file-I/O | itself, lines 25-38, 70 | exact |
| `backend/src/provider/types.ts` (mod: `ArtifactKind` += `'thumbnail'`) | type | — | itself, line 29 | exact |
| `backend/src/pipeline.ts` (mod: `KEY_COLUMN.thumbnail`, widen `keys` type) | service | batch | itself, lines 283-288, 386-394 | exact |
| `backend/scripts/make-demo-room.ts` (new) | script | file-I/O | `backend/scripts/make-tiny-session.ts` | exact |
| `backend/scripts/r2-cors-dev.mjs` (new) | script | request-response | `backend/scripts/test-r2.mjs` + `dev-guard.mjs` `assertDevBucket` | exact |
| `backend/test/fixtures/demo-room/*` (generated) | fixture | — | `backend/test/fixtures/mock-outputs/*` | exact |
| `Dockerfile`, `.dockerignore` (mod) | config | — | `Dockerfile` line 30, `.dockerignore` line 19 | exact |
| `backend/test/integration/share.pg.test.ts` (new) | test | — | `backend/test/integration/ownership.pg.test.ts` | exact |
| `backend/test/share-password.test.ts`, `share-cors.test.ts` (new) | test | — | `backend/test/config.test.ts` (pure); `test/helpers/auth-app.ts` `buildSessionApp` (boot) | role-match |
| `backend/test/demo-room.test.ts`, `provider/mock-outputs-set.test.ts` (new) | test | — | `backend/test/docker-mock-outputs.test.ts` | exact |
| `backend/test/docker-mock-outputs.test.ts`, `migrate-folder.test.ts`, `config.test.ts` (extend) | test | — | themselves | exact |
| `virtumetry/src/app/_layout.tsx` (mod: register `world`, public `r/[slug]`, web split) | layout | — | itself | exact |
| `virtumetry/src/app/world/_layout.tsx` (new) | layout | — | `virtumetry/src/app/capture/_layout.tsx` | exact |
| `virtumetry/src/app/world/[id]/index.tsx` (new viewer screen) | screen | request-response | `virtumetry/src/app/capture/scan.tsx` (always-dark, scrim top bar) + `(tabs)/index.tsx` (load/error states) | role-match |
| `virtumetry/src/app/world/[id]/share.tsx` (new modal) | screen | CRUD | `virtumetry/src/app/(tabs)/index.tsx` (list, RefreshControl, Alert confirm) + `components/rename-modal.tsx` (TextInput) | role-match |
| `virtumetry/src/app/r/[slug].tsx` (new public web route) | screen | request-response | `(tabs)/index.tsx` states; no public route exists yet | partial |
| `virtumetry/src/app/(tabs)/index.tsx` + `components/library-row.tsx` (mod: open ready world) | screen/component | — | themselves (`openScan`, `onOpen`) | exact |
| `virtumetry/src/lib/api.ts` (mod: `useWorld`) + `virtumetry/src/lib/shares.ts` (new) | hooks | CRUD | `virtumetry/src/lib/api.ts` `useWorlds` / `useDeleteWorld` | exact |
| `virtumetry/src/viewer/{coords,floorplan,measure,recovery,tokens}.ts` (pure) | utility | transform | `virtumetry/src/capture/coverage.ts` | role-match |
| `virtumetry/src/viewer/progress.ts` | utility | streaming | none (RESEARCH Pattern 2) | none |
| `virtumetry/src/viewer/world-viewer.tsx` (`'use dom'`), `engine.ts`, `walk.ts` | component/engine | event-driven | none (RESEARCH Patterns 1, 4, 5) | none |
| `virtumetry/src/__tests__/viewer-*.test.ts` | test | — | `virtumetry/src/__tests__/capture-coverage.test.ts` | exact |
| `virtumetry/src/__tests__/world-screen.test.tsx`, `share-sheet.test.tsx`, `share-web-route.test.tsx` | test | — | `virtumetry/src/__tests__/library-actions.test.tsx` + `capture-review.test.tsx` (expo-router mock) | exact |
| `virtumetry/package.json` (mod: pinned deps + `web:export:dev`; maybe `transformIgnorePatterns`) | config | — | itself (`jest` block) | exact |

---

## Pattern Assignments

### `backend/src/routes/share.ts` (route, owner CRUD + public)

**Owner-scoped handler.** Copy from `backend/src/routes/worlds.ts` lines 104-117 and 160-176. `requireUserId`, `findOwnedWorld` and `serializeWorld` are exported, so import them; don't re-implement them.
```ts
import { and, desc, eq, isNull, sql } from 'drizzle-orm';
import { z } from 'zod';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { getDb } from '../db/client.js';
import { shareSlugs, worlds } from '../db/schema.js';
import { findOwnedWorld, requireUserId } from './worlds.js';
import type { RouteDeps } from './deps.js';

app.patch<{ Params: { id: string } }>('/v1/worlds/:id', async (req, reply) => {
  const userId = requireUserId(req, reply);
  if (!userId) return;
  const parsed = renameBody.safeParse(req.body);
  if (!parsed.success) return reply.code(400).send({ error: 'invalid_body' });
  const db = getDb();
  const world = await findOwnedWorld(db, req.params.id, userId);
  if (!world) return reply.code(404).send({ error: 'world_not_found' });
  const [row] = await db.update(worlds).set({ ... })
    .where(and(eq(worlds.id, world.id), eq(worlds.ownerId, userId), isNull(worlds.deletedAt)))
    .returning();
```
- The body schema follows `renameBody` (line 39): `z.object({ password: z.string().min(4).max(64).optional() }).strict()`.
- `:shareId` is a uuid. A non-uuid makes Postgres throw 22P02, so validate with zod first, or wrap the query like `findOwnedWorld` does with `isInvalidTextRepresentation` (lines 218-220, 257-273). Answer 404 either way.
- Presign: reuse the `ASSET_FIELDS` loop (lines 24-30, 111-115) with a 900 s TTL for public opens. Export `ASSET_FIELDS` instead of copying it. The public response omits `thumbnail_url`.

**Unauthenticated scope + per-route rate limit.** Copy from `backend/src/routes/webhooks.ts` lines 20-38:
```ts
export async function webhookRoutes(app: FastifyInstance, deps: RouteDeps & { db?: Db }): Promise<void> {
  const { config } = deps;
  await app.register(async (scope) => {
    scope.post('/v1/webhooks/spaitial', {
      config: {
        rateLimit: {
          max: config.RATE_LIMIT_WEBHOOK_MAX,
          timeWindow: config.RATE_LIMIT_WINDOW_MS,
          keyGenerator: (req: FastifyRequest) => `wh:${req.ip}`,
        },
      },
    }, async (req, reply) => { ... });
```
- The public scope adds `{ prefix: '/v1/public' }` to `app.register(...)` (RESEARCH Pattern 7 / Pitfall 8).

**Scoped CORS.** Copy from `backend/src/routes/auth-handler.ts` lines 19-21. Register it *inside* the scope, never at the root:
```ts
await app.register(async (scope) => {
  await scope.register(cors, { origin: false });
```
In share.ts that becomes `await pub.register(cors, { origin: [config.WEB_SHARE_ORIGIN, ...devOrigins], methods: ['GET','POST'] })`, and the scope is registered with `{ prefix: '/v1/public' }`. The `/s/:slug` landing doesn't need CORS.

**Atomic increment.** The `sql` template comes from `webhooks.ts` line 57 and `pipeline.ts` line 411 (`creditsSpent: sql\`COALESCE(${worlds.quotedCredits}, 0)\``). Use `openCount: sql\`${shareSlugs.openCount} + 1\`` with `.returning()`.

**Wrong-password throttle.** Reuse `FailureThrottle` from `backend/src/throttle.ts` without changing it (API: `isBlocked(key)`, `record(key)`, `reset(key)`, `retryAfterSeconds(key)`). Build it once per `registerRoutes` call, as `index.ts` lines 71-74 do:
```ts
const authFailures = new FailureThrottle({ max: config.AUTH_FAIL_MAX, windowMs: config.RATE_LIMIT_WINDOW_MS });
```
Use the `slug` as the key. When blocked, answer `429 { error: 'rate_limited', retry_after }`, the same shape as `index.ts` line 56.

**Error body convention:** `{ error: 'snake_code' }` everywhere, e.g. `world_not_found` and `invalid_body`. Public 404s return one identical body, `{ error: 'share_not_found' }`.

---

### `backend/src/routes/index.ts` (registration)

Insert next to the other unauthenticated routes, lines 60-66, *before* the authed scope:
```ts
// Provider webhook: its HMAC is its auth, so it lives outside the authed scope.
await webhookRoutes(app, deps);
// Better Auth: its own credentials are its auth, so also outside the scope.
if (deps.auth) await authHandlerRoutes(app, { auth: deps.auth, config });
```
→ add `await publicShareRoutes(app, deps);` (public + `/s/:slug`).

Owner routes go inside the authed scope, lines 77-84:
```ts
await app.register(async (authed) => {
  authed.addHook('onRequest', makeAuthPreHandler(config, authFailures, deps.auth));
  worldsRoutes(authed, deps);
  ...
```
→ add `shareRoutes(authed, deps);`.

The global limiter (lines 41-58) keys anonymous traffic by IP (`rateLimitKey`), so public routes already get a per-IP bound.

---

### `backend/src/routes/worlds.ts` (mod)

Line 116: `return reply.send({ world: serializeWorld(world), assets });`. Add `floorplan_meta: world.floorplanMeta` on the detail route only, e.g. `{ world: { ...serializeWorld(world), floorplan_meta: world.floorplanMeta }, assets }`. Don't put it in `serializeWorld`, because the list uses that too (RESEARCH Pitfall 1). Test it like `backend/test/worlds.list.test.ts`, which uses a `fakeWorld()` + `mockStorage()` pure test (lines 10-40).

---

### Password hash (`share.ts` or `backend/src/share/password.ts`)

**Analog:** `backend/src/auth.ts` lines 30-34. It's stdlib only and compares in constant time:
```ts
export function secretEquals(a: string, b: string): boolean {
  const ha = createHash('sha256').update(a, 'utf8').digest();
  const hb = createHash('sha256').update(b, 'utf8').digest();
  return timingSafeEqual(ha, hb);
}
```
For scrypt: `promisify(scrypt)`. Store the format from RESEARCH Pattern 8 (`scrypt$16384$8$1$<salt>$<hash>`). Verify with `timingSafeEqual` on equal-length buffers. Never use `===`.

---

### `backend/src/db/schema.ts` + migration 0004

Current table, lines 229-237:
```ts
export const shareSlugs = pgTable('share_slugs', {
  id: uuid('id').primaryKey().defaultRandom(),
  worldId: uuid('world_id').notNull().references(() => worlds.id),
  slug: text('slug').notNull().unique(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  revokedAt: timestamp('revoked_at', { withTimezone: true }),
});
```
Add `passwordHash: text('password_hash')`, `openCount: integer('open_count').notNull().default(0)` and `lastOpenedAt: timestamp('last_opened_at', { withTimezone: true })`. Every timestamp is timestamptz (schema comment line 243). Import `integer` if it isn't already imported.

**Migration flow:** run `cd backend && npm run db:generate`. That's drizzle-kit generate per `drizzle.config.ts`, with no DB connection and never `push`. Rename the generated file to a readable tag, e.g. `0004_share_links`, and update the journal tag to match. Apply it with `npm run db:migrate:dev`; `scripts/migrate-dev.mjs` runs `assertDevDb('MIGRATE_DATABASE_URL')` first. pg tests pick it up automatically, because `test/helpers/pg-schema.ts` lines 30-41 replay every journal entry.

Extend `backend/test/migrate-folder.test.ts` lines 18-25:
```ts
expect(journal.entries.map((e) => e.tag)).toEqual([
  expect.stringMatching(/^0000_init/), '0001_phase2_add', '0002_phase2_drop', '0003_better_auth',
  // + '0004_share_links'
]);
```
The worker purge already deletes the rows (`backend/src/worker.ts` line 186), so nothing changes there.

---

### `backend/src/config.ts` (mod)

**Enum env pattern:** copy lines 25-35 and 82:
```ts
export const MOCK_SCENARIOS = ['happy', 'failed', ...] as const;
MOCK_SCENARIO: z.enum(MOCK_SCENARIOS).default('happy'),
```
→ `MOCK_OUTPUTS_SETS = ['default', 'demo-room'] as const; MOCK_OUTPUTS_SET: z.enum(MOCK_OUTPUTS_SETS).default('default')`.

**https guard pattern:** copy lines 218-229. This runs for prod **or** any Railway service:
```ts
if (isProd || cfg.RAILWAY_ENVIRONMENT_ID) {
  const where = isProd ? 'NODE_ENV=production' : 'a deployed (Railway) service';
  if (cfg.AUTH_MODE === 'session' && !cfg.BETTER_AUTH_URL?.startsWith('https://')) {
    throw new Error(`BETTER_AUTH_URL must be https under ${where}`);
  }
```
→ `WEB_SHARE_ORIGIN: z.string().optional()`. Check it with `URL.canParse` (lines 205-206 style), and require `https://` under `where`.

`PUBLIC_BASE_URL` already exists (line 65) and defaults to `http://localhost:${PORT}` in `refine()` (line 254). It's only used by the local storage driver today, so the landing reuses it and needs no new var.

**Tests:** copy the style of `backend/test/config.test.ts` line 70-72:
```ts
it('accepts every mock scenario and rejects unknown ones', () => {
  expect(loadConfig(env({ ...base, MOCK_SCENARIO: '429' })).MOCK_SCENARIO).toBe('429');
  expect(() => loadConfig(env({ ...base, MOCK_SCENARIO: 'explode' }))).toThrow(/MOCK_SCENARIO/);
```
Fixtures: `base`, `devLocal` and `s3()` are at lines 15-46.

---

### Mock provider + importer (thumbnail, outputs set)

`backend/src/provider/mock.ts` lines 25-38:
```ts
const DEFAULT_OUTPUTS_DIR = fileURLToPath(new URL('../../test/fixtures/mock-outputs/', import.meta.url));
const OUTPUTS: { kind: ArtifactKind; name: string; contentType: string }[] = [
  { kind: 'splat', name: 'splat.ply', contentType: 'application/octet-stream' },
  ...
  { kind: 'cameras', name: 'cameras.json', contentType: 'application/json' },
];
```
- Add `{ kind: 'thumbnail', name: 'thumbnail.jpg', contentType: 'image/jpeg' }`. Mock-outputs then needs a `thumbnail.jpg` too, or the `artifacts()` filter has to skip missing files. Simplest: generate a tiny one for mock-outputs as well, and extend the `docker-mock-outputs.test.ts` name list at line 26.
- `opts.outputsDir` already exists (lines 62 and 70). `createProvider` (`provider/index.ts` lines 11-17) just passes `outputsDir: config.MOCK_OUTPUTS_SET === 'demo-room' ? DEMO_DIR : undefined`. The demo dir resolves the same way as `DEFAULT_OUTPUTS_DIR`.

`backend/src/provider/types.ts` line 29: `export type ArtifactKind = 'splat' | 'collider' | 'floorplan' | 'floorplan_meta' | 'cameras';` gets `| 'thumbnail'`.

`backend/src/pipeline.ts` lines 283-288 and 386:
```ts
const KEY_COLUMN: Partial<Record<ArtifactKind, 'splatKey' | 'colliderKey' | 'floorplanKey' | 'camerasKey'>> = {
  splat: 'splatKey', collider: 'colliderKey', floorplan: 'floorplanKey', cameras: 'camerasKey',
};
const keys: Partial<Record<'splatKey' | 'colliderKey' | 'floorplanKey' | 'camerasKey', string>> = {};
```
Add `'thumbnailKey'` to both unions and `thumbnail: 'thumbnailKey'` to the map. The `...keys` spread at line 407 then writes it with no other change.

---

### `backend/scripts/make-demo-room.ts` (script, file-I/O)

**Analog:** `backend/scripts/make-tiny-session.ts`.
- Header doc comment + usage line: lines 1-9.
- Imports: `execFileSync`, `node:fs` `mkdirSync/writeFileSync`, `node:path` `join`, `pathToFileURL` (lines 11-14).
- 4x4 helpers `mul`, `transpose`, `F`, `rigidInv`: lines 28-41. Copy them, or import them if they get exported.
- ffmpeg wrapper, line 74: `const ffmpeg = (args: string[]) => execFileSync('ffmpeg', ['-loglevel', 'error', '-y', ...args]);`
- Binary 3DGS PLY header + `Buffer.concat`: lines 166-172.
- ASCII collider PLY: lines 177-178.
- `floorplan.json` / `cameras.json` writers: lines 154-155 and 182-190. Keep the same keys (`schema_version: 'spaitial.capture_cameras.v1'`, `download_url`).
- Entry guard, lines 199-205: `if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) { main(...) }`. Export `main` and the pure builders so `demo-room.test.ts` can check them.
- Add a `package.json` script in the existing style, e.g. `"demo-room": "node --import tsx scripts/make-demo-room.ts"`. It needs no env.

### `backend/scripts/r2-cors-dev.mjs`

**Analog:** `backend/scripts/test-r2.mjs` lines 1-12:
```js
// Usage: cd backend && node --env-file=.env scripts/test-r2.mjs
import { assertDevBucket } from './dev-guard.mjs';
try { assertDevBucket(); } catch (err) { console.error(`[test-r2] ${err.message}`); process.exit(1); }
```
Then `new S3Client({ endpoint: process.env.S3_ENDPOINT, region: 'auto', credentials })`, followed by `PutBucketCorsCommand` and `GetBucketCorsCommand`.

### Dockerfile / .dockerignore

`Dockerfile` lines 28-30 and `.dockerignore` line 19. Add the parallel lines:
```
COPY --chown=node:node backend/test/fixtures/demo-room ./test/fixtures/demo-room
!backend/test/fixtures/demo-room
```
Extend `backend/test/docker-mock-outputs.test.ts`, which uses the regex-on-Dockerfile style at lines 11-23.

---

### `backend/test/integration/share.pg.test.ts` (test)

**Analog:** `backend/test/integration/ownership.pg.test.ts`. Copy the whole skeleton:
- Lines 1-8: `vi.mock('../../src/db/client.js', () => ({ getDb: () => currentDb, closeDb: async () => {} }))` **before** the helper imports.
- Line 17: `describe.skipIf(!url)(...)` with `const url = process.env.TEST_DATABASE_URL`.
- Lines 27-37: the `call(method, path, cookie?, body?)` inject helper. Add `'POST'` to the method union. Public calls pass no cookie. Bodiless DELETE sends a Cookie only and no content-type (lines 136-154 explain why).
- Lines 40-50: the `owner(email, pw)` sign-in helper.
- Lines 52-55: `insertWorld`. For shares, insert `status: 'ready'` plus asset keys (`splatKey`, `thumbnailKey`, `floorplanMeta`) so presign and OG paths run.
- Lines 60-76: `beforeAll` (`createTestSchema(url!, { max: 4 })`, `buildSessionApp({ db, env: { AUTH_RATE_LIMIT: '0', WEB_SHARE_ORIGIN: ... } })`, `seedOwner`) and `afterAll` (`app.close()`, `schema.drop()`).
- Assert DB state through `schema.pool.query(...)` (lines 57-58).

`buildSessionApp` (`backend/test/helpers/auth-app.ts` lines 18-34) takes `env` overrides. It uses the local storage driver, so presigned URLs are `PUBLIC_BASE_URL/dev-storage/...`, which is fine for asserting presence. Run with `npm run test:pg -- test/integration/share.pg.test.ts`.

---

## App (virtumetry/)

### `virtumetry/src/app/_layout.tsx` (mod)

The current guard structure is lines 38-48:
```tsx
<Stack screenOptions={{ headerShown: false }}>
  <Stack.Protected guard={!!data}>
    <Stack.Screen name="(tabs)" />
    <Stack.Screen name="capture" options={{ presentation: 'fullScreenModal' }} />
  </Stack.Protected>
  <Stack.Protected guard={!data}>
    <Stack.Screen name="sign-in" />
  </Stack.Protected>
</Stack>
```
- Add `<Stack.Screen name="world" />` inside the signed-in group.
- Add `<Stack.Screen name="r/[slug]" />` **outside** both groups.
- Line 35 `if (isPending) return null;` blocks `/r/*` on web. Split the layout as RESEARCH Pattern 10 says (`Platform.OS === 'web' && segments[0] === 'r'` → a public layout with no `useSession` and no upload manager). `QueryClientProvider client={queryClient}` (lines 39-40) still wraps both.

### `virtumetry/src/app/world/_layout.tsx`

**Analog:** `virtumetry/src/app/capture/_layout.tsx`, the whole file:
```tsx
import { Stack } from 'expo-router';
export default function CaptureLayout() {
  return <Stack screenOptions={{ headerShown: false }} />;
}
```
Add `<Stack.Screen name="[id]/index" options={{ gestureEnabled: false }} />` and `<Stack.Screen name="[id]/share" options={{ presentation: 'modal' }} />` (UI-SPEC A/D).

### `virtumetry/src/app/world/[id]/index.tsx` (viewer screen)

**Always-dark + scrim top bar analog:** `virtumetry/src/app/capture/scan.tsx`.
- Line 22: `import { Colors, Spacing } from '@/constants/theme';`
- Lines 24-26: `const D = Colors.dark;` and `const SCRIM = 'rgba(0,0,0,0.6)';`. On viewer screens use `VT.scrim` from `src/viewer/tokens.ts` instead.
- Line 3: `useKeepAwake` from `expo-keep-awake`. Line 5: `StatusBar style="light"` (line 165).
- Lines 176-183, a top bar Pressable:
```tsx
<View style={[styles.topBar, { backgroundColor: SCRIM }]}>
  <Pressable accessibilityRole="button" accessibilityLabel="Cancel scan" onPress={cancel}
    style={({ pressed }) => [styles.topButton, pressed && styles.pressed]}>
```
- Line 38: `const close = () => router.back();`
- Icons: `SymbolView` from `expo-symbols`. See `(tabs)/index.tsx` line 42: `<SymbolView name="plus" size={16} tintColor={theme.onAccent} />`.
- Insets: the screen needs `useSafeAreaInsets` from `react-native-safe-area-context`, which `scan.tsx` already imports for `SafeAreaView` at line 8. The numbers go to the DOM component as the `insets` prop.

**Load / error / retry states analog:** `virtumetry/src/app/(tabs)/index.tsx` lines 159-185:
```tsx
<ActivityIndicator testID="library-loading" size="large" color={theme.accent} />
...
<ThemedText type="subtitle" style={styles.heading}>{"Couldn't load your scans"}</ThemedText>
<ThemedText themeColor="textSecondary" style={styles.textCenter}>Check your connection, then try again.</ThemedText>
<Pressable accessibilityRole="button" accessibilityLabel="Try again" onPress={() => refetch()} style={...}>
```
Styles: `retry` is `minHeight 44, borderRadius 12` (lines 262-268), and `center` is at line 259. Distinguish 404 with `error instanceof ApiError && error.code === 'world_not_found'` (`lib/api.ts` lines 10-18).

**DOM component:** no analog exists. Use RESEARCH Pattern 1 (the `key`/`dom={{ onContentProcessDidTerminate, onRenderProcessGone }}` wiring) and the `recovery.ts` reducer through `useReducer`. The repo has no `useReducer` yet, so it follows plain React.

### `virtumetry/src/lib/api.ts` (mod: `useWorld`) + `virtumetry/src/lib/shares.ts` (new)

**Fetch helper:** use `apiFetch<T>(path, init)` (lines 26-46). It attaches the cookie, adds a JSON content type only when there's a body, throws `ApiError(status, code)`, and signs the user out on 401. The owner share calls go through it.

**Public calls (`/v1/public/*`) must NOT use `apiFetch`.** It needs `authClient.getCookie()`, and a 401 there triggers `endSession`; public 401 means `password_required`/`wrong_password`. Write a small `publicFetch` in `shares.ts` with the same `ApiError` code parsing, as in line 38:
```ts
const code = res.ok ? undefined : ((await res.json().catch(() => null))?.error as string | undefined);
```

**Query hook:** copy `useWorlds` (lines 54-61). For `useWorld(id)`, add `staleTime: Infinity, refetchOnWindowFocus: false, refetchOnReconnect: false` (RESEARCH anti-pattern: presigned URLs change on every refetch).

**Optimistic revoke:** copy `useDeleteWorld` (lines 82-113):
```ts
onMutate: async (id: string) => {
  await qc.cancelQueries({ queryKey: ['worlds'] });
  const snapshot = qc.getQueryData<WorldsPage>(['worlds']);
  qc.setQueryData<WorldsPage>(['worlds'], (old) => old && { ...old, worlds: old.worlds.filter((x) => x.id !== id) });
  return { snapshot };
},
onError: (_err, _id, ctx) => { if (ctx?.snapshot) qc.setQueryData(['worlds'], ctx.snapshot); ... },
onSettled: () => qc.invalidateQueries({ queryKey: ['worlds'] }),
```
→ queryKey `['shares', worldId]`. Show the UI-SPEC "Couldn't turn off the link…" inline error line instead of an Alert.

**Create (non-optimistic):** follow `useRenameWorld` (lines 67-79): `onSuccess` → `setQueryData` prepend + `invalidateQueries`.

Types: the world detail response is `{ world: LibraryItem & { floorplan_meta: unknown }, assets: { splat_url?, collider_url?, floorplan_url?, cameras_url?, thumbnail_url? } }`. `LibraryItem` is in `virtumetry/src/library/display-state.ts` lines 5-21.

### `virtumetry/src/app/world/[id]/share.tsx` (share sheet modal)

- **List + pull to refresh + separators:** `(tabs)/index.tsx` lines 205-219 (`FlatList`, `RefreshControl tintColor={theme.accent}`, hairline `separator` with `backgroundColor: theme.backgroundSelected`). Use a `ScrollView` if a FlatList inside the card layout is awkward.
- **Confirm destructive:** `(tabs)/index.tsx` lines 99-104:
```tsx
Alert.alert(`Delete "${title}"?`, "This removes it ...", [
  { text: 'Cancel', style: 'cancel' },
  { text: 'Delete', style: 'destructive', onPress: () => deleteWorld.mutate(id) },
]);
```
→ "Turn off this link?" / Keep link / Revoke link (UI-SPEC E).
- **Primary accent button:** `(tabs)/index.tsx` lines 36-47 (`backgroundColor: theme.accent`, `ThemedText themeColor="onAccent"`, `maxFontSizeMultiplier={1.6}`) and the `button` style at lines 249-256 (height 52, radius 12).
- **Password TextInput:** `virtumetry/src/components/rename-modal.tsx` lines 67-80, plus `useTheme()` from `@/hooks/use-theme`.
- **Theme:** `useTheme()` returns light/dark `Colors`. The share sheet follows the system scheme (UI-SPEC), so `theme.*` is fine here. Only the viewer surfaces are dark-only.

### `virtumetry/src/app/(tabs)/index.tsx` + `virtumetry/src/components/library-row.tsx` (mod)

- `library-row.tsx` lines 18-20 and 33-41: `onOpen` is local-only, and server rows get `{ disabled: true }`. Widen it so a server row with `status === 'ready'` is pressable (`accessibilityHint: 'Opens the room'`). Other statuses stay disabled (D-14).
- `(tabs)/index.tsx` lines 49-53, `openScan`:
```tsx
router.push({ pathname: '/capture/[id]', params: { id: scan.id, step: ... } });
```
→ add `router.push({ pathname: '/world/[id]', params: { id: item.id } })` for ready server rows.

### `virtumetry/src/app/r/[slug].tsx` (public web route)

No public route exists yet. Reuse:
- The state blocks from `(tabs)/index.tsx` lines 159-185 (spinner / heading + body + Try again). Since the page is always dark, use `VT`/`Colors.dark` literals, as `scan.tsx` line 25 does.
- `useLocalSearchParams<{ slug: string }>()` from `expo-router`. The test mock pattern is in `capture-review.test.tsx` lines 14-17.
- Lazy client-only viewer: follow RESEARCH Pattern 10. Never import `@/viewer/world-viewer` statically here.

### Pure viewer modules `virtumetry/src/viewer/{coords,floorplan,measure,recovery,tokens}.ts`

**Analog:** `virtumetry/src/capture/coverage.ts` lines 1-20. It's a pure module with exported types and small exported functions, plus a header comment citing the decision ID:
```ts
// D-10: top-down coverage for the mini-map. yawDeg/sectorOf are identical to
// backend frameYawDeg/yawSectorCount (validate.ts), so the ring agrees with the server.
export type Pt = { x: number; y: number };
```
Rule for the viewer: **no imports** in `coords`, `floorplan`, `measure`, `recovery` and `tokens`. The DOM bundle and jest both import them. `tokens.ts` must not import `@/constants/theme`, because that imports `@/global.css` and `react-native` (theme.ts lines 6-8).

### `virtumetry/src/__tests__/viewer-*.test.ts`

**Analog:** `virtumetry/src/__tests__/capture-coverage.test.ts` lines 1-13. It reads a backend fixture straight from disk, which is the same thing the demo-room `floorplan.json`/`cameras.json` round-trip tests need:
```ts
/// <reference types="node" />
import { readFileSync } from 'fs';
import { join } from 'path';
import { coverage, ... } from '@/capture/coverage';
const FIXTURE = join(__dirname, '../../../backend/test/fixtures/tiny-session/frames.jsonl');
```
→ `join(__dirname, '../../../backend/test/fixtures/demo-room/floorplan.json')`.

`viewer-tokens.test.ts`: `import { Colors } from '@/constants/theme'`. This works in jest because `jest.setup.ts` line 21 mocks `@/global.css`. Assert each `VT` color equals `Colors.dark` (UI-SPEC).

`viewer-walk.test.ts` imports `three` + `three-mesh-bvh`. If jest fails on ESM, append `|three|three-mesh-bvh` inside the existing `transformIgnorePatterns` negative group in `virtumetry/package.json` `jest`. Never import Spark or `three/addons/*` in jest.

### RNTL screen tests (`world-screen`, `share-sheet`, `share-web-route`)

**Analog:** `virtumetry/src/__tests__/library-actions.test.tsx` lines 1-96.
- Module mocks (lines 9-13):
```ts
jest.mock('@/config/api', () => ({ API_URL: 'https://api.test.invalid', APP_ENV: 'test' }));
jest.mock('@/lib/auth-client', () => ({ authClient: { getCookie: jest.fn(async () => 'better-auth.session_token=abc') } }));
jest.mock('@/lib/session', () => ({ endSession: jest.fn(async () => {}) }));
```
- Router mock (`capture-review.test.tsx` lines 14-17):
```ts
jest.mock('expo-router', () => ({
  router: { back: jest.fn(), replace: jest.fn(), push: jest.fn() },
  useLocalSearchParams: jest.fn(() => ({ id: 's1', step: 'review' })),
}));
```
- Fake fetch server (lines 52-68): `ok(body)` / `fail(status)` Response stubs, plus `globalThis.fetch = fetchMock` routing by `init.method`.
- Render with a fresh client (lines 74-85):
```tsx
const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity }, mutations: { retry: false } } });
await render(<QueryClientProvider client={client}><Screen /></QueryClientProvider>);
```
- Alert button driving (lines 87-93): `alertSpy = jest.spyOn(Alert, 'alert').mockImplementation(() => {})`, `lastButtons()`, `press(text)`.
- DOM component mock (RESEARCH Validation): `jest.mock('@/viewer/world-viewer', () => ...)` returns a `View testID="world-viewer"` and captures props. Also mock `react-native-safe-area-context` `useSafeAreaInsets` if the screen uses it and no provider is rendered. `Share.share` → `jest.spyOn(Share, 'share')`.
- Test file names follow `src/__tests__/<area>-<thing>.test.tsx`.

---

## Shared Patterns

### Owner auth + 404-for-others
**Source:** `backend/src/routes/worlds.ts` lines 41-47 (`requireUserId`) and 257-273 (`findOwnedWorld`, which also turns a junk uuid into undefined).
**Apply to:** every `/v1/worlds/:id/shares*` route. The routes go in the authed scope (`index.ts` lines 77-84). Never re-check auth by hand.

### Body validation
**Source:** `worlds.ts` lines 39 and 163-164. Use a `.strict()` zod schema with `safeParse` and answer `400 { error: 'invalid_body' }`. Query strings use `safeParse` → `400 invalid_query` (lines 126-131). Never `parse()`, because a throw becomes a 500.

### Rate limit
**Source:** `routes/index.ts` lines 41-58 (global) and `webhooks.ts` lines 31-37 (per-route `config.rateLimit`, `keyGenerator: (req) => \`prefix:${req.ip}\``). New numbers go in `config.ts` as `numberFromEnv(n)` (lines 18-23, 103-118), e.g. `RATE_LIMIT_PUBLIC_MAX`.

### Constant-time secrets
**Source:** `backend/src/auth.ts` lines 30-34 (`secretEquals`). Use `timingSafeEqual` for every secret compare.

### Dev-only resource guard
**Source:** `backend/scripts/dev-guard.mjs` (`assertDevDb`, `assertDevBucket`). Any script that touches Neon or R2 calls one of them first.

### Theme on RN surfaces
**Source:** `virtumetry/src/constants/theme.ts` (`Colors`, `Spacing.one..six` = 4..64) and `useTheme()` (`@/hooks/use-theme`). `ThemedText` takes `type="title|subtitle|smallBold|small"` and `themeColor="textSecondary|onAccent|destructive"` (see `(tabs)/index.tsx` lines 43, 145, 151). Viewer and web screens use `Colors.dark` directly (`scan.tsx` line 25) or `VT`.

### Accessibility on Pressables
**Source:** `(tabs)/index.tsx` lines 37-41 and 174-177. Every Pressable gets `accessibilityRole="button"` + `accessibilityLabel`, plus `({ pressed }) => [..., pressed && styles.pressed]` with `pressed: { opacity: 0.8 }`.

### Env loading for scripts
**Source:** `backend/package.json` scripts: `node --env-file=.env --import tsx scripts/x.ts`. The app web export uses the same trick: `"web:export:dev": "node --env-file=.env.development node_modules/expo/bin/cli export --platform web"` (RESEARCH Pitfall 5).

---

## No Analog Found

| File | Role | Data Flow | Reason → use |
|---|---|---|---|
| `virtumetry/src/viewer/world-viewer.tsx` | `'use dom'` component | event-driven | No DOM components in the repo. Use RESEARCH Pattern 1 and UI-SPEC B |
| `virtumetry/src/viewer/engine.ts` | three/Spark engine | event-driven | No WebGL code. Use RESEARCH Patterns 2, 3, 5 |
| `virtumetry/src/viewer/walk.ts` | collision | transform | Use RESEARCH Pattern 4 (three-mesh-bvh characterMovement recipe) |
| `virtumetry/src/viewer/progress.ts` | streamed fetch | streaming | Use RESEARCH Pattern 2 |
| `/s/:slug` HTML landing (in `share.ts`) | route | request-response (HTML) | No HTML routes exist. Use RESEARCH "Landing HTML" with the `esc()` helper and UI-SPEC G |
| `virtumetry/src/app/r/[slug].tsx` client-only boundary | screen | — | No public or web-only route. Use RESEARCH Pattern 10 |

## Metadata

**Analog search scope:** `backend/src/{routes,provider,db,config.ts,auth.ts,throttle.ts,pipeline.ts,worker.ts}`, `backend/{scripts,test,drizzle}`, `Dockerfile`, `.dockerignore`, `virtumetry/src/{app,components,lib,config,constants,capture,library,__tests__}`, `virtumetry/{package.json,jest.setup.ts}`
**Files scanned:** about 40
**Pattern extraction date:** 2026-11-24
