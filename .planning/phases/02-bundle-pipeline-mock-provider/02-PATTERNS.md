# Phase 2: Bundle Pipeline & Mock Provider - Pattern Map

**Mapped:** 2026-11-23
**Files analyzed:** 38 (new + modified)
**Analogs found:** 31 / 38 (7 have no analog in the codebase; use the RESEARCH.md Code Examples for those)

All paths are relative to `backend/`. Conventions that apply everywhere:
- ESM with `.js` import suffixes (`import { x } from './queue.js'`), `"module": "NodeNext"`, `strict` + `noUncheckedIndexedAccess`, so use `!` or guards on indexed reads.
- `tsconfig.json` has `include: ["src"]`, `rootDir: "src"`, `exclude: ["test"]`. **`tsc --noEmit` checks only `src/`.** `scripts/*.ts` run through `tsx` and are not type-checked. Anything `scripts/` needs at runtime must be imported from `src/` (e.g. `arkitToOpenCV`).
- vitest 2.1, `environment: 'node'`, `include: ['test/**/*.test.ts']`. New test folders (`test/bundle/`, `test/provider/`) are picked up with no config change. `test/helpers/*.ts` and `test/fixtures/**` are not test files because they don't match `*.test.ts`.
- Comments explain *why* and cite the decision (`D-xx`, `spec §10 Rnn`). Keep that style and cite Phase 2 `D-xx` ids.

## File Classification

| New/Modified File | Role | Data Flow | Closest Analog | Match Quality |
|---|---|---|---|---|
| `src/bundle/manifest.ts` (new) | model (zod contract) | transform | `src/config.ts` (zod schema + safeParse + joined issues) | role-match |
| `src/bundle/convert.ts` (new) | utility (pure math) | transform | `src/budget.ts` `wouldExceedBudget` / `src/queue.ts` `backoffSeconds` (pure exported helpers) | partial; body from RESEARCH Ex.1 |
| `src/bundle/exif.ts` (new) | utility (binary) | transform | none (Buffer writers) | no analog; RESEARCH Ex.2 |
| `src/bundle/validate.ts` (new) | utility (rules) | transform | `src/worker.ts` `isWorldReapable` / `src/queue.ts` `isJobClaimable` (pure predicate + named constants) | partial |
| `src/bundle/zipread.ts` (new) | utility (binary) | file-I/O (Range) | none | no analog; RESEARCH Ex.4 |
| `src/bundle/pack.ts` (new) | service | streaming | `src/worker.ts` `handlePurge` (deps-injected handler iterating storage keys) | role-match |
| `src/provider/types.ts` (rewrite) | model/interface | request-response | itself (current `WorldGenProvider` + `ProviderError`) | exact |
| `src/provider/mock.ts` (rewrite) | service (fake) | request-response + event-driven | itself (current `createMockProvider`) | exact |
| `src/provider/index.ts` (modify) | factory | — | itself | exact |
| `src/routes/webhooks.ts` (new) | route | event-driven (inbound) | `src/storage/local.ts` `registerDevStorageRoutes` (buffer parser) + `src/routes/worlds.ts` POST `/v1/worlds` (per-route rateLimit) | role-match |
| `src/routes/index.ts` (modify) | route registry | — | itself | exact |
| `src/jobs/{pack,submit,track}.ts` or inline in `worker.ts` (new) | worker handler | batch / request-response | `src/worker.ts` `handlePurge` + `reapStaleUploads` | exact |
| `src/worker.ts` (modify) | worker loop | batch | itself | exact |
| `src/queue.ts` (modify: `snoozeJob`, `failJob(delaySeconds?)`, drop provider-op fns) | utility (SQL) | CRUD | `failJob` / `completeJob` in same file | exact |
| `src/budget.ts` (modify) | service (money) | CRUD (transactional) | itself (`reserveCredits` advisory lock) | exact |
| `src/storage/index.ts` (modify: `putStream`, `getStream`, `list`) | interface | streaming | itself | exact |
| `src/storage/s3.ts` (modify) | driver | streaming | itself (`getObject`, `presignDownload`) | exact |
| `src/storage/local.ts` (modify; + Range on dev GET) | driver | streaming / file-I/O | itself (`putObject`, `safeJoin`, `/dev-storage/*` GET) | exact |
| `src/db/schema.ts` (modify) | model | CRUD | itself | exact |
| `drizzle/0001_*.sql`, `drizzle/0002_*.sql` (generated) | migration | — | `drizzle/0000_init.sql` | exact (generated, not hand-written) |
| `src/config.ts` (modify: new env vars) | config | — | itself (`numberFromEnv`, `DAILY_CREDIT_BUDGET`) | exact |
| `src/routes/worlds.ts` (modify minimally: status literals, frames:done) | route | CRUD | itself (frames:done conditional flip in txn) | exact |
| `scripts/make-tiny-session.ts` (new) | script (one-off) | file-I/O / batch | `src/migrate.ts` `main()` + direct-run guard | partial |
| `scripts/fixture-e2e.ts` (new) | script (dev) | batch | `src/worker.ts` `main()` + `src/migrate.ts` | partial |
| `scripts/test-pg.mjs`, `scripts/test-r2.mjs` (new) | script (env guard) | — | `src/config.ts` isolation checks (`neonEndpointId`, `isPoolerUrl`, bucket checks) | partial |
| `test/bundle/{convert,exif,validate,pack}.test.ts` (new) | test (unit) | — | `test/budget.test.ts` (pure fns), `test/storage.local.test.ts` (mkdtemp) | role-match |
| `test/provider/mock.test.ts` (replaces `test/mock-provider.test.ts`) | test | — | `test/mock-provider.test.ts` | exact |
| `test/webhooks.test.ts` (unit, inject) | test | — | `test/readyz.test.ts` (Fastify + `inject`, `vi.mock` db) | exact |
| `test/integration/{pipeline,budget,webhooks}.pg.test.ts` (new) | test (pg) | — | `test/integration/queue.pg.test.ts`, `quota.pg.test.ts` | exact |
| `test/integration/queue.pg.test.ts` (extend: snooze) | test (pg) | — | itself | exact |
| `test/integration/r2-range.s3.test.ts` (new) | test (gated S3) | — | `queue.pg.test.ts` `describe.skipIf(!url)` gating | role-match |
| `test/helpers/pg-schema.ts` (new) | test helper | file-I/O | `queue.pg.test.ts` lines 41-89 (schema + search_path hook) + `src/migrate.ts` `MIGRATIONS_FOLDER` | role-match |
| `test/helpers/capture-exif.ts` (vendored MIT-0) | test helper | — | none (vendored verbatim) | no analog |
| `test/fixtures/tiny-session/**`, `test/fixtures/mock-outputs/**` | fixture | — | `src/provider/mock.ts` inline fixtures (being replaced) | partial |
| `test/config.test.ts` (extend) | test | — | itself | exact |
| `test/budget.test.ts`, `test/worker.test.ts`, `test/frames-done.test.ts`, etc. (adjust/delete World Labs bits) | test | — | themselves | exact |
| `package.json` (deps + scripts) | config | — | itself | exact |
| `README.md` (env table, subsystems) | docs | — | itself (`## Job queue and worker`, `## Dev storage`) | exact |

---

## Pattern Assignments

### `src/bundle/manifest.ts` (model, transform)

**Analog:** `src/config.ts`

**zod schema + safeParse + flattened issues** (`src/config.ts` lines 1, 24-29, 210-219):
```ts
import { z } from 'zod';
const baseSchema = z.object({
  DATABASE_URL: z.string().min(1, 'DATABASE_URL is required'),
  ...
});
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = baseSchema.safeParse(env);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `${i.path.join('.')}: ${i.message}`)
      .join('; ');
    throw new Error(`Invalid environment: ${issues}`);
  }
  return refine(parsed.data);
}
```
Apply: `SessionV1 = z.object({ sessionId, schema: z.literal(1), ..., tzOffset: z.string().regex(/^[+-]\d{2}:\d{2}$/) })` (locks Assumption A2), `FrameLineV1` with `T_arkit: z.array(z.number()).length(16)`, `K: z.object({fx,fy,cx,cy})`. `parseFramesJsonl(text)` splits lines, prefixes issues with the 1-based line number, and uses the same `.map(i => path: message).join('; ')` formatting. `schema: z.literal(1)` rejects unknown versions (D-02). The zod 4 install is `^4.6.7`.

Second analog for request-body zod use: `src/routes/worlds.ts` frames:done lines 322-328 (`safeParse` then return a structured `{ error, issues }`). Mirror it so validate failures can carry `issues` into `failure_message`.

---

### `src/bundle/convert.ts`, `src/bundle/validate.ts` (utility, transform)

**Analog:** pure exported helpers with named constants. `src/queue.ts` lines 9-11 and 49-52, `src/worker.ts` lines 178-192.

```ts
export const MAX_ATTEMPTS = 5;
const BASE_BACKOFF_SECONDS = 30;
/** Exponential backoff ... Pure — exported for testing. */
export function backoffSeconds(attempts: number): number { ... }

/** How long a world may sit in `uploading` before the reaper fails it. */
export const REAPER_STALE_UPLOAD_MS = 24 * 60 * 60 * 1000;
/** Pure mirror of the reapStaleUploads WHERE clause ... */
export function isWorldReapable(world: Pick<World, 'status' | 'createdAt'>, now: Date = new Date(), maxAgeMs: number = REAPER_STALE_UPLOAD_MS): boolean
```
Apply: D-06 thresholds go in exported `UPPER_SNAKE` constants with a JSDoc each (`MAX_LONG_EDGE = 1920`, `MIN_SHORT_EDGE = 360`, `MIN_F = 100`, `MAX_F = 10000`, `MAX_CENTRE_JUMP_M = 0.5`, `ROT_TOL = 1e-4`, `BOTTOM_ROW_TOL = 1e-6`). `validate*` returns `{ code, message }[]` and never throws, like a pure predicate. Defaults are overridable params so tests can pass tighter limits. Bodies: RESEARCH Code Example 1 (`arkitToOpenCV` returns `number[][]` 4x4, per Pitfall 2) and the rotation checks described under it.

---

### `src/bundle/exif.ts`, `src/bundle/zipread.ts` (utility, binary)

**No codebase analog.** Copy RESEARCH.md Code Example 2 (`exifApp1`, `withExif`, `jpegSize`) and Code Example 4 (`readCentralDirectory`, `readEntry`, `ReadRange`) verbatim. Both were verified in research. Keep the `ponytail:` comment on zipread (no ZIP64).

---

### `src/bundle/pack.ts` (service, streaming)

**Analog:** `src/worker.ts` `handlePurge` (lines 70-81, 90-124). This handler takes a deps object, walks storage keys for a capture, and does DB writes after the storage work.

**Deps injection** (lines 70-81):
```ts
export interface WorkerDeps {
  db: Db;
  storage: StorageDriver;
  config: Config;
  push: SendPush;
  clock?: WorkerClock;
  workerId?: string;
}
```
Apply: `packCapture(deps: Pick<WorkerDeps,'storage'>, captureId, opts)` returns `{ bundleKey, bundleBytes }`, with no DB access, so `test/bundle/pack.test.ts` can run it against the local driver alone. The job handler owns the DB writes.

**Key layout constant** (line 46):
```ts
const assetKeyFor = (worldId: string, name: string) => `worlds/${worldId}/${name}`;
```
Apply: `captureKey(cid, rel) => \`captures/${cid}/${rel}\``, `bundleKeyFor(cid) => \`bundles/${cid}/capture_bundle.zip\``, `worldAssetKey(wid, v, name) => \`worlds/${wid}/v${v}/${name}\`` (D-19). Export them so purge and tests share them.

**Size check before read** (`src/storage/index.ts` line 16, `MAX_FRAME_BYTES = 12 * 1024 * 1024`). Reuse it as the per-frame ceiling in validate/pack (D-07 "frames are ≤12 MB").

Streaming core: RESEARCH Code Example 3 plus Pitfall 10 (`zip.on('error', e => upload.abort(e))`). Heartbeat: call `heartbeatJob(db, job.id, workerId)` from the job handler between frames, and throw `LeaseLostError` on `false` (see the worker section).

---

### `src/provider/types.ts` (interface)

**Analog:** itself. Keep `ProviderError` / `ProviderTimeoutError` (lines 95-116) and extend `ProviderError` with `code?: string` and `retryAfterS?: number` for the 409/429/503 handling. Keep the current constructor shape:
```ts
export class ProviderError extends Error {
  readonly status?: number;
  readonly endpoint?: string;
  constructor(message: string, opts?: { status?: number; endpoint?: string; cause?: unknown }) {
    super(message, opts?.cause !== undefined ? { cause: opts.cause } : undefined);
    this.name = 'ProviderError';
    this.status = opts?.status;
    this.endpoint = opts?.endpoint;
  }
}
```
**Delete:** `WorldModel`, `MODEL_CREDITS`, `creditsForModel`, `OperationStatus`, `WorldAssets`, `WorldMatch`, `WorldGenProvider` (lines 1-93). Replace them with `ReconProvider { readonly mode: 'mock'|'live'; limits(); quote(n); submit(body: string, idempotencyKey); status(reqId); ensureExport(reqId, kind); artifacts(reqId); open(artifact): Promise<Readable>; cancel(reqId); verifyWebhook(raw: Buffer, sigHeader): boolean }` (D-11). Keep the existing doc-comment style that marks each method **FREE** or **SPENDS CREDITS** (lines 62-66, 73, 84).

Callers that break when these are removed (fix them in the same plan): `src/budget.ts` line 5 (`creditsForModel`), `test/worker.test.ts` lines 3, 11-19, `test/mock-provider.test.ts` (whole file). Grep `creditsForModel|MODEL_CREDITS|WorldGenProvider|budgetFits` in `src/routes/worlds.ts` too, since `budgetFits` is the advisory check for enhance/retry.

---

### `src/provider/mock.ts` (fake service, request-response + event-driven)

**Analog:** itself (current `createMockProvider`, lines 73-163).

**Factory with closure state** (lines 73-92):
```ts
interface MockState { operations: Map<string, string>; byDisplayName: Map<string, WorldMatch>; }
export function createMockProvider(): WorldGenProvider {
  const state: MockState = { operations: new Map(), byDisplayName: new Map() };
  ...
  return { mode: 'mock', ... };
}
```
Apply: `createMockProvider(opts: { scenario?, processingSeconds?, now?, webhookSecret?, deliver?, outputsDir?, readRange? })`. State is `Map<key, { body, requestId, submittedAt }>` plus a `calls: { submit: string[] }` counter exposed for tests (RESEARCH Ex.5). Use `randomUUID` from `node:crypto` (line 1) for `req_…` ids.

**"Cost is a property of the provider" rationale** (lines 95-101): keep that idea in a comment. The mock quote is `900 + n` (D-12), so the mock *does* consume a budget, but only within the `provider_mode='mock'` ledger partition.

**Errors** (line 158): `throw new ProviderError(\`mock asset not found: ${url}\`)`. Scripted 402/409/429/503 throw `new ProviderError(msg, { status, endpoint: 'POST /v1/worlds' })` with `code`/`retryAfterS`.

**Replace inline fixtures** (lines 20-71, base64 JPEG / gzip SPZ / GLB stubs) with `fs.createReadStream(path.join(outputsDir, name))` from `test/fixtures/mock-outputs/` (D-14). Default `outputsDir` resolved relative to the module, the same way `src/migrate.ts` line 37 does it:
```ts
export const MIGRATIONS_FOLDER = fileURLToPath(new URL('../drizzle', import.meta.url));
```
Caveat: `test/fixtures` is not shipped in the Docker image. The mock is dev/test only, but `createProvider` in a prod image with `PROVIDER_MODE=mock` would fail on `open()`. Either accept that (mock is never prod) or keep one tiny inline fallback. Planner decides.

**Range read for ZIP checks (D-08):** the mock needs a `ReadRange`. Against S3 that is `fetch(presignedUrl, { headers: { Range } })`. Against the **local driver**, the `/dev-storage/*` GET (`src/storage/local.ts` lines 106-114) does **not** honour `Range` today, because it sends the whole buffer with 200. Either add Range support to that route (small: parse `bytes=a-b`, reply 206 + `Content-Range`), or inject `readRange` into the mock in tests (built on `fs.open`/`read`). The RESEARCH test map's "Range via `app.listen(0)`" implies the first option.

---

### `src/provider/index.ts` (factory)

**Analog:** itself (lines 1-16). Keep the shape and the Phase 6 throw. Pass scenario config through:
```ts
export function createProvider(config: Config): WorldGenProvider {
  if (config.PROVIDER_MODE === 'mock') {
    return createMockProvider();
  }
  throw new Error('no live provider in this build (Phase 6)');
}
```
→ `createMockProvider({ scenario: config.MOCK_SCENARIO, processingSeconds: config.MOCK_PROCESSING_SECONDS, webhookSecret: config.SPAITIAL_WEBHOOK_SECRET, ... })`. Keep `export * from './types.js'`.

---

### `src/routes/webhooks.ts` (route, event-driven inbound)

**Analog 1, raw buffer parser:** `src/storage/local.ts` lines 90-93:
```ts
app.addContentTypeParser('*', { parseAs: 'buffer' }, (_req, body, done) => {
  done(null, body);
});
```
This parser is registered on the **root** app when `STORAGE_DRIVER=local`. That is why the webhook must sit in a child `register` scope with `removeAllContentTypeParsers()` first (RESEARCH Pitfall 8, Ex.6).

**Analog 2, per-route rate limit:** `src/routes/worlds.ts` lines 163-170:
```ts
app.post('/v1/worlds', {
  config: {
    rateLimit: {
      max: config.RATE_LIMIT_CREATE_MAX,
      timeWindow: config.RATE_LIMIT_WINDOW_MS,
      keyGenerator: (req: FastifyRequest) => `create:${req.userId ?? req.ip}`,
    },
  },
}, async (req, reply) => { ... });
```
Apply: `keyGenerator: (r) => \`wh:${r.ip}\``. Use `config.RATE_LIMIT_WINDOW_MS` and add a `RATE_LIMIT_WEBHOOK_MAX` env (default 120) instead of a hard-coded literal.

**Analog 3, constant-time compare:** `src/auth.ts` lines 1, 28-32:
```ts
import { createHash, timingSafeEqual } from 'node:crypto';
export function secretEquals(a: string, b: string): boolean {
  const ha = createHash('sha256').update(a, 'utf8').digest();
  const hb = createHash('sha256').update(b, 'utf8').digest();
  return timingSafeEqual(ha, hb);
}
```
Import it with `import { secretEquals } from '../auth.js'` and don't re-implement it.

**Route function signature:** follow `worldsRoutes(app, deps: RouteDeps)` / `healthRoutes(app, { storage })`. Use `RouteDeps` from `src/routes/deps.ts` (`{ config, storage }`). The DB comes from `getDb()` inside the handler, like every other route.

**Error body shape:** routes reply `reply.code(N).send({ error: 'snake_case_code' })` (e.g. `world_not_found`, `invalid_body`). Use `invalid_signature` / `missing_headers`.

Full body: RESEARCH Code Example 6.

---

### `src/routes/index.ts` (modify)

**Analog:** itself, lines 57-59 vs 69-76. The webhook goes in the **unauthenticated** block, next to health/dev-storage, *after* the global `rateLimit` register (so `config.rateLimit` on the route works) and *outside* the `authed` scope:
```ts
// Unauthenticated: liveness + (dev-only) local storage.
healthRoutes(app, { storage: deps.storage });
registerDevStorageRoutes(app, deps.storage);
// + await webhookRoutes(app, deps);   // HMAC is its auth; nudge-only
```
Note: the global limiter's `max` for anonymous traffic is `RATE_LIMIT_IP_MAX`. The per-route `config.rateLimit` overrides it for the webhook.

---

### Job handlers `pack` / `submit` / `track` (worker handler, batch)

**Analog:** `src/worker.ts`.

**Dispatch** (lines 126-133). Add cases and extend `WORKER_KINDS` (line 22) to `['pack','submit','track','purge']`:
```ts
export async function processJob(deps: WorkerDeps, job: Job): Promise<void> {
  switch (job.kind as JobKind) {
    case 'purge':
      return handlePurge(deps, job);
    default:
      throw new NonRetryableJobError(`unknown job kind: ${job.kind}`);
  }
}
```
`WorkerDeps` (lines 70-81) gains `provider: ReconProvider`. `main()` (lines 294-302) builds it with `createProvider(config)`.

**Error classification** (lines 24-43, 135-156). Reuse these: `NonRetryableJobError` leads to `parkJobDead` (409, budget exceeded, validate failure), `LeaseLostError` means walk away, anything else goes to `failJob`. Submit's `Retry-After` path needs `failJob(db, id, msg, delaySeconds)` (Pattern 2 in RESEARCH). Wire it by giving `handleJobError` a typed error carrying `retryAfterS` (e.g. `RetryLaterError`) rather than a new queue function.

**Flip + enqueue in one transaction**, from `reapStaleUploads` lines 205-222:
```ts
return db.transaction(async (tx) => {
  const rows = await tx
    .update(worlds)
    .set({ status: 'failed_upload', progress: null, updatedAt: sql`now()` })
    .where(and(eq(worlds.status, 'uploading'), lt(worlds.createdAt, sql`now() - interval '24 hours'`)))
    .returning({ id: worlds.id });
  for (const row of rows) {
    await enqueue(tx, 'purge', row.id, { framesOnly: true });
  }
  return rows.map((r) => r.id);
});
```
and `src/routes/worlds.ts` lines 338-350 (conditional flip `WHERE id=$1 AND status=$expected`, `if (!row) return null`). Apply to packing→submitting (+enqueue submit), submitting→processing (+`provider_request_id` +enqueue track), processing→importing, importing→ready (single UPDATE with all `*_key` + `charged=true`), and every `failed` transition (`failure_stage/code/message`). Zero rows returned means `completeJob` and stop (RESEARCH Pattern 3). Reset `progress: null` on each status change (schema comment lines 75-78).

**Logging style** (lines 147, 152, 218): `console.error(\`[worker] job ${job.id} (${job.kind}) …\`)`. Log ids and keys only, never presigned URLs (RESEARCH Security V7). The 409 "loud log" uses `console.error('[worker] … IDEMPOTENCY_KEY_REUSED …')`.

**Purge rewrite** (lines 46-54, 98-110). Replace `WORLD_ASSET_NAMES` and the `frame_${i}.heic` loop with `storage.list(prefix)` then delete, for `captures/{cid}/`, `bundles/{cid}/`, `worlds/{wid}/` (RESEARCH "Deprecated"). Keep the `.catch(() => undefined)` idempotent-delete style.

**Reaper** (lines 186-223) flips `uploading` → `failed_upload`. With D-15 the status set changes, so make this `status='failed', failure_stage='upload'` and keep the `isWorldReapable` mirror in sync.

---

### `src/queue.ts` (modify)

**Analog:** `failJob` / `parkJobDead` / `completeJob` (lines 190-244). Same raw-SQL shape, `rows` cast pattern:
```ts
const result = await db.execute<{ phase: JobPhase }>(sql`
  UPDATE jobs
  SET last_error = ${error}, locked_at = NULL, locked_by = NULL,
      phase = CASE WHEN attempts >= ${MAX_ATTEMPTS} THEN 'dead' ELSE 'queued' END,
      run_after = now() + (LEAST(POWER(2, attempts) * ${BASE_BACKOFF_SECONDS}, ${MAX_BACKOFF_SECONDS}) * interval '1 second'),
      updated_at = now()
  WHERE id = ${jobId}
  RETURNING phase
`);
const rows = (result as unknown as { rows: { phase: JobPhase }[] }).rows;
```
- `snoozeJob`: copy RESEARCH Pattern 2 into this file. It uses the same `(${seconds} * interval '1 second')` idiom as line 143.
- `failJob(db, id, error, delaySeconds?)`: `run_after = now() + COALESCE(${delaySeconds}, <backoff expr>) * interval '1 second'`. Optional param, so existing callers are unchanged.
- **Delete** `clearProviderOperationId` and `setProviderOperationId` (lines 276-316), and `providerOperationId` from `mapJobRow` (line 99), once 0002 drops the column.
- Never use `kind = ANY(${arr})`. Use the `sql.join` IN-list (lines 121-129) if a new query filters on kinds.

---

### `src/budget.ts` (modify, money path)

**Analog:** itself, lines 43-71 (advisory-lock txn) and 74-92 (UTC window SQL with the "double `AT TIME ZONE`" comment, which must survive).
```ts
const BUDGET_LOCK_KEY = 0x7645_7370; // "VtSp"
export async function reserveCredits(db: Db, amount: number, budget: number, worldId?: string): Promise<void> {
  await db.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(${BUDGET_LOCK_KEY})`);
    const spentToday = await creditsSpentToday(tx);
    if (wouldExceedBudget(spentToday, amount, budget)) {
      throw new BudgetExceededError(amount, spentToday, budget);
    }
    await tx.insert(creditEvents).values({ amount, worldId: worldId ?? null });
  });
}
```
Apply RESEARCH Code Example 7: object-arg signature `{ key, amount, mode, worldId, daily, monthly }`, return `'reserved' | 'already'`, `BudgetExceededError` gains a `window: 'daily'|'monthly'` field (keep `requested/budget` fields), `releaseCredits(db, key)` becomes the `INSERT … SELECT … created_at … ON CONFLICT DO NOTHING` form (Pitfall 6). **Delete** `budgetFits` and the `creditsForModel` import. Rewrite the doc comment on `releaseCredits` (lines 110-125), because its "deliberately NOT idempotent per job" rationale is reversed by D-18.

Keep the raw-row cast used at line 90: `(res as unknown as { rows: … }).rows`.

---

### `src/storage/{index,s3,local}.ts` (driver, streaming)

**Interface analog:** `src/storage/index.ts` lines 20-43. Add three members, each with a short doc comment in the existing style:
```ts
putStream(key: string, body: Readable, contentType: string): { done: Promise<void>; abort(e?: unknown): void };
getStream(key: string): Promise<Readable>;
list(prefix: string): Promise<{ key: string; size: number }[]>;
```

**S3 analog:** `src/storage/s3.ts` lines 15-25 (client setup; reuse `client` and `bucket` in the closure), lines 67-74 (`getObject` → for `getStream` return `res.Body as Readable`, or `Readable.fromWeb` if not a Node stream). Add `import { Upload } from '@aws-sdk/lib-storage'` and `ListObjectsV2Command` to the existing `@aws-sdk/client-s3` import block (lines 1-7). Upload options per RESEARCH Ex.3: `partSize: 16 * 1024 * 1024, queueSize: 4, leavePartsOnError: false`. Do **not** add `requestChecksumCalculation` unless the gated R2 test fails (Pitfall 5).

**Local analog:** `src/storage/local.ts` lines 61-65 (mkdir + write), plus `safeJoin` (lines 18-25) for every new method:
```ts
async putObject(key, bytes): Promise<void> {
  const file = resolvePath(key);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, bytes);
},
```
→ `putStream`: same mkdir, then `pipeline(body, createWriteStream(file))` from `node:stream/promises`. `abort` = `body.destroy(e)`. `list`: `fs.readdir(resolvePath(prefix), { recursive: true, withFileTypes: true })` + `stat`, returning keys with **forward slashes** (Windows dev machine: normalize `path.sep` → `/`). A missing dir returns `[]`.

`presignDownload` (s3 lines 56-59) is already generic, so the bundle URL is `storage.presignDownload(bundleKey, config.BUNDLE_URL_TTL_SECONDS)`. No new presign code.

---

### `src/db/schema.ts` + migrations (model, CRUD)

**Analog:** itself. Follow the existing style:
- Status/kind enums as `as const` arrays + derived type (lines 21-32). Replace `WORLD_STATUSES` with `['uploading','packing','submitting','processing','importing','ready','failed','cancelled']`, add `FAILURE_STAGES`, and set `JOB_KINDS = ['pack','submit','track','purge']`.
- Columns: `text('snake_name')`, `jsonb(...)`, `integer(...).notNull().default(0)`, `timestamp(..., { withTimezone: true })`, each with a *why* comment.
- Unique constraints via `uniqueIndex('<table>_<cols>_idx').on(...)` in the table callback (lines 97-102). Use this for `worlds.provider_request_id` and `credit_events (submission_key, kind)`.
- New table `webhookDeliveries = pgTable('webhook_deliveries', { deliveryId: text('delivery_id').primaryKey(), requestId: text('request_id').notNull(), event: text('event'), receivedAt: timestamp(...).notNull().defaultNow() })`, and add `export type WebhookDelivery = typeof webhookDeliveries.$inferSelect` at the bottom (lines 189-194).
- `credit_events` new columns with defaults (`kind` default `'reserve'`, `provider_mode` default `'mock'`) so 0001 applies on non-empty tables (RESEARCH Runtime State).
- `worlds.status` default changes from `'capturing'`. Pick `'uploading'`.

Migration workflow: `npm run db:generate` (= `drizzle-kit generate`, `drizzle.config.ts` `strict: true, verbose: true`), **two generates** (0001 adds, 0002 drops; Pitfall 9), apply via `node --env-file=.env --import tsx src/migrate.ts` (or build then `db:migrate:prod`) against the dev direct host. Never `db:migrate` / `push`.

---

### `src/config.ts` (config)

**Analog:** itself, lines 17-22 + 60-62:
```ts
const numberFromEnv = (def: number) => z.string().optional()
  .transform((v) => (v === undefined || v === '' ? def : Number(v)))
  .pipe(z.number().int().nonnegative());
// Daily spend cap enforced by the worker's reserveCredits guard.
DAILY_CREDIT_BUDGET: numberFromEnv(2000),
```
Add: `MONTHLY_CREDIT_BUDGET: numberFromEnv(10000)` (A4, owner to confirm), `MOCK_SCENARIO: z.enum([...]).default('happy')`, `MOCK_PROCESSING_SECONDS: numberFromEnv(5)`, `TRACK_POLL_SECONDS: numberFromEnv(60)`, `BUNDLE_URL_TTL_SECONDS: numberFromEnv(86400)`, optionally `RATE_LIMIT_WEBHOOK_MAX`. Update the `SPAITIAL_WEBHOOK_SECRET` comment at lines 54-56 ("unused today" stops being true; `SPAITIAL_API_KEY` stays unread). Optional `refine()` guard: `MONTHLY >= DAILY`, using the same `throw new Error('… refused: …')` wording as lines 141-144.

Test analog: `test/config.test.ts` lines 1-45 (the `env()` / `base` fixtures). Add cases for defaults and an invalid `MOCK_SCENARIO`.

---

### `src/routes/worlds.ts` (minimal modify, Claude's discretion)

**Analog:** itself, frames:done lines 309-370. If frames:done is kept and made to start the pipeline, change the `set({ status: 'uploaded' … })` flip to `'packing'` and add `enqueue(tx, 'pack', world.id, { captureId })` inside the same `db.transaction`, the same way DELETE does at lines 446-452. Otherwise only update the status literals so `tsc` passes. There are about 44 status-literal hits across `src/`, so grep `'uploaded'|'complete'|'capturing'|failed_upload|spz|collider_glb|thumbnailUrl` and fix `serializeWorld`.

---

### `scripts/make-tiny-session.ts`, `scripts/fixture-e2e.ts` (scripts)

**Analog:** `src/migrate.ts` lines 59-78 (`main()` + direct-run guard + non-zero exit) and `src/worker.ts` lines 294-302 (building deps from `getConfig()`):
```ts
async function main(): Promise<void> {
  const config = getConfig();
  ...
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().then(() => process.exit(0), (err: unknown) => { console.error('[migrate] FAILED:', err); process.exit(1); });
}
```
- `fixture-e2e.ts`: `getConfig()` already refuses VirtSpace buckets/DBs and `virtumetry-prod` outside production (`src/config.ts` lines 129-136). Additionally assert `config.S3_BUCKET === 'virtumetry-dev'` and `PROVIDER_MODE === 'mock'` before any write. Run it with `node --env-file=.env --import tsx scripts/fixture-e2e.ts`. The `package.json` scripts use `tsx --import dotenv/config`; follow `--env-file` per CONTEXT specifics.
- `make-tiny-session.ts`: imports `arkitToOpenCV` from `../src/bundle/convert.js` to emit `mock-outputs/cameras.json`. Uses `execFileSync('ffmpeg', …)` per RESEARCH Ex.8. Writes nothing outside `test/fixtures/` and the scratch dir.

### `scripts/test-pg.mjs`, `scripts/test-r2.mjs` (env guard wrappers)

**Analog:** isolation helpers in `src/isolation.ts` (`neonEndpointId`, `isPoolerUrl`, used at `src/config.ts` lines 2-8, 179). Since these are `.mjs` and can't import TS directly, either do a plain `new URL(u).hostname.includes('ep-mute-fog-arwonnkz') && !hostname.includes('-pooler')` check, or make them `.ts` run via `tsx` and import `src/isolation.ts`. Never print the URL; errors name the var only (`config.ts` line 101 comment: "Errors name the var, never the URL"). Spawn `npx vitest run test/integration` with `env: { ...process.env, TEST_DATABASE_URL: process.env.MIGRATE_DATABASE_URL }` and `stdio: 'inherit'`.

---

### Tests

**pg integration (`test/integration/*.pg.test.ts`)**, from `test/integration/queue.pg.test.ts` lines 39-89:
```ts
const url = process.env.TEST_DATABASE_URL;
describe.skipIf(!url)('queue against real Postgres', () => {
  const schemaName = `virtumetry_it_${randomUUID().replace(/-/g, '').slice(0, 12)}`;
  let pool: pg.Pool; let db: Db;
  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: url, max: 2 });
    pool.on('connect', (client) => {
      client.query(`SET search_path TO "${schemaName}"`)
        .catch((err: unknown) => console.error(`[queue.pg.test] SET search_path failed: ${String(err)}`));
    });
    await pool.query(`CREATE SCHEMA "${schemaName}"`);
    // ...hand-mirrored DDL...
    db = drizzle(pool, { schema }) as unknown as Db;
  });
  afterAll(async () => {
    if (pool) { await pool.query(`DROP SCHEMA IF EXISTS "${schemaName}" CASCADE`).catch(() => undefined); await pool.end(); }
  });
```
- Factor lines 42-89 into `test/helpers/pg-schema.ts` → `createTestSchema(url, { max })` returning `{ pool, db, drop }`. Replace the hand-mirrored DDL with the real migrations (RESEARCH Pattern 5): read `drizzle/meta/_journal.json` `entries[].tag` in order, read `drizzle/<tag>.sql`, `replaceAll('"public".', \`"${schemaName}".\`)`, split on `--> statement-breakpoint`. Reuse `MIGRATIONS_FOLDER` from `src/migrate.ts` for the path.
- Concurrency (budget race): `test/integration/quota.pg.test.ts` line 29 uses `max: 10` "so the concurrent charges really do overlap", then `Promise.all`. Copy that for the reservation race.
- Existing `queue.pg.test.ts` hand-DDL includes `provider_operation_id` (line 73). Switch it to the helper or drop that column when 0002 lands.

**Route tests with `inject`**, from `test/readyz.test.ts` lines 1-27:
```ts
const execute = vi.fn();
vi.mock('../src/db/client.js', () => ({ getDb: () => ({ execute }) }));
import { healthRoutes } from '../src/routes/health.js';
function app() { const a = Fastify({ logger: false }); healthRoutes(a, { storage }); return a; }
const res = await app().inject({ method: 'GET', url: '/readyz' });
```
Unit webhook tests: build `Fastify()`, `await webhookRoutes(a, { config, storage })`, inject `payload: rawBuffer` with `headers: { 'content-type': 'application/json', 'x-spaitial-signature': … }`. Without `@fastify/rate-limit` registered the `config.rateLimit` is inert, which is fine for unit tests. The dedupe/nudge assertions go to the pg variant. Body-error assertions use `expect(res.body).not.toMatch(/secret/)` (readyz line 54 style).

**Config objects in unit tests**, from `test/worker.test.ts` lines 24-27 / `test/storage.local.test.ts` lines 10-15:
```ts
const config = loadConfig({ DATABASE_URL: 'postgres://u:p@localhost:5432/db', DEV_AUTH_TOKEN: 't' } as NodeJS.ProcessEnv);
// or partial: { LOCAL_STORAGE_DIR: dir, PUBLIC_BASE_URL: 'http://localhost:8080' } as unknown as Config
```
**Temp storage dirs**, from `test/storage.local.test.ts` lines 17-23 (`fs.mkdtemp(path.join(os.tmpdir(), 'virtumetry-…'))`, `fs.rm(dir, { recursive: true, force: true })` in `afterAll`). Use this for pack tests and the pipeline test's `LOCAL_STORAGE_DIR` (`backend/data/` is not gitignored).

**Mock provider tests**, from `test/mock-provider.test.ts`: magic-byte assertions (lines 18-49) carry over to the new `mock-outputs` files (PLY header `ply\n`, PNG `\x89PNG`, JSON parse of `cameras.json`). `rejects.toMatchObject({ name: 'ProviderError' })` (line 55) is the error-assertion style.

**Pure-function tests**, from `test/budget.test.ts` lines 26-46 (`describe('wouldExceedBudget')` boundary cases). Same shape for convert/validate/exif, one `it` per D-06 rule.

**Gated S3 test**: same `describe.skipIf(!process.env.S3_BUCKET || process.env.S3_BUCKET !== 'virtumetry-dev')` gating as the pg tests.

---

## Shared Patterns

### Conditional status flip (R20/R27)
**Source:** `src/routes/worlds.ts` lines 338-350; `src/worker.ts` lines 205-222.
**Apply to:** every world status write in pack/submit/track handlers.
`tx.update(worlds).set({ status: next, progress: null, updatedAt: new Date() }).where(and(eq(worlds.id, id), eq(worlds.status, expected))).returning()` → empty means another worker moved it, so stop. Flip and `enqueue(tx, …)` share one `db.transaction` (`enqueue` accepts `Pick<Db,'insert'>`, `queue.ts` lines 56-71).

### Raw `db.execute` row access
**Source:** `src/queue.ts` lines 73-107, 152, 220; `src/budget.ts` line 90.
**Apply to:** every new raw SQL (`snoozeJob`, reservation SUM, webhook nudge, release).
`(result as unknown as { rows: T[] }).rows`. Raw rows are **snake_case**, so map explicitly (see `mapJobRow`). Coerce timestamps with `toDate` (they arrive as strings from Neon). `Number(...)` on SUMs (bigint/numeric come back as strings).

### Constant-time secret compare
**Source:** `src/auth.ts` lines 28-32 `secretEquals`.
**Apply to:** webhook route and `ReconProvider.verifyWebhook`. Never `===`.

### Non-retryable vs retryable job errors
**Source:** `src/worker.ts` lines 24-43, 135-156.
**Apply to:** pack (validate failure → fail world `validate` + `NonRetryableJobError`), submit (409 → park dead without release; budget exceeded → park; 429/503 → retry with delay), track (lease lost → abandon).

### Lease heartbeat for long jobs
**Source:** `src/queue.ts` lines 246-274 `heartbeatJob(db, jobId, workerId)` → `false` means `throw new LeaseLostError(...)` (`src/worker.ts` lines 38-43).
**Apply to:** `pack` (1,000-frame bundles take minutes; `LEASE_SECONDS = 600`) and `track`'s import loop. `track` polling uses `snoozeJob`, not heartbeats.

### Isolation guards
**Source:** `src/config.ts` lines 121-144 (`refine`), `src/isolation.ts`.
**Apply to:** scripts and gated tests. Go through `getConfig()`/`loadConfig()` so VirtSpace and `virtumetry-prod` refusals fire. Error messages name the variable, never the value.

### Module-relative paths
**Source:** `src/migrate.ts` line 37 `fileURLToPath(new URL('../drizzle', import.meta.url))`.
**Apply to:** mock `outputsDir` default, pg-schema helper, fixture paths in tests.

### Direct-run entrypoint guard
**Source:** `src/migrate.ts` lines 67-78, `src/worker.ts` lines 341-356.
**Apply to:** `scripts/*.ts`.

## No Analog Found

| File | Role | Data Flow | Reason / Source to use |
|---|---|---|---|
| `src/bundle/exif.ts` | utility | transform (binary) | No binary writers in codebase. RESEARCH Code Example 2 (verified) |
| `src/bundle/zipread.ts` | utility | Range file-I/O | No ZIP code. RESEARCH Code Example 4 (verified) |
| `src/bundle/convert.ts` body | utility | transform | No matrix math. RESEARCH Code Example 1 (verified); module shape follows pure-helper pattern |
| yazl → `putStream` streaming in `pack.ts` | service | streaming | No streaming anywhere yet (all Buffer). RESEARCH Code Example 3 + Pitfall 10 |
| `test/helpers/capture-exif.ts` | test helper | — | Vendored verbatim from `spaitial-ai/spaitial-capture-prototype` `tools/validate-bundle/src/exif.ts` (MIT-0), origin + licence header |
| `test/fixtures/tiny-session/**` + README | fixture | — | Generated by `scripts/make-tiny-session.ts` from TUM fr3 (CC BY 4.0), RESEARCH Ex.8 |
| `test/fixtures/mock-outputs/**` | fixture | — | Tiny hand-made PLY/PNG/JSON. Current inline stubs (`mock.ts` lines 20-71) are World Labs formats (GLB/gz-SPZ) and don't carry over |

## Metadata

**Analog search scope:** `backend/src/**`, `backend/test/**`, `backend/drizzle/**`, `backend/{package.json,tsconfig.json,vitest.config.ts,drizzle.config.ts}`
**Files scanned:** 58 (all of `backend/src` and `backend/test`; key files read in full: `budget.ts`, `queue.ts`, `worker.ts`, `provider/*`, `storage/*`, `db/schema.ts`, `routes/index.ts`, `config.ts`, `migrate.ts`, `queue.pg.test.ts`, `mock-provider.test.ts`, `storage.local.test.ts`)
**Pattern extraction date:** 2026-11-23
**Gotchas surfaced for the planner:**
1. `tsc` covers only `src/`, so tests and scripts are not type-checked.
2. The local `/dev-storage/*` GET has no Range support, which the mock's ZIP read needs.
3. The root-level `'*'` buffer parser exists in local mode, so the webhook scope must call `removeAllContentTypeParsers()`.
4. `queue.pg.test.ts` hand-DDL includes `provider_operation_id`.
5. `test/worker.test.ts` and `test/mock-provider.test.ts` import removed World Labs symbols.
