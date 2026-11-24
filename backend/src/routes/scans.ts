import { randomUUID } from 'node:crypto';
import { and, desc, eq, isNull } from 'drizzle-orm';
import { z } from 'zod';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { getDb } from '../db/client.js';
import { captures, worlds, type World } from '../db/schema.js';
import { chargeScanQuota, releaseScanQuota } from '../quota.js';
import { BundleInvalidError, MANIFEST_MAX_BYTES, validateStored } from '../bundle/pack.js';
import { MAX_LONG_EDGE } from '../bundle/validate.js';
import { PRICING, captureConfig } from '../capture-config.js';
import { spentCredits, wouldExceedBudget } from '../budget.js';
import { failWorld } from '../pipeline.js';
import { enqueue } from '../queue.js';
import { createProvider } from '../provider/index.js';
import { MAX_FRAME_BYTES, captureKey, type StorageDriver } from '../storage/index.js';
import {
  findOwnedWorld,
  findWorldByClientRequestId,
  isUniqueViolation,
  requireUserId,
  sendScanQuotaExceeded,
  serializeWorld,
} from './worlds.js';
import type { RouteDeps } from './deps.js';

// Session-format upload path (D-17/D-19/D-20). R2 is the source of truth for
// what was uploaded: the app asks for presigned PUTs per file, reconciles with
// uploads:missing, then :complete runs the capture checks before any credit.
// Logs carry ids/keys only, never presigned URLs.

/** 6 h: a slow walk-through upload on a weak connection must not outlive its URLs. */
const UPLOAD_TTL_SECONDS = 21600;
const FRAME_PATH = /^frames\/(\d{6})\.jpg$/;
const MANIFEST_FILES = ['frames.jsonl', 'session.json'] as const;

const createBody = z
  .object({
    title: z.string().min(1).max(80).optional(),
    frame_count: z.number().int().min(1),
    image_w: z.number().int().min(1).max(MAX_LONG_EDGE),
    image_h: z.number().int().min(1).max(MAX_LONG_EDGE),
    // Postgres integer column: anything above int4 would 500 at insert.
    approved_max_credits: z.number().int().max(2_000_000_000),
  })
  .strict();

const presignBody = z
  .object({
    files: z
      .array(z.object({ path: z.string(), bytes: z.number().int().min(1) }).strict())
      .min(1)
      .max(200),
  })
  .strict();

const pad6 = (n: number) => String(n).padStart(6, '0');

type Db = ReturnType<typeof getDb>;

async function latestCapture(db: Db, worldId: string) {
  const [capture] = await db
    .select()
    .from(captures)
    .where(eq(captures.worldId, worldId))
    .orderBy(desc(captures.createdAt))
    .limit(1);
  return capture;
}

/** What storage holds for this capture vs the declared frame count. */
export async function uploadState(storage: StorageDriver, captureId: string, frameCount: number) {
  const prefix = captureKey(captureId, '');
  const have = new Set((await storage.list(prefix)).map((o) => o.key.slice(prefix.length)));
  const missingFrames: string[] = [];
  for (let i = 1; i <= frameCount; i++) {
    const rel = `frames/${pad6(i)}.jpg`;
    if (!have.has(rel)) missingFrames.push(rel);
  }
  return {
    missingFrames,
    manifestPresent: MANIFEST_FILES.every((f) => have.has(f)),
    uploadedFrames: frameCount - missingFrames.length,
    totalFrames: frameCount,
  };
}

/** Replay of a create: the original world, or 409 when it was soft-deleted. */
function replayScan(reply: FastifyReply, world: World) {
  if (world.deletedAt) {
    return reply.code(409).send({ error: 'idempotency_key_world_deleted', world_id: world.id });
  }
  return reply.code(200).send({ world: serializeWorld(world) });
}

export function scansRoutes(app: FastifyInstance, deps: RouteDeps): void {
  const { config, storage } = deps;
  const provider = deps.provider ?? createProvider(config);

  // GET /v1/quote?frames=N — what a scan of N frames costs and whether today's
  // and this month's budget can cover it (D-18). Read-only: no reservation,
  // no ledger row. withinBudget is decided here, never on the client (T-04-14);
  // submit re-checks atomically under the advisory lock.
  app.get('/v1/quote', async (req, reply) => {
    const userId = requireUserId(req, reply);
    if (!userId) return;
    const limits = await provider.limits();
    const parsed = z
      .object({ frames: z.coerce.number().int().min(1).max(limits.maxFrames) })
      .safeParse(req.query);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'invalid_query', issues: parsed.error.issues });
    }
    const { credits } = await provider.quote(parsed.data.frames);
    const spent = await spentCredits(getDb(), provider.mode);
    const daily = config.DAILY_CREDIT_BUDGET - spent.day;
    const monthly = config.MONTHLY_CREDIT_BUDGET - spent.month;
    return reply.send({
      credits,
      usd: Math.round(credits * PRICING.usdPerCredit * 100) / 100,
      budgetRemaining: Math.max(0, Math.min(daily, monthly)),
      budgetWindow: monthly < daily ? 'monthly' : 'daily',
      withinBudget:
        !wouldExceedBudget(spent.day, credits, config.DAILY_CREDIT_BUDGET) &&
        !wouldExceedBudget(spent.month, credits, config.MONTHLY_CREDIT_BUDGET),
    });
  });

  // GET /v1/capture/config — env-tunable readiness/precheck thresholds (D-08),
  // display pricing and provider frame limits for the app's meters.
  app.get('/v1/capture/config', async (req, reply) => {
    const userId = requireUserId(req, reply);
    if (!userId) return;
    const cc = captureConfig(config);
    const limits = await provider.limits();
    const minFrames = Math.max(cc.precheck.minFrames, limits.minFrames);
    return reply.send({
      readiness: cc.readiness,
      precheck: { ...cc.precheck, minFrames },
      pricing: PRICING,
      limits: { minFrames, maxFrames: limits.maxFrames },
    });
  });

  // POST /v1/scans — an approved scan (D-19) in 'uploading' + its capture row.
  // Idempotency-Key is REQUIRED (the app's local sessionId): retries replay.
  app.post('/v1/scans', {
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
    const body = parsed.data;

    const keyHeader = req.headers['idempotency-key'];
    const rawKey = Array.isArray(keyHeader) ? keyHeader[0] : keyHeader;
    if (rawKey === undefined) return reply.code(400).send({ error: 'missing_idempotency_key' });
    const key = z.guid().safeParse(rawKey.trim());
    if (!key.success) {
      return reply.code(400).send({ error: 'invalid_idempotency_key', detail: 'expected a UUID' });
    }
    const clientRequestId = key.data;

    const db = getDb();
    const existing = await findWorldByClientRequestId(db, userId, clientRequestId);
    if (existing) return replayScan(reply, existing);

    const limits = await provider.limits();
    if (body.frame_count > limits.maxFrames) {
      return reply.code(400).send({ error: 'invalid_body', detail: `frame_count above ${limits.maxFrames}` });
    }
    const quote = await provider.quote(body.frame_count);
    if (body.approved_max_credits < quote.credits) {
      return reply.code(400).send({ error: 'approval_below_quote', quote_credits: quote.credits });
    }

    const charge = await chargeScanQuota(db, userId, config.DAILY_SCAN_QUOTA);
    if (!charge.userFound) return reply.code(401).send({ error: 'unknown_user' });
    if (!charge.allowed) return sendScanQuotaExceeded(reply, charge);

    // World + capture land together or not at all (CR-01): a world without its
    // capture row would 404 every upload call while holding a quota slot.
    const captureId = randomUUID();
    let world: World;
    try {
      world = await db.transaction(async (tx) => {
        const [row] = await tx
          .insert(worlds)
          .values({
            ownerId: userId,
            title: body.title ?? null,
            status: 'uploading',
            clientRequestId,
            // created_at doubles as the approval time (D-19, no migration).
            approvedMaxCredits: body.approved_max_credits,
          })
          .returning();
        await tx.insert(captures).values({
          id: captureId,
          worldId: row!.id,
          frameCount: body.frame_count,
          imageW: body.image_w,
          imageH: body.image_h,
          r2FramesPrefix: `captures/${captureId}`,
        });
        return row!;
      });
    } catch (err) {
      // Any failure refunds the charge; a same-key race replays the winner.
      await releaseScanQuota(db, userId);
      if (!isUniqueViolation(err)) throw err;
      const winner = await findWorldByClientRequestId(db, userId, clientRequestId);
      if (!winner) throw err;
      return replayScan(reply, winner);
    }

    req.log.info({ worldId: world.id, captureId }, 'scan created');
    return reply.code(201).send({ world: serializeWorld(world) });
  });

  // POST /v1/scans/:id/uploads — presigned PUTs for allowlisted session files.
  app.post<{ Params: { id: string } }>('/v1/scans/:id/uploads', async (req, reply) => {
    const userId = requireUserId(req, reply);
    if (!userId) return;
    const db = getDb();
    const world = await findOwnedWorld(db, req.params.id, userId);
    if (!world) return reply.code(404).send({ error: 'world_not_found' });
    if (world.status !== 'uploading') return reply.code(409).send({ error: 'not_uploading' });

    const parsed = presignBody.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'invalid_body', issues: parsed.error.issues });
    }
    const capture = await latestCapture(db, world.id);
    if (!capture) return reply.code(404).send({ error: 'capture_not_found' });

    // Allowlist before signing anything (T-04-05/06); keys are built here.
    const plan: { path: string; bytes: number; contentType: string; maxBytes: number }[] = [];
    for (const f of parsed.data.files) {
      const m = FRAME_PATH.exec(f.path);
      const index = m ? Number(m[1]) : 0;
      if (m && index >= 1 && index <= capture.frameCount && f.bytes <= MAX_FRAME_BYTES) {
        plan.push({ ...f, contentType: 'image/jpeg', maxBytes: MAX_FRAME_BYTES });
      } else if ((MANIFEST_FILES as readonly string[]).includes(f.path) && f.bytes <= MANIFEST_MAX_BYTES) {
        plan.push({ ...f, contentType: 'application/json', maxBytes: MANIFEST_MAX_BYTES });
      } else {
        return reply.code(400).send({ error: 'invalid_path', path: f.path });
      }
    }

    const uploads = await Promise.all(
      plan.map(async (f) => ({
        path: f.path,
        ...(await storage.presignUpload(
          captureKey(capture.id, f.path),
          f.contentType,
          f.maxBytes,
          f.bytes,
          UPLOAD_TTL_SECONDS,
        )),
      })),
    );
    req.log.info({ worldId: world.id, captureId: capture.id, count: uploads.length }, 'scan uploads presigned');
    return reply.send({ uploads });
  });

  // GET /v1/scans/:id/uploads:missing — reconcile against what storage holds.
  app.get<{ Params: { id: string } }>('/v1/scans/:id/uploads::missing', async (req, reply) => {
    const userId = requireUserId(req, reply);
    if (!userId) return;
    const db = getDb();
    const world = await findOwnedWorld(db, req.params.id, userId);
    if (!world) return reply.code(404).send({ error: 'world_not_found' });
    const capture = await latestCapture(db, world.id);
    if (!capture) return reply.code(404).send({ error: 'capture_not_found' });

    if (world.status !== 'uploading') {
      return reply.send({
        world: serializeWorld(world),
        missingFrames: [],
        manifestPresent: true,
        uploadedFrames: capture.frameCount,
        totalFrames: capture.frameCount,
      });
    }
    const state = await uploadState(storage, capture.id, capture.frameCount);
    return reply.send({ world: serializeWorld(world), ...state });
  });

  // POST /v1/scans/<uuid>:complete — the uuid regex keeps `:complete` out of
  // the param (a plain `:id::complete` would capture "abc:complete").
  // Checks run BEFORE any credit (D-17): a bad scan fails at 'validate' for
  // free; a good one flips uploading -> packing with its pack job atomically.
  // Credits are reserved later by submit, never here.
  app.post<{ Params: { id: string } }>('/v1/scans/:id([0-9a-fA-F-]{36})::complete', async (req, reply) => {
    const userId = requireUserId(req, reply);
    if (!userId) return;
    const db = getDb();
    const world = await findOwnedWorld(db, req.params.id, userId);
    if (!world) return reply.code(404).send({ error: 'world_not_found' });
    // Replay-safe: past uploading, report the current state.
    if (world.status !== 'uploading') return reply.send({ world: serializeWorld(world) });

    const capture = await latestCapture(db, world.id);
    if (!capture) return reply.code(404).send({ error: 'capture_not_found' });
    const state = await uploadState(storage, capture.id, capture.frameCount);
    if (state.missingFrames.length || !state.manifestPresent) {
      return reply.code(409).send({
        error: 'upload_incomplete',
        missingFrames: state.missingFrames,
        manifestPresent: state.manifestPresent,
      });
    }

    const cc = captureConfig(config);
    const limits = await provider.limits();
    try {
      await validateStored(storage, capture.id, {
        minFrames: Math.max(cc.precheck.minFrames, limits.minFrames),
        maxFrames: limits.maxFrames,
        rules: cc.precheck,
        expectedFrameCount: capture.frameCount,
      });
    } catch (err) {
      if (!(err instanceof BundleInvalidError)) throw err;
      const codes = [...new Set(err.issues.map((i) => i.code))];
      await failWorld(db, world.id, ['uploading'], 'validate', codes[0]!, codes.join(', '));
      req.log.info({ worldId: world.id, codes }, 'scan failed validation at complete');
      const current = await findOwnedWorld(db, world.id, userId);
      return reply.send({ world: serializeWorld(current ?? world), issues: codes });
    }

    const flipped = await db.transaction(async (tx) => {
      const [row] = await tx
        .update(worlds)
        .set({ status: 'packing', progress: null, updatedAt: new Date() })
        .where(and(eq(worlds.id, world.id), eq(worlds.status, 'uploading'), isNull(worlds.deletedAt)))
        .returning();
      if (!row) return null;
      await enqueue(tx, 'pack', world.id, { captureId: capture.id });
      return row;
    });
    if (!flipped) {
      const current = await findOwnedWorld(db, world.id, userId);
      return reply.send({ world: serializeWorld(current ?? world) });
    }
    req.log.info({ worldId: world.id, captureId: capture.id }, 'scan complete, pack enqueued');
    return reply.send({ world: serializeWorld(flipped) });
  });
}
