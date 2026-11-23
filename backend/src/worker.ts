import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { and, desc, eq, inArray, lt, sql } from 'drizzle-orm';
import { getConfig, type Config } from './config.js';
import { getDb, closeDb, type Db } from './db/client.js';
import { captures, worlds, type Job, type JobKind, type World } from './db/schema.js';
import {
  claimNextJob,
  clearProviderOperationId,
  completeJob,
  enqueue,
  failJob,
  heartbeatJob,
  parkExhaustedJobs,
  parkJobDead,
  setProviderOperationId,
} from './queue.js';
import { reserveCredits, releaseCredits, BudgetExceededError } from './budget.js';
import { createStorage, MAX_FRAME_BYTES, type StorageDriver } from './storage/index.js';
import {
  createProvider,
  ProviderError,
  ProviderTimeoutError,
  type WorldGenProvider,
  type WorldModel,
} from './provider/index.js';
import { sendPush, type SendPush } from './push.js';
import { depthKeyName, stageDepthMaps } from './depth.js';

// Stage 2 worker loop (spec §4 steps 1–6, §7 state machine, §14 credit safety).
// Entrypoint: `npm run worker`. Claims jobs of kinds [stitch, generate_draft,
// generate_hq, purge], processes each idempotently, and NEVER double-bills the
// money path — a resumed job with a persisted provider_operation_id skips
// straight to polling.

const WORKER_KINDS: JobKind[] = ['stitch', 'generate_draft', 'generate_hq', 'purge'];

const POLL_INTERVAL_MS = 5_000; // operation poll cadence.
const GENERATE_TIMEOUT_MS = 15 * 60 * 1000; // overall in-process poll ceiling.

/** Errors that must NOT be retried — the job is parked dead immediately. */
export class NonRetryableJobError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NonRetryableJobError';
  }
}

/**
 * This worker no longer holds the job's lease (spec §10 R6) — another worker
 * re-claimed it and is running it now. The losing worker must abandon the job
 * WITHOUT finalizing anything and WITHOUT touching the job row: failing or
 * parking it would clobber the new owner's lease and its result.
 */
export class LeaseLostError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LeaseLostError';
  }
}

// --- Storage key layout ------------------------------------------------------
const panoKeyFor = (worldId: string) => `worlds/${worldId}/pano.jpg`;
const panoPreviewKeyFor = (worldId: string) => `worlds/${worldId}/pano_preview.jpg`;
const assetKeyFor = (worldId: string, name: string) => `worlds/${worldId}/${name}`;
// Asset objects a world may own (used by purge).
const WORLD_ASSET_NAMES = [
  'pano.jpg',
  'pano_preview.jpg',
  'splat_100k.spz',
  'splat_500k.spz',
  'splat_full.spz',
  'thumbnail.jpg',
  'collider.glb',
];

/** Absolute path to the production Python stitcher, resolved relative to this
 * module so it works both under tsx (src/) and compiled (dist/) — the
 * `stitcher/` dir sits next to `src/` and `dist/`, and is COPYed into the
 * Docker image at the same relative location. */
function stitcherScriptPath(): string {
  return fileURLToPath(new URL('../stitcher/reproject.py', import.meta.url));
}

/** Keep only the trailing `max` chars of a (stderr) string for error messages. */
function tail(s: string, max = 800): string {
  const t = s.trim();
  return t.length > max ? `…${t.slice(-max)}` : t;
}

// =============================================================================
// Pure / injectable pieces (unit-testable without a DB or network).
// =============================================================================

export type StitchAction =
  | { type: 'passthrough' }
  | { type: 'stitch'; frameCount: number };

/**
 * Stitch decision (Phase 0.5 gate PASSED — the reprojection stitcher is live).
 * Exactly one frame is a passthrough (that single frame IS the pano — the
 * test-scan path, no real stitching or HEIC→JPEG transcode). More than one
 * frame runs the production Python reprojection stitcher (stitcher/reproject.py).
 */
export function stitchPlan(frameCount: number): StitchAction {
  if (frameCount === 1) return { type: 'passthrough' };
  return { type: 'stitch', frameCount };
}

// --- Progress plumbing (pure, unit-testable) ---------------------------------

/**
 * Parse one stdout line from reproject.py. The stitcher emits machine-readable
 * `PROGRESS <0-100>` lines between its human log lines; anything else → null.
 */
export function parseProgressLine(line: string): number | null {
  const m = /^PROGRESS\s+(\d{1,3})\s*$/.exec(line.trim());
  if (!m) return null;
  const n = Number(m[1]);
  return n >= 0 && n <= 100 ? n : null;
}

/**
 * Incremental stream parser: feed raw stdout chunks (which may split lines
 * arbitrarily); `onProgress` fires once per complete PROGRESS line.
 */
export function createProgressLineStream(
  onProgress: (progress: number) => void,
): (chunk: string) => void {
  let buffer = '';
  return (chunk: string) => {
    buffer += chunk;
    let nl: number;
    while ((nl = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, nl);
      buffer = buffer.slice(nl + 1);
      const p = parseProgressLine(line);
      if (p !== null) onProgress(p);
    }
  };
}

/**
 * Write throttle for worlds.progress: a new value is written only when it
 * moved >= `minDelta` points from the last write OR >= `minIntervalMs` elapsed
 * since it. The first value always writes. Returns a stateful predicate.
 */
export function createProgressThrottle(opts: {
  minDelta?: number;
  minIntervalMs?: number;
  now?: () => number;
} = {}): (progress: number) => boolean {
  const minDelta = opts.minDelta ?? 5;
  const minIntervalMs = opts.minIntervalMs ?? 5_000;
  const now = opts.now ?? Date.now;
  let lastValue: number | null = null;
  let lastAt = 0;
  return (progress: number) => {
    const t = now();
    if (
      lastValue !== null &&
      Math.abs(progress - lastValue) < minDelta &&
      t - lastAt < minIntervalMs
    ) {
      return false;
    }
    lastValue = progress;
    lastAt = t;
    return true;
  };
}

/**
 * Elapsed-based pseudo-progress for generation (the provider exposes no real
 * progress): linear against the expected duration, capped at 95 so the bar
 * never claims "done" before the status flips.
 */
export function pseudoProgress(elapsedMs: number, expectedMs: number): number {
  if (expectedMs <= 0) return 95;
  return Math.min(95, Math.floor((Math.max(0, elapsedMs) / expectedMs) * 100));
}

// --- Stitcher subprocess plumbing (unit-testable) ----------------------------

/**
 * Serialize captures.poses_json into the poses.json payload the Python stitcher
 * consumes (the ARKit pose array verbatim). Throws if the row has no usable
 * pose array — callers only invoke this when poses are actually present.
 */
export function serializePoses(posesJson: unknown): string {
  if (!Array.isArray(posesJson) || posesJson.length === 0) {
    throw new Error('poses_json must be a non-empty array to stitch with poses');
  }
  return JSON.stringify(posesJson);
}

/** True when a captures row carries a usable ARKit pose array. */
export function posesPresent(posesJson: unknown): boolean {
  return Array.isArray(posesJson) && posesJson.length > 0;
}

export interface StitcherArgs {
  scriptPath: string;
  framesDir: string;
  outPath: string;
  width: number;
  previewPath?: string | null;
  posesPath?: string | null;
  /** Dir of depth_<i>.png maps; only passed when at least one was staged. */
  depthDir?: string | null;
}

/**
 * Build reproject.py's argv. `--poses` is included ONLY when a poses path is
 * given (poses-driven reprojection); omitting it selects the nominal fallback.
 */
export function buildStitcherArgs(a: StitcherArgs): string[] {
  const args = [
    a.scriptPath,
    '--frames-dir', a.framesDir,
    '--out', a.outPath,
    '--width', String(a.width),
  ];
  if (a.posesPath) args.push('--poses', a.posesPath);
  if (a.previewPath) args.push('--preview-out', a.previewPath);
  if (a.depthDir) args.push('--depth-dir', a.depthDir);
  return args;
}

export interface StitcherRun {
  code: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  /** POSIX signal that reaped the child, when it exited via one. */
  signal?: NodeJS.Signals | null;
}

// --- Stitcher failure classification (spec §10 R8) ---------------------------

/**
 * `reproject.py` EXIT_INPUT_ERROR: the capture payload itself is unusable
 * (undecodable/genuinely-HEIC frames, no usable frames, bad arguments). Keep in
 * sync with stitcher/reproject.py.
 */
export const STITCHER_EXIT_INPUT_ERROR = 2;

/**
 * 128 + SIGKILL(9). The kernel OOM-killer reaps the child with SIGKILL and no
 * exit code, which `stitcherExitCode` normalises to this POSIX shell convention.
 */
export const STITCHER_EXIT_OOM_KILLED = 137;

/**
 * Attempts after which a repeated OOM-kill or timeout stops being worth
 * retrying. Resource failures on a FIXED payload are deterministic: the same
 * frames at the same width will exhaust the same memory. One retry covers the
 * genuinely transient case (a co-tenant spike on the box); a second identical
 * failure is the payload telling us it does not fit.
 */
export const STITCH_RESOURCE_MAX_ATTEMPTS = 2;

/**
 * Normalise a child exit into a single number. Node reports `code: null` when a
 * signal reaped the process, which would otherwise erase the OOM-killer's
 * fingerprint — so a signal becomes 128 + signum (SIGKILL -> 137), matching the
 * shell convention the rest of the stack already speaks.
 */
export function stitcherExitCode(
  code: number | null,
  signal: NodeJS.Signals | null,
): number {
  if (code !== null) return code;
  if (signal) {
    const num = (os.constants.signals as Record<string, number>)[signal];
    if (typeof num === 'number') return 128 + num;
  }
  return -1;
}

/**
 * Turn a non-zero stitcher exit into the right error TYPE for the retry policy.
 * Classification is by exit CODE, never by matching message text — the message
 * is a human artifact that changes; the code is a contract.
 */
export function classifyStitcherFailure(
  code: number,
  attempts: number,
  detail: string,
): Error {
  const base = `stitcher exited ${code}: ${detail}`;
  if (code === STITCHER_EXIT_INPUT_ERROR) {
    // The frames are bad. Every retry decodes the same bytes and fails the same
    // way, so retrying only burns attempts and delays the user's error.
    return new NonRetryableJobError(`${base} (unusable capture input; not retryable)`);
  }
  if (code === STITCHER_EXIT_OOM_KILLED && attempts >= STITCH_RESOURCE_MAX_ATTEMPTS) {
    return new NonRetryableJobError(
      `${base} (OOM-killed on attempt ${attempts} of ` +
        `${STITCH_RESOURCE_MAX_ATTEMPTS}; not retryable)`,
    );
  }
  return new Error(base);
}

/** Same policy for a stitch that blew the wall-clock ceiling. */
export function classifyStitcherTimeout(timeoutMs: number, attempts: number): Error {
  const base = `stitcher timed out after ${timeoutMs}ms`;
  if (attempts >= STITCH_RESOURCE_MAX_ATTEMPTS) {
    return new NonRetryableJobError(
      `${base} on attempt ${attempts} of ${STITCH_RESOURCE_MAX_ATTEMPTS}; not retryable`,
    );
  }
  return new Error(base);
}

/** Injectable stitcher runner (real impl spawns Python; tests mock it).
 * `onStdout` (optional) receives raw stdout chunks as they stream — used for
 * incremental PROGRESS-line parsing while the child is still running. */
export type StitcherSpawner = (
  bin: string,
  args: string[],
  timeoutMs: number,
  onStdout?: (chunk: string) => void,
) => Promise<StitcherRun>;

/** Real spawner: runs `bin args`, capturing stdout/stderr, SIGKILL on timeout. */
export const realStitcherSpawner: StitcherSpawner = (bin, args, timeoutMs, onStdout) =>
  new Promise<StitcherRun>((resolve, reject) => {
    const child = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, timeoutMs);
    child.stdout.on('data', (d) => {
      const s = d.toString();
      stdout += s;
      onStdout?.(s);
    });
    child.stderr.on('data', (d) => {
      stderr += d.toString();
    });
    child.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      resolve({ code: stitcherExitCode(code, signal), stdout, stderr, timedOut, signal });
    });
  });

export interface GenerationClock {
  now(): number;
  sleep(ms: number): Promise<void>;
}

const realClock: GenerationClock = {
  now: () => Date.now(),
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
};

// --- Credit-safety identifiers (pure, spec §10 R1 / §14) ---------------------

const PENDING_MARKER_PREFIX = 'pending:';

/**
 * The intent marker persisted into jobs.provider_operation_id *before* the
 * credit-spending `worlds:generate` call. Its presence on resume means "a
 * generate may or may not have gone out for this job" — the worker must
 * reconcile against the provider, never re-generate.
 */
export function pendingOperationMarker(jobId: string): string {
  return `${PENDING_MARKER_PREFIX}${jobId}`;
}

/** True when a persisted provider_operation_id is an intent marker, not an id. */
export function isPendingOperationMarker(value: string | null | undefined): boolean {
  return typeof value === 'string' && value.startsWith(PENDING_MARKER_PREFIX);
}

/**
 * Provider-side `display_name` for a generation: deterministic per job and
 * unique across jobs, because it is the ONLY key reconciliation has to decide
 * whether a job's generate call already spent credits. Derived from the job id
 * alone (a UUID: unique + traceable) and kept short because World Labs caps
 * display_name at 64 chars (`MAX_DISPLAY_NAME`; a longer name is a 422).
 * Deliberately NOT from the user's title, which can change between attempts and
 * would make the same job unrecoverable (and would ship user text to the
 * provider for no benefit).
 */
export function generationDisplayName(jobId: string): string {
  return `VirtSpace ${jobId}`;
}

export interface GenerationInput {
  /** Job id — embedded in the intent marker and the provider display name. */
  jobId: string;
  model: WorldModel;
  displayName: string;
  cost: number;
  /**
   * Persisted provider_operation_id. A real id means RESUME at polling; a
   * `pending:<jobId>` marker means RECONCILE; null means a fresh generation.
   */
  existingOperationId: string | null;
}

/** Side-effect surface runGeneration needs — real impl hits db + storage. */
export interface GenerationIO {
  reserveCredits(amount: number): Promise<void>;
  /**
   * Give back a reservation that provably bought nothing — only used when a step
   * strictly BEFORE `worlds:generate` failed (spec §10 R1).
   */
  releaseCredits(amount: number): Promise<void>;
  getPanoBytes(): Promise<Buffer>;
  saveOperationId(operationId: string): Promise<void>;
  /**
   * Clear this job's `pending:<jobId>` marker after a pre-generate failure, so
   * the retry starts clean instead of reconciling. Must be conditional on the
   * marker still being ours.
   */
  clearPendingMarker(): Promise<void>;
  /** Persist asset bytes; returns the storage key. */
  storeAsset(name: string, bytes: Buffer): Promise<string>;
}

export interface GenerationResult {
  worldId: string;
  caption?: string;
  assetKeys: {
    spz100kUrl?: string;
    spz500kUrl?: string;
    /** null (not omitted) when absent or failed, so an HQ pass clears the draft's. */
    spzFullUrl?: string | null;
    thumbnailUrl?: string;
    colliderGlbUrl?: string;
  };
}

/**
 * Credit-safe generation sequence (spec §14, hardened per §10 R1).
 *
 * `worlds:generate` is the only money-touching step and it runs **at most once
 * per job**. Three entry states, decided by the persisted operation id:
 *
 * 1. **real operation id** → resume at polling. No reserve, no generate.
 * 2. **`pending:<jobId>` marker** → a previous attempt was inside the generate
 *    window when it died. RECONCILE against the provider by the job's unique
 *    display name: adopt the operation/world if one exists, otherwise park the
 *    job dead. A re-generate here is never allowed — it is exactly the
 *    double-bill this ledger item exists to close.
 * 3. **null** → fresh generation: persist the marker, reserve, upload, generate,
 *    persist the real id. The marker lands FIRST (before the reservation) so no
 *    *process death* anywhere in the window can produce a second reserve or a
 *    second generate.
 *
 * A failure of the generate call itself is NON-retryable (`NonRetryableJobError`):
 * the call may have been received by the provider, so a retry could bill twice.
 * Poll-phase failures stay retryable — they resume by operation id.
 *
 * A THROWN failure from a step strictly before generate (reserve, pano read,
 * pano upload — the last is an ordinary network call and the likeliest failure
 * in the path) proves no generation was submitted. Those unwind: the reservation
 * is released and the marker cleared, and the original error is rethrown with its
 * original retryability, so a transient blip retries normally instead of parking
 * the job for an operator. Only a process death inside the window, or a throw
 * from generateWorld itself, may leave the marker behind. If the unwind itself
 * fails, the marker stays (fail safe toward parking, never toward re-billing).
 */
export async function runGeneration(
  provider: WorldGenProvider,
  io: GenerationIO,
  input: GenerationInput,
  clock: GenerationClock = realClock,
  opts: {
    pollIntervalMs?: number;
    timeoutMs?: number;
    /** Fires after each poll with elapsed ms since polling began (progress UI). */
    onPoll?: (elapsedMs: number) => void | Promise<void>;
  } = {},
): Promise<GenerationResult> {
  const pollIntervalMs = opts.pollIntervalMs ?? POLL_INTERVAL_MS;
  const timeoutMs = opts.timeoutMs ?? GENERATE_TIMEOUT_MS;

  let operationId = input.existingOperationId;

  if (isPendingOperationMarker(operationId)) {
    // (2) Reconcile: did the previous attempt's generate actually go through?
    // A lookup failure propagates as-is (retryable) — we simply do not know yet,
    // and guessing costs real money.
    const match = await provider.findWorldByDisplayName(input.displayName);
    if (!match) {
      // Nothing matched. A listing can lag a just-accepted generation, so this
      // does NOT prove no credits were spent — and an unprovable state must
      // never be resolved by re-submitting. Park the job for a human.
      throw new NonRetryableJobError(
        `generation state unresolved for job ${input.jobId}: a worlds:generate may have ` +
          `been submitted as "${input.displayName}" but no matching world is listed. ` +
          'Refusing to re-generate (would risk a double bill) — inspect the provider account.',
      );
    }
    if (match.operationId) {
      // Adopt the operation and replace the marker so the next resume skips
      // reconciliation entirely.
      operationId = match.operationId;
      await io.saveOperationId(operationId);
    } else if (match.done === false) {
      // Exists but still running and no operation to poll → come back later.
      // Retryable: reconciliation is free and re-runs safely.
      throw new ProviderError(
        `world ${match.worldId} for job ${input.jobId} is still generating; ` +
          'will reconcile again on the next attempt',
      );
    } else {
      // Finished world, no operation id exposed → adopt it directly.
      return collectAssets(provider, io, match.worldId);
    }
  } else if (!operationId) {
    // (3) Fresh generation. Order is load-bearing: the intent marker is durable
    // BEFORE anything else, so every later crash point resumes into (2) instead
    // of reserving credits or calling generate a second time.
    await io.saveOperationId(pendingOperationMarker(input.jobId));

    // Steps before the money call. A THROW here proves nothing was submitted, so
    // it unwinds the marker (and any reservation) and keeps its own
    // retryability — a 5xx from the pano upload must not park the job.
    let mediaAssetId: string;
    let reserved = false;
    try {
      await io.reserveCredits(input.cost);
      reserved = true;
      const panoBytes = await io.getPanoBytes();
      mediaAssetId = await provider.uploadPano(panoBytes, 'pano.jpg');
    } catch (err) {
      await unwindPendingGeneration(io, input, reserved);
      throw err; // original error, original retryability (budget still parks).
    }

    try {
      operationId = await provider.generateWorld(mediaAssetId, input.model, input.displayName);
    } catch (err) {
      // The provider may have accepted the call before the failure/timeout, so a
      // retry could bill twice. Park dead; the marker stays behind so a manual
      // re-queue reconciles instead of re-generating.
      const message = err instanceof Error ? err.message : String(err);
      throw new NonRetryableJobError(
        `worlds:generate failed for job ${input.jobId} and must NOT be retried ` +
          `(it may have been billed): ${message}`,
      );
    }
    await io.saveOperationId(operationId);
  }

  // Invariant: every branch above either set a real operation id, returned, or
  // threw. Belt-and-braces so the poll below can never be handed a marker/null.
  if (!operationId || isPendingOperationMarker(operationId)) {
    throw new NonRetryableJobError(
      `internal: job ${input.jobId} reached polling without a provider operation id`,
    );
  }

  // (f) Poll until done — in-process loop; the job lease outlives this via
  // re-claim + operation_id resume (see queue.ts LEASE_SECONDS).
  const startedAt = clock.now();
  const deadline = startedAt + timeoutMs;
  let status = await provider.getOperation(operationId);
  while (!status.done) {
    if (clock.now() >= deadline) {
      throw new ProviderTimeoutError(
        `operation ${operationId} did not finish within ${timeoutMs}ms`,
      );
    }
    await clock.sleep(pollIntervalMs);
    status = await provider.getOperation(operationId);
    // Progress tick — best-effort UI plumbing; never fail the money path on it.
    // The ONE exception is a lost lease (§10 R6): that means another worker owns
    // this job, so this worker must stop immediately rather than keep polling.
    try {
      await opts.onPoll?.(clock.now() - startedAt);
    } catch (err) {
      if (err instanceof LeaseLostError) throw err;
      // ignore: progress reporting must not affect generation.
    }
  }
  if (status.error) throw new ProviderError(`operation failed: ${status.error}`);
  if (!status.worldId) throw new ProviderError('operation done but returned no world_id');

  return collectAssets(provider, io, status.worldId);
}

/**
 * Undo the pre-generate half of a fresh generation (spec §10 R1) after a step
 * before `worlds:generate` threw: release the reservation (if one was taken) and
 * clear the intent marker, so the retry starts clean rather than reconciling and
 * parking.
 *
 * Both steps are best-effort and never mask the original failure. If clearing
 * the marker fails the marker STAYS — the next attempt then reconciles and, at
 * worst, parks the job for an operator. That is the safe direction: the only
 * thing this code must never do is make a second generate look allowed.
 */
async function unwindPendingGeneration(
  io: GenerationIO,
  input: GenerationInput,
  reserved: boolean,
): Promise<void> {
  if (reserved) {
    try {
      await io.releaseCredits(input.cost);
    } catch (err) {
      // Over-counting today's budget is harmless (it spends less, never more).
      console.error(
        `[worker] job ${input.jobId}: failed to release an unused reservation: ${String(err)}`,
      );
    }
  }
  try {
    await io.clearPendingMarker();
  } catch (err) {
    console.error(
      `[worker] job ${input.jobId}: failed to clear the pending marker after a ` +
        `pre-generate failure; the retry will reconcile instead: ${String(err)}`,
    );
  }
}

/**
 * (g) Fetch + re-host every asset of a finished provider world onto OUR storage
 * (spec §14 asset ownership). Shared by the normal poll path and the §10 R1
 * reconciliation path, which adopts an already-finished world.
 */
async function collectAssets(
  provider: WorldGenProvider,
  io: GenerationIO,
  worldId: string,
): Promise<GenerationResult> {
  const assets = await provider.getWorld(worldId);
  const assetKeys: GenerationResult['assetKeys'] = {};
  if (assets.spzUrls.k500) {
    assetKeys.spz500kUrl = await io.storeAsset(
      'splat_500k.spz',
      await provider.downloadAsset(assets.spzUrls.k500),
    );
  }
  // full_res is best-effort: 500k is the required tier, so a failed full_res
  // download degrades capable devices to 500k instead of failing a paid job.
  // Always written (null on failure) — an HQ pass must not leave the draft's
  // full_res key behind under the bumped asset_version.
  assetKeys.spzFullUrl = null;
  if (assets.spzUrls.full) {
    try {
      assetKeys.spzFullUrl = await io.storeAsset(
        'splat_full.spz',
        await provider.downloadAsset(assets.spzUrls.full),
      );
    } catch (err) {
      console.warn(`[worker] world ${worldId}: full_res splat not stored: ${String(err)}`);
    }
  }
  if (assets.spzUrls.k100) {
    assetKeys.spz100kUrl = await io.storeAsset(
      'splat_100k.spz',
      await provider.downloadAsset(assets.spzUrls.k100),
    );
  }
  if (assets.thumbnailUrl) {
    assetKeys.thumbnailUrl = await io.storeAsset(
      'thumbnail.jpg',
      await provider.downloadAsset(assets.thumbnailUrl),
    );
  }
  if (assets.colliderMeshUrl) {
    assetKeys.colliderGlbUrl = await io.storeAsset(
      'collider.glb',
      await provider.downloadAsset(assets.colliderMeshUrl),
    );
  }

  const result: GenerationResult = { worldId, assetKeys };
  if (assets.caption) result.caption = assets.caption;
  return result;
}

// =============================================================================
// DB-bound job handlers.
// =============================================================================

export interface WorkerDeps {
  db: Db;
  storage: StorageDriver;
  provider: WorldGenProvider;
  config: Config;
  push: SendPush;
  clock?: GenerationClock;
  /** Injectable stitcher runner — defaults to spawning real Python. */
  stitcher?: StitcherSpawner;
  /**
   * Identity of the worker processing the job (`hostname:pid`). Set by
   * startWorker; used to prove lease ownership on every heartbeat (§10 R6).
   */
  workerId?: string;
}

/**
 * Lease keep-alive for a long-running phase (spec §10 R6). Returns false only
 * when the conditional UPDATE proved this worker lost the job. A *failed*
 * heartbeat (DB blip) returns true: a transient error is not evidence that
 * someone else owns the job, and killing a live generation over it would be
 * worse than the race it guards against.
 */
async function stillHoldsLease(deps: WorkerDeps, jobId: string): Promise<boolean> {
  try {
    return await heartbeatJob(deps.db, jobId, deps.workerId);
  } catch (err) {
    console.warn(`[worker] heartbeat failed for job ${jobId} (assuming held): ${String(err)}`);
    return true;
  }
}

/**
 * Mandatory server-side frame size guard (spec §10 R7). Presigning can only bind
 * a size when the client declared one, and a bucket policy may or may not exist,
 * so the worker ALWAYS HEADs a frame before reading it: an oversized object
 * would otherwise be pulled into worker memory in full (frames are read into RAM
 * and an 8192-wide stitch already peaks >1.5 GB, §10 R8). Oversize is
 * non-retryable — the object will not shrink on a retry.
 */
async function readFrameWithinCap(storage: StorageDriver, key: string): Promise<Buffer> {
  let size: number;
  try {
    size = await storage.objectSize(key);
  } catch (err) {
    // Missing/unreadable frame: the capture is unusable, and retrying a HEAD
    // that failed because the object isn't there cannot help.
    throw new NonRetryableJobError(
      `frame ${key} could not be sized (missing or unreadable): ${String(err)}`,
    );
  }
  if (size > MAX_FRAME_BYTES) {
    throw new NonRetryableJobError(
      `frame ${key} is ${size} bytes, over the ${MAX_FRAME_BYTES}-byte cap; refusing to read it`,
    );
  }
  return storage.getObject(key);
}

async function loadWorld(db: Db, worldId: string): Promise<World> {
  const [world] = await db.select().from(worlds).where(eq(worlds.id, worldId)).limit(1);
  if (!world) throw new NonRetryableJobError(`world not found: ${worldId}`);
  return world;
}

/**
 * Throttled, best-effort worlds.progress writer (>=5 point delta or >=5 s
 * between writes). Also touches updated_at — the client-facing heartbeat.
 */
function makeProgressWriter(
  db: Db,
  worldId: string,
  clock: GenerationClock,
): (progress: number) => Promise<void> {
  const shouldWrite = createProgressThrottle({ now: () => clock.now() });
  return async (progress: number) => {
    if (!shouldWrite(progress)) return;
    try {
      await db
        .update(worlds)
        .set({ progress, updatedAt: sql`now()` })
        .where(eq(worlds.id, worldId));
    } catch {
      // Best-effort: a failed progress write must never fail the job.
    }
  };
}

/** Update the world row + enqueue draft generation after a pano lands.
 * progress resets to NULL on the status transition (new phase, new bar).
 *
 * IDEMPOTENT (spec §10 R6): the transition is conditional on the world still
 * being pre-generation. Two stitch runs for one world (lease expiry + re-claim)
 * would otherwise enqueue two `generate_draft` jobs — i.e. two billable
 * generations — so the loser of the race enqueues nothing.
 *
 * The flip and the enqueue share ONE transaction (spec §10 R27): a crash between
 * them used to leave a world in generating_draft with no job, permanently — no
 * other path ever enqueues a draft for a world already past stitching. */
async function finalizeStitch(db: Db, worldId: string, panoKey: string): Promise<void> {
  await db.transaction(async (tx) => {
    const advanced = await tx
      .update(worlds)
      .set({
        panoUrl: panoKey,
        status: 'generating_draft',
        phase: null,
        progress: null,
        updatedAt: sql`now()`,
      })
      .where(
        and(
          eq(worlds.id, worldId),
          inArray(worlds.status, ['uploading', 'stitching', 'failed_stitch']),
        ),
      )
      .returning({ id: worlds.id });
    if (advanced.length === 0) {
      console.log(
        `[worker] world ${worldId} already past stitching; not enqueuing a second generate_draft`,
      );
      return;
    }
    await enqueue(tx, 'generate_draft', worldId);
  });
}

/**
 * stitch (Phase 0.5 — production reprojection stitcher).
 *
 * frame_count == 1 → PASSTHROUGH (the test-scan path): the lone frame IS the
 * pano, copied verbatim to pano.jpg. v0 caveat: no HEIC→JPEG transcode, so this
 * assumes the single frame is already an equirect-usable image.
 *
 * frame_count > 1 → real stitch: download every frame to a temp dir, write
 * poses.json when captures.poses_json is present, then spawn
 * stitcher/reproject.py (5-min timeout). On success upload pano.jpg (+ optional
 * pano_preview.jpg) and advance to generating_draft. Temp dir is always cleaned
 * in finally.
 *
 * Failure handling is driven by the stitcher's EXIT CODE (spec §10 R8): an
 * input error (exit 2) parks the job dead at once, a repeated OOM-kill (137) or
 * timeout parks it after STITCH_RESOURCE_MAX_ATTEMPTS, and anything else stays
 * retryable because transient disk/memory pressure is real.
 *
 * NOTE (client contract, not a bug): the capture app uploads JPEG bytes under
 * `frame_<i>.heic` keys with an `image/heic` content-type, so frames are staged
 * as frame_<i>.jpg from the stored bytes and the extension means nothing. The
 * stitcher sniffs the real container by magic bytes and fails with the
 * input-error code — naming the format — if a frame is genuinely HEIF.
 */
export async function handleStitch(deps: WorkerDeps, job: Job): Promise<void> {
  const { db, storage, config } = deps;
  const world = await loadWorld(db, job.worldId);

  const [capture] = await db
    .select()
    .from(captures)
    .where(eq(captures.worldId, job.worldId))
    .orderBy(desc(captures.createdAt))
    .limit(1);
  if (!capture) throw new NonRetryableJobError(`no capture row for world ${job.worldId}`);

  const framePrefix = capture.r2FramesPrefix ?? `captures/${capture.id}`;
  const panoKey = panoKeyFor(world.id);
  const plan = stitchPlan(capture.frameCount);

  if (plan.type === 'passthrough') {
    // Passthrough: the lone frame IS the pano. NOTE v0 limitation — no transcode.
    const frameBytes = await readFrameWithinCap(storage, `${framePrefix}/frame_0.heic`);
    await storage.putObject(panoKey, frameBytes);
    await finalizeStitch(db, world.id, panoKey);
    await completeJob(db, job.id);
    return;
  }

  // Multi-frame reprojection stitch.
  const spawner = deps.stitcher ?? realStitcherSpawner;
  const workDir = await mkdtemp(path.join(os.tmpdir(), `virtspace-stitch-${world.id}-`));
  try {
    const framesDir = path.join(workDir, 'frames');
    await mkdir(framesDir, { recursive: true });
    for (let i = 0; i < capture.frameCount; i++) {
      const bytes = await readFrameWithinCap(storage, `${framePrefix}/frame_${i}.heic`);
      await writeFile(path.join(framesDir, `frame_${i}.jpg`), bytes);
    }

    let posesPath: string | null = null;
    if (posesPresent(capture.posesJson)) {
      posesPath = path.join(workDir, 'poses.json');
      await writeFile(posesPath, serializePoses(capture.posesJson));
    }

    // Optional LiDAR depth (spec §5.2 item 4). Best-effort by contract: depth
    // problems degrade that frame to depth-less, they never fail the job.
    const depthDir = path.join(workDir, 'depth');
    await mkdir(depthDir, { recursive: true });
    const depthStaged = await stageDepthMaps({
      storage,
      prefix: framePrefix,
      posesJson: capture.posesJson,
      frameCount: capture.frameCount,
      depthDir,
    });

    const outPath = path.join(workDir, 'pano.jpg');
    const previewPath = path.join(workDir, 'pano_preview.jpg');
    const args = buildStitcherArgs({
      scriptPath: stitcherScriptPath(),
      framesDir,
      outPath,
      width: config.STITCHER_WIDTH,
      previewPath,
      posesPath,
      depthDir: depthStaged > 0 ? depthDir : null,
    });

    // Stream the child's stdout for PROGRESS lines and mirror them (throttled)
    // into worlds.progress while the stitch runs. The same tick refreshes the
    // job lease (§10 R6) — an 8192-wide stitch can outlive LEASE_SECONDS.
    const writeProgress = makeProgressWriter(db, world.id, deps.clock ?? realClock);
    let leaseLost = false;
    const pendingTicks: Promise<void>[] = [];
    const onStdout = createProgressLineStream((p) => {
      pendingTicks.push(
        (async () => {
          await writeProgress(p);
          if (!(await stillHoldsLease(deps, job.id))) leaseLost = true;
        })(),
      );
    });

    const run = await spawner(config.PYTHON_BIN, args, config.STITCHER_TIMEOUT_MS, onStdout);
    await Promise.all(pendingTicks);
    if (leaseLost) {
      // Checked BEFORE publishing the pano or advancing the world: the worker
      // that re-claimed this job owns the outcome now.
      throw new LeaseLostError(
        `job ${job.id} lost its lease while stitching world ${world.id}; ` +
          'abandoning without finalizing',
      );
    }
    // Retryability comes from the exit CODE (spec §10 R8): bad input is parked
    // immediately, a repeated OOM-kill/timeout is parked after the second
    // attempt, everything else keeps the normal backoff.
    if (run.timedOut) {
      throw classifyStitcherTimeout(config.STITCHER_TIMEOUT_MS, job.attempts);
    }
    if (run.code !== 0) {
      throw classifyStitcherFailure(run.code, job.attempts, tail(run.stderr));
    }

    const panoBytes = await readFile(outPath);
    await storage.putObject(panoKey, panoBytes);

    // Optional preview (2000x1000) — best-effort, not referenced by any DB
    // column (thumbnail comes from Marble later). Purge cleans it via
    // WORLD_ASSET_NAMES.
    try {
      const previewBytes = await readFile(previewPath);
      await storage.putObject(panoPreviewKeyFor(world.id), previewBytes);
    } catch {
      // preview is optional; ignore if the stitcher didn't emit one.
    }

    await finalizeStitch(db, world.id, panoKey);
    await completeJob(db, job.id);
  } finally {
    await rm(workDir, { recursive: true, force: true }).catch(() => undefined);
  }
}

async function handleGenerate(
  deps: WorkerDeps,
  job: Job,
  model: WorldModel,
): Promise<void> {
  const { db, storage, provider, config, push } = deps;
  const clock = deps.clock ?? realClock;
  const world = await loadWorld(db, job.worldId);
  if (!world.panoUrl) {
    throw new NonRetryableJobError(`world ${world.id} has no pano to generate from`);
  }

  const isDraft = model === 'marble-1.0-draft';
  const cost = provider.creditsForModel(model);
  const panoKey = world.panoUrl;

  const io: GenerationIO = {
    reserveCredits: (amount) =>
      reserveCredits(db, amount, config.DAILY_CREDIT_BUDGET, world.id),
    releaseCredits: (amount) => releaseCredits(db, amount, world.id),
    getPanoBytes: () => storage.getObject(panoKey),
    saveOperationId: (opId) => setProviderOperationId(db, job.id, opId),
    clearPendingMarker: async () => {
      await clearProviderOperationId(db, job.id, pendingOperationMarker(job.id));
    },
    storeAsset: async (name, bytes) => {
      const key = assetKeyFor(world.id, name);
      await storage.putObject(key, bytes);
      return key;
    },
  };

  // The provider exposes no real progress, so publish elapsed-based
  // pseudo-progress on each poll tick (throttled; capped at 95).
  const expectedMs = isDraft
    ? config.GENERATE_EXPECTED_DRAFT_MS
    : config.GENERATE_EXPECTED_HQ_MS;
  const writeProgress = makeProgressWriter(db, world.id, clock);

  const result = await runGeneration(
    provider,
    io,
    {
      jobId: job.id,
      model,
      // Deterministic + unique per job — it is the reconciliation key (§10 R1),
      // not a user-facing label, so the world's title is deliberately not used.
      displayName: generationDisplayName(job.id),
      cost,
      existingOperationId: job.providerOperationId,
    },
    clock,
    {
      onPoll: async (elapsedMs) => {
        await writeProgress(pseudoProgress(elapsedMs, expectedMs));
        // Keep the lease alive across a generation that outlives it (§10 R6);
        // if it is already gone, abort here rather than finalize a job someone
        // else owns.
        if (!(await stillHoldsLease(deps, job.id))) {
          throw new LeaseLostError(
            `job ${job.id} lost its lease while generating world ${world.id}; ` +
              'abandoning without finalizing',
          );
        }
      },
    },
  );

  // Finalize the world row: asset keys, provider world id, credits, status.
  //
  // IDEMPOTENT (spec §10 R6): the UPDATE is conditional on this generation's
  // provider world id not already being recorded, so replaying the same job
  // (lease expiry, re-claim, manual re-queue) cannot bump credits_spent twice or
  // fire a second push. A *different* generation for the same world (a genuine
  // re-run, or the HQ pass) has a different provider world id and still applies.
  const providerWorldColumn = isDraft ? worlds.draftWorldId : worlds.hqWorldId;
  const finalized = await db
    .update(worlds)
    .set({
      status: isDraft ? 'draft_ready' : 'complete',
      phase: null,
      progress: null, // status flip → the within-phase bar is over.
      updatedAt: sql`now()`,
      provider: provider.mode === 'mock' ? 'mock' : 'worldlabs',
      creditsSpent: sql`${worlds.creditsSpent} + ${cost}`,
      // The HQ pass OVERWRITES the draft's asset objects — assetKeyFor is not
      // version-scoped, so `worlds/<id>/splat_500k.spz` now holds marble-1.1
      // bytes at the same key and the same signed URL shape. asset_version is
      // the client's cache key for exactly this (iOS passes it to SplatCache),
      // and nothing incremented it, so a finished enhance left every client
      // serving its cached DRAFT splat forever — the enhance was invisible.
      // Bumped only on the HQ pass: the draft IS version 1.
      ...(isDraft ? {} : { assetVersion: sql`${worlds.assetVersion} + 1` }),
      ...result.assetKeys,
      ...(result.caption ? { caption: result.caption } : {}),
      ...(isDraft
        ? { draftWorldId: result.worldId, draftModel: model }
        : { hqWorldId: result.worldId, hqModel: model }),
    })
    .where(
      and(
        eq(worlds.id, world.id),
        sql`${providerWorldColumn} IS DISTINCT FROM ${result.worldId}`,
      ),
    )
    .returning({ id: worlds.id });
  await completeJob(db, job.id);

  if (finalized.length === 0) {
    // Already finalized for this exact provider world — credits and the push
    // have been applied once and must not repeat. The job is still completed.
    console.log(
      `[worker] job ${job.id}: world ${world.id} already finalized for provider ` +
        `world ${result.worldId}; skipping credits + push`,
    );
    return;
  }

  // APNs push on draft_ready / complete (spec §4 "world ready").
  await push(
    world.ownerId,
    isDraft ? 'Your draft world is ready' : 'Your world is complete',
    isDraft
      ? 'Tap to explore your new 3D world.'
      : 'Your high-quality world finished generating.',
  );
}

/**
 * purge — delete storage objects under the world + its captures' frame
 * prefixes. The DB row is KEPT (soft-deleted) so history/analytics survive.
 * A `{ framesOnly: true }` payload (reaper) skips the world-asset keys — a
 * reaped uploading world never produced any, and its row is NOT soft-deleted.
 */
async function handlePurge(deps: WorkerDeps, job: Job): Promise<void> {
  const { db, storage } = deps;
  const worldId = job.worldId;
  const framesOnly =
    typeof job.payload === 'object' &&
    job.payload !== null &&
    (job.payload as { framesOnly?: boolean }).framesOnly === true;

  if (!framesOnly) {
    for (const name of WORLD_ASSET_NAMES) {
      await storage.deleteObject(assetKeyFor(worldId, name)).catch(() => undefined);
    }
  }

  const caps = await db.select().from(captures).where(eq(captures.worldId, worldId));
  for (const cap of caps) {
    const prefix = cap.r2FramesPrefix ?? `captures/${cap.id}`;
    for (let i = 0; i < cap.frameCount; i++) {
      await storage.deleteObject(`${prefix}/frame_${i}.heic`).catch(() => undefined);
      // Depth maps (spec §5.2) are per-key, not prefix-deleted, so name them
      // explicitly. Deleting an absent key is a no-op on both drivers.
      await storage.deleteObject(`${prefix}/${depthKeyName(i)}`).catch(() => undefined);
    }
  }

  // Purge the per-frame ARKit poses too (spec §13 data minimization / §10 R3).
  // poses_json is personal motion data whose only consumer is the stitcher; once
  // the frames it describes are gone it is dead weight that survived deletion.
  // Applies to the frames-only (reaper) path as well — same frames, same poses.
  if (caps.length > 0) {
    await db
      .update(captures)
      .set({ posesJson: null })
      .where(eq(captures.worldId, worldId));
  }

  await completeJob(db, job.id);
}

export async function processJob(deps: WorkerDeps, job: Job): Promise<void> {
  switch (job.kind as JobKind) {
    case 'stitch':
      return handleStitch(deps, job);
    case 'generate_draft':
      return handleGenerate(deps, job, 'marble-1.0-draft');
    case 'generate_hq':
      return handleGenerate(deps, job, 'marble-1.1');
    case 'purge':
      return handlePurge(deps, job);
    default:
      throw new NonRetryableJobError(`unknown job kind: ${job.kind}`);
  }
}

/** Map a job kind to its failed_<phase> world status (spec §7), or null. */
function failedStatusFor(kind: string): string | null {
  switch (kind) {
    case 'stitch':
      return 'failed_stitch';
    case 'generate_draft':
      return 'failed_generating_draft';
    case 'generate_hq':
      return 'failed_generating_hq';
    default:
      return null;
  }
}

export async function handleJobError(db: Db, job: Job, err: unknown): Promise<void> {
  const message = err instanceof Error ? err.message : String(err);

  // Lost lease (§10 R6): another worker owns this job now. Touching the row —
  // failJob would clear locked_at/locked_by, parkJobDead would kill it outright
  // — would sabotage the owner mid-run. Log and walk away.
  if (err instanceof LeaseLostError) {
    console.warn(`[worker] job ${job.id} (${job.kind}) abandoned: ${message}`);
    return;
  }

  const nonRetryable =
    err instanceof BudgetExceededError || err instanceof NonRetryableJobError;

  if (nonRetryable) {
    console.error(`[worker] job ${job.id} (${job.kind}) parked DEAD: ${message}`);
    await parkJobDead(db, job.id, message);
  } else {
    console.error(`[worker] job ${job.id} (${job.kind}) failed (retryable): ${message}`);
    // A retryable failure that exhausts MAX_ATTEMPTS is just as dead: without
    // the world update below it sat in stitching/generating_* forever while the
    // app polled. Nothing else is unwound on either path — a credit reservation
    // stays put because generate may already have been called (spec §14).
    if ((await failJob(db, job.id, message)) !== 'dead') return;
    console.error(`[worker] job ${job.id} (${job.kind}) exhausted its retries, now DEAD`);
  }
  await failWorldForDeadJob(db, job);
}

/** A job just went dead → its world gets the failed_<phase> status (spec §10
 * R22), so the app stops polling an in-progress status nothing will advance. */
async function failWorldForDeadJob(db: Db, job: Pick<Job, 'kind' | 'worldId'>): Promise<void> {
  const failed = failedStatusFor(job.kind);
  if (failed) {
    await db
      .update(worlds)
      .set({ status: failed, progress: null, updatedAt: sql`now()` })
      .where(eq(worlds.id, job.worldId))
      .catch(() => undefined);
  }
}

/**
 * Park jobs that used every attempt without ever reaching failJob — their run
 * killed the process, so the lease simply expired (spec §10 R27). claimNextJob
 * already skips them; this makes them dead and fails their worlds through the
 * same path as any other dead job. Runs on the reaper cadence. Returns the
 * parked job ids.
 */
export async function reapExhaustedJobs(db: Db): Promise<string[]> {
  const parked = await parkExhaustedJobs(db, WORKER_KINDS);
  for (const job of parked) {
    console.error(
      `[worker] job ${job.id} (${job.kind}) expired its lease on the last attempt, now DEAD`,
    );
    await failWorldForDeadJob(db, job);
  }
  return parked.map((j) => j.id);
}

// =============================================================================
// Reaper — orphaned uploading worlds (client died before frames:done).
// =============================================================================

/** How long a world may sit in `uploading` before the reaper fails it. */
export const REAPER_STALE_UPLOAD_MS = 24 * 60 * 60 * 1000;

/**
 * Pure mirror of the reapStaleUploads WHERE clause (same pattern as
 * queue.isJobClaimable): a world is reapable when it is still `uploading` and
 * was created more than `maxAgeMs` ago. The SQL MUST stay in sync with this.
 */
export function isWorldReapable(
  world: Pick<World, 'status' | 'createdAt'>,
  now: Date = new Date(),
  maxAgeMs: number = REAPER_STALE_UPLOAD_MS,
): boolean {
  return world.status === 'uploading' && world.createdAt.getTime() < now.getTime() - maxAgeMs;
}

/**
 * Sweep worlds stuck in `uploading` for >24 h → status 'failed_upload' and a
 * frames-only purge of the capture prefix. The row is kept and NOT
 * soft-deleted (it stays visible as failed in the Library); the client-side
 * abandon flow deletes its world eagerly — this is the server backstop.
 * Returns the reaped world ids (logged individually).
 */
export async function reapStaleUploads(db: Db): Promise<string[]> {
  // One transaction (spec §10 R27): a crash between the flip and the enqueues
  // would leave failed_upload worlds whose frames are never purged (§13) — the
  // flip takes them out of this sweep for good.
  return db.transaction(async (tx) => {
    const rows = await tx
      .update(worlds)
      .set({ status: 'failed_upload', progress: null, updatedAt: sql`now()` })
      .where(
        and(
          eq(worlds.status, 'uploading'),
          lt(worlds.createdAt, sql`now() - interval '24 hours'`),
        ),
      )
      .returning({ id: worlds.id });

    for (const row of rows) {
      console.log(`[worker] reaped stale uploading world ${row.id} → failed_upload`);
      await enqueue(tx, 'purge', row.id, { framesOnly: true });
    }
    return rows.map((r) => r.id);
  });
}

// =============================================================================
// Loop + entrypoint.
// =============================================================================

export function makeWorkerId(): string {
  return `${os.hostname()}:${process.pid}`;
}

export interface WorkerHandle {
  stop(): void;
  done: Promise<void>;
}

/**
 * Start the claim loop. Non-blocking: returns a handle with `stop()` and a
 * `done` promise. Claim errors (e.g. an unreachable dummy DB) are logged and
 * the loop backs off and stays alive (task requirement 10).
 */
export function startWorker(rawDeps: WorkerDeps): WorkerHandle {
  const workerId = rawDeps.workerId ?? makeWorkerId();
  // Every handler heartbeats with this identity, so the lease check can prove
  // ownership (§10 R6).
  const deps: WorkerDeps = { ...rawDeps, workerId };
  const pollMs = deps.config.WORKER_POLL_MS;
  const clock = deps.clock ?? realClock;
  const sleep = clock.sleep;
  let running = true;
  // Reaper cadence: sweep stale uploading worlds every REAPER_INTERVAL_MS
  // (first sweep runs immediately on start).
  let lastReapAt = -Infinity;

  const done = (async () => {
    console.log(`[worker] ${workerId} started; kinds=${WORKER_KINDS.join(',')} poll=${pollMs}ms`);
    while (running) {
      if (clock.now() - lastReapAt >= deps.config.REAPER_INTERVAL_MS) {
        lastReapAt = clock.now();
        try {
          await reapStaleUploads(deps.db);
          await reapExhaustedJobs(deps.db);
        } catch (err) {
          console.error(`[worker] reaper error (staying alive): ${String(err)}`);
        }
      }
      let job: Job | null = null;
      try {
        job = await claimNextJob(deps.db, WORKER_KINDS, workerId);
      } catch (err) {
        console.error(`[worker] claim error (staying alive): ${String(err)}`);
        await sleep(pollMs);
        continue;
      }
      if (!job) {
        await sleep(pollMs);
        continue;
      }
      try {
        await processJob(deps, job);
      } catch (err) {
        await handleJobError(deps.db, job, err).catch((e) =>
          console.error(`[worker] error-handler failed: ${String(e)}`),
        );
      }
    }
    console.log(`[worker] ${workerId} stopped`);
  })();

  return { stop: () => (running = false), done };
}

async function main(): Promise<void> {
  const config = getConfig();
  const deps: WorkerDeps = {
    db: getDb(),
    storage: createStorage(config),
    provider: createProvider(config),
    config,
    push: sendPush,
  };
  const handle = startWorker(deps);

  // Graceful drain (spec §10 R10): stop CLAIMING, let the in-flight job finish.
  //
  // We explicitly do NOT try to hold the process open for a full generation.
  // Railway's SIGTERM→SIGKILL window is short (tens of seconds) and a draft
  // generation runs minutes, so outliving it is not on the table. Losing a job
  // mid-flight is already safe: the operation id is persisted before the money
  // call (§10 R1) and the lease expires so another worker re-claims and resumes
  // (§10 R6). The grace window is for the cheap tail — a stitch about to upload,
  // a finalize about to commit — not for the long poll.
  let stopping = false;
  const shutdown = (sig: string) => {
    if (stopping) return;
    stopping = true;
    console.log(
      `[worker] received ${sig}: no longer claiming jobs, ` +
        `finishing the in-flight one (grace ${config.SHUTDOWN_GRACE_MS}ms)`,
    );
    handle.stop();

    const hard = setTimeout(() => {
      console.warn(
        `[worker] grace deadline hit with a job still running; exiting. ` +
          'Its lease will expire and another worker will resume it (§10 R6).',
      );
      process.exit(0);
    }, config.SHUTDOWN_GRACE_MS);
    hard.unref();

    void handle.done
      .then(() => closeDb())
      .catch((err: unknown) => console.error(`[worker] drain error: ${String(err)}`))
      .finally(() => {
        clearTimeout(hard);
        process.exit(0);
      });
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  await handle.done;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  // Spec §10 R28: log and exit non-zero so Railway restarts a clean process.
  // A job caught mid-flight is safe: its lease expires and it resumes (§10 R6).
  process.on('unhandledRejection', (reason) => {
    console.error('[worker] unhandledRejection, exiting:', reason);
    process.exit(1);
  });
  process.on('uncaughtException', (err) => {
    console.error('[worker] uncaughtException, exiting:', err);
    process.exit(1);
  });
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
