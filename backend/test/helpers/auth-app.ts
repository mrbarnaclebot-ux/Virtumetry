import { randomBytes } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { loadConfig, type Config } from '../../src/config.js';
import type { Db } from '../../src/db/client.js';
import { buildServer } from '../../src/server.js';
import { createAuth } from '../../src/auth/better-auth.js';
import { ensureOwnerCredential } from '../../src/auth/owner.js';

// Session-mode app over a throwaway schema. The caller must vi.mock
// src/db/client.js so getDb() returns `db` (buildServer's createAuth and the
// /v1 routes both go through getDb()).

export const TEST_SECRET = randomBytes(24).toString('hex'); // 48 chars, per run

export async function buildSessionApp(opts: { db: Db; env?: Record<string, string> }) {
  const config: Config = loadConfig({
    DATABASE_URL: process.env.TEST_DATABASE_URL ?? 'postgres://u:p@localhost:5432/db',
    AUTH_MODE: 'session',
    BETTER_AUTH_SECRET: TEST_SECRET,
    BETTER_AUTH_URL: 'http://localhost:8080',
    OWNER_ALLOWLIST: 'owner-a@example.com,owner-b@example.com',
    STORAGE_DRIVER: 'local',
    LOCAL_STORAGE_DIR: mkdtempSync(path.join(tmpdir(), 'vm-auth-')),
    TRUST_PROXY_HOPS: '0',
    ...opts.env,
  } as NodeJS.ProcessEnv);
  const app = await buildServer(config);
  // Same db + config as the server's own instance; seeding uses only the DB.
  const auth = createAuth({ db: opts.db, config });
  return { app, auth, config };
}

/** Create (or reset) a credential for `email` with a random password; returns it. */
export async function seedOwner(auth: ReturnType<typeof createAuth>, email: string) {
  const password = randomBytes(18).toString('base64url');
  await ensureOwnerCredential(auth, email, password);
  return password;
}

/** `name=value; name2=value2` from every Set-Cookie header. */
export function cookieFrom(setCookie: string | string[] | undefined): string {
  const list = Array.isArray(setCookie) ? setCookie : setCookie ? [setCookie] : [];
  return list.map((c) => c.split(';')[0]).join('; ');
}

export async function signIn(
  app: FastifyInstance,
  email: string,
  password: string,
  o: { remoteAddress?: string; origin?: string | null; headers?: Record<string, string> } = {},
) {
  const res = await app.inject({
    method: 'POST',
    url: '/api/auth/sign-in/email',
    remoteAddress: o.remoteAddress ?? '10.0.0.1',
    headers: {
      'content-type': 'application/json',
      ...(o.origin === null ? {} : { origin: o.origin ?? 'virtumetry://' }),
      ...o.headers,
    },
    payload: JSON.stringify({ email, password }),
  });
  let body: Record<string, unknown> = {};
  try {
    body = JSON.parse(res.body) as Record<string, unknown>;
  } catch {
    /* non-JSON body */
  }
  return { status: res.statusCode, body, cookie: cookieFrom(res.headers['set-cookie']) };
}
