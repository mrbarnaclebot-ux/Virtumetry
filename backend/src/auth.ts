import { createHash, timingSafeEqual } from 'node:crypto';
import { createRemoteJWKSet, jwtVerify } from 'jose';
import type { FastifyReply, FastifyRequest, onRequestHookHandler } from 'fastify';
import type { Config } from './config.js';
import { getDb } from './db/client.js';
import { upsertUserBySub } from './db/users.js';
import type { FailureThrottle } from './throttle.js';

declare module 'fastify' {
  interface FastifyRequest {
    userId?: string;
  }
}

// --- Dev-mode header parsing (pure, testable without a DB) -------------------

export type DevAuthResult =
  | { ok: true; subject: string; displayName?: string }
  | { ok: false; status: number; message: string };

/**
 * Constant-time secret comparison (spec §10 R2). `===` on a shared bearer token
 * short-circuits at the first differing byte and leaks the token prefix through
 * response timing. Both sides are SHA-256'd first so the comparison is also
 * LENGTH-safe: digests are always 32 bytes, so timingSafeEqual never throws on
 * a length mismatch and the attacker learns nothing from the token's length.
 */
export function secretEquals(a: string, b: string): boolean {
  const ha = createHash('sha256').update(a, 'utf8').digest();
  const hb = createHash('sha256').update(b, 'utf8').digest();
  return timingSafeEqual(ha, hb);
}

/**
 * Validate dev-mode auth headers: `Authorization: Bearer <DEV_AUTH_TOKEN>` plus
 * an `x-dev-user` identity header. Returns the subject to upsert, or a rejection.
 */
export function parseDevAuth(
  headers: Record<string, string | string[] | undefined>,
  devToken: string | undefined,
): DevAuthResult {
  if (!devToken) {
    return { ok: false, status: 500, message: 'DEV_AUTH_TOKEN not configured' };
  }
  const authz = headers['authorization'];
  const authHeader = Array.isArray(authz) ? authz[0] : authz;
  const bearer = authHeader?.startsWith('Bearer ')
    ? authHeader.slice('Bearer '.length).trim()
    : undefined;
  if (!bearer || !secretEquals(bearer, devToken)) {
    return { ok: false, status: 401, message: 'invalid or missing bearer token' };
  }
  const devUser = headers['x-dev-user'];
  const subject = (Array.isArray(devUser) ? devUser[0] : devUser)?.trim();
  if (!subject) {
    return { ok: false, status: 401, message: 'missing x-dev-user header' };
  }
  return { ok: true, subject, displayName: subject };
}

// --- Apple identity token verification --------------------------------------

const APPLE_JWKS_URL = 'https://appleid.apple.com/auth/keys';
const APPLE_ISSUER = 'https://appleid.apple.com';

// Cache the remote JWKS across requests (jose caches keys internally too).
let appleJwks: ReturnType<typeof createRemoteJWKSet> | undefined;
function getAppleJwks() {
  if (!appleJwks) appleJwks = createRemoteJWKSet(new URL(APPLE_JWKS_URL));
  return appleJwks;
}

export async function verifyAppleToken(
  token: string,
  audience: string,
): Promise<{ subject: string; email?: string }> {
  const { payload } = await jwtVerify(token, getAppleJwks(), {
    issuer: APPLE_ISSUER,
    audience,
  });
  if (!payload.sub) throw new Error('apple token missing sub');
  const email = typeof payload['email'] === 'string' ? payload['email'] : undefined;
  return { subject: payload.sub, email };
}

// --- Fastify preHandler ------------------------------------------------------

function bearerFrom(req: FastifyRequest): string | undefined {
  const authz = req.headers['authorization'];
  const header = Array.isArray(authz) ? authz[0] : authz;
  return header?.startsWith('Bearer ') ? header.slice(7).trim() : undefined;
}

/**
 * Build the auth hook for the configured mode. Attaches `request.userId`
 * (upserting the user) or replies 401/403/500.
 *
 * Registered as an **onRequest** hook: it only reads headers, and running it
 * before any preHandler is what lets the rate limiter key its buckets on
 * `req.userId` (spec §10 R10).
 *
 * `throttle` (optional) blocks an IP that has produced too many FAILED auths in
 * the window (spec §10 R10). It is checked before any work: a blocked caller
 * costs us neither a JWKS fetch nor a user upsert. A successful auth clears the
 * IP's history so one fat-fingered client never accumulates its way to a block.
 */
export function makeAuthPreHandler(
  config: Config,
  throttle?: FailureThrottle,
): onRequestHookHandler {
  return async (req: FastifyRequest, reply: FastifyReply) => {
    const ip = req.ip;

    if (throttle?.isBlocked(ip)) {
      const retryAfter = throttle.retryAfterSeconds(ip);
      req.log.warn({ ip, retryAfter }, 'auth blocked: too many failed attempts');
      return reply
        .code(429)
        .header('retry-after', String(retryAfter))
        .send({ error: 'too_many_failed_auth_attempts', retry_after: retryAfter });
    }

    /** Record the failure before replying, so the next attempt sees it. */
    const fail = (status: number, error: string) => {
      throttle?.record(ip);
      return reply.code(status).send({ error });
    };

    if (config.AUTH_MODE === 'dev') {
      const res = parseDevAuth(req.headers, config.DEV_AUTH_TOKEN);
      // A 500 here is OUR misconfiguration (no DEV_AUTH_TOKEN), not a failed
      // credential — charging the caller's IP for it would be wrong.
      if (!res.ok && res.status >= 500) {
        return reply.code(res.status).send({ error: res.message });
      }
      if (!res.ok) return fail(res.status, res.message);
      const user = await upsertUserBySub(getDb(), res.subject, res.displayName);
      if (user.deletedAt) return replyAccountDeleted(reply);
      throttle?.reset(ip);
      req.userId = user.id;
      return;
    }

    // apple mode
    const token = bearerFrom(req);
    if (!token) return fail(401, 'missing bearer token');
    let userId: string;
    try {
      const { subject, email } = await verifyAppleToken(
        token,
        config.APPLE_BUNDLE_ID as string,
      );
      const user = await upsertUserBySub(getDb(), subject, email ?? null);
      if (user.deletedAt) return replyAccountDeleted(reply);
      userId = user.id;
    } catch (err) {
      req.log.warn({ err }, 'apple token verification failed');
      return fail(401, 'invalid apple identity token');
    }
    throttle?.reset(ip);
    req.userId = userId;
  };
}

/**
 * Deleted accounts stay deleted (spec §10 R3 / §13). `users.deleted_at` was
 * written by DELETE /v1/account but never read, so a deleted account's token
 * kept working and kept being upserted. Re-signing in with the SAME identity
 * subject is refused rather than resurrecting or forking the row: the purge job
 * has already destroyed that user's worlds and frames, so "reviving" them would
 * hand back an account whose data is gone, and minting a second row for the same
 * `apple_sub` is impossible (the column is UNIQUE) without rewriting identity —
 * which would silently break any surviving foreign keys. A genuinely new user is
 * a new Apple `sub` and gets a fresh row as usual.
 */
function replyAccountDeleted(reply: FastifyReply) {
  return reply.code(403).send({ error: 'account_deleted' });
}
