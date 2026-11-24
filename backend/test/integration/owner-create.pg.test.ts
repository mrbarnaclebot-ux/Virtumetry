import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import type { FastifyInstance } from 'fastify';

let currentDb: unknown;
vi.mock('../../src/db/client.js', () => ({ getDb: () => currentDb, closeDb: async () => {} }));

import { createTestSchema } from '../helpers/pg-schema.js';
import { buildSessionApp, signIn } from '../helpers/auth-app.js';
import { ensureOwnerCredential } from '../../src/auth/owner.js';

// D-07 owner:create. The helper runs on a throwaway schema (D-14); the script
// itself is only exercised through its guards, which refuse before any DB
// connection, so it never touches the real dev DB here.

const url = process.env.TEST_DATABASE_URL;
const EMAIL = 'owner-new@example.com';
const BACKEND = fileURLToPath(new URL('../..', import.meta.url));

describe.skipIf(!url)('ensureOwnerCredential create → reset (real Postgres)', () => {
  let schema: Awaited<ReturnType<typeof createTestSchema>>;
  let s: Awaited<ReturnType<typeof buildSessionApp>>;
  let app: FastifyInstance;

  beforeAll(async () => {
    schema = await createTestSchema(url!, { max: 4 });
    currentDb = schema.db;
    s = await buildSessionApp({ db: schema.db, env: { AUTH_RATE_LIMIT: '0', OWNER_ALLOWLIST: EMAIL } });
    app = s.app;
  }, 60_000);

  afterAll(async () => {
    await app?.close();
    await schema?.drop();
  });

  it('creates, then resets the password and revokes old sessions; one user + one credential', async () => {
    const pw1 = randomBytes(18).toString('base64url');
    const pw2 = randomBytes(18).toString('base64url');
    expect(await ensureOwnerCredential(s.auth, `  ${EMAIL.toUpperCase()} `, pw1)).toBe('created');
    const first = await signIn(app, EMAIL, pw1);
    expect(first.status).toBe(200);
    const list = () =>
      app.inject({ method: 'GET', url: '/v1/worlds', remoteAddress: '10.9.9.9', headers: { cookie: first.cookie } });
    expect((await list()).statusCode).toBe(200);

    expect(await ensureOwnerCredential(s.auth, EMAIL, pw2)).toBe('reset');
    expect((await signIn(app, EMAIL, pw2)).status).toBe(200);
    expect((await signIn(app, EMAIL, pw1)).status).toBe(401);
    // T-03-15: a session from before the reset is dead.
    expect((await list()).statusCode).toBe(401);

    const users = await schema.pool.query(`SELECT id FROM "user" WHERE email = $1`, [EMAIL]);
    expect(users.rows).toHaveLength(1);
    const accts = await schema.pool.query(
      `SELECT count(*)::int AS n FROM account WHERE user_id = $1 AND provider_id = 'credential'`,
      [users.rows[0].id],
    );
    expect(accts.rows[0].n).toBe(1);
  });
});

describe('owner:create script guards (no DB connection)', () => {
  const PASSWORD = `pw-${randomBytes(12).toString('hex')}`;
  const DEV_LOOKING = 'postgres://u:p@ep-mute-fog-arwonnkz.us-east-2.aws.neon.tech/db';

  function run(env: Record<string, string>) {
    const r = spawnSync(process.execPath, ['--import', 'tsx', 'scripts/owner-create.ts'], {
      cwd: BACKEND,
      env: {
        PATH: process.env.PATH ?? '',
        ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}),
        OWNER_PASSWORD: PASSWORD,
        ...env,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
      encoding: 'utf8',
      timeout: 60_000,
    });
    const out = `${r.stdout}${r.stderr}`;
    expect(out).not.toContain(PASSWORD);
    return { code: r.status, stderr: r.stderr, out };
  }

  it('refuses a non-dev host, naming the variable but not the URL', () => {
    const bad = 'postgres://u:p@ep-other-123.us-west-2.aws.neon.tech/db';
    const r = run({ MIGRATE_DATABASE_URL: bad, OWNER_EMAIL: EMAIL, OWNER_ALLOWLIST: EMAIL });
    expect(r.code).not.toBe(0);
    expect(r.stderr).toContain('MIGRATE_DATABASE_URL');
    expect(r.out).not.toContain('ep-other-123');
  }, 70_000);

  it('refuses an email that is not in OWNER_ALLOWLIST before connecting', () => {
    const r = run({
      MIGRATE_DATABASE_URL: DEV_LOOKING,
      OWNER_EMAIL: 'someone-else@example.com',
      OWNER_ALLOWLIST: EMAIL,
    });
    expect(r.code).not.toBe(0);
    expect(r.stderr).toContain('OWNER_ALLOWLIST');
    expect(r.out).not.toContain('someone-else@example.com');
  }, 70_000);

  it('refuses NODE_ENV=production', () => {
    const r = run({
      NODE_ENV: 'production',
      MIGRATE_DATABASE_URL: DEV_LOOKING,
      OWNER_EMAIL: EMAIL,
      OWNER_ALLOWLIST: EMAIL,
    });
    expect(r.code).not.toBe(0);
    expect(r.stderr).toContain('NODE_ENV');
  }, 70_000);

  it('refuses a password shorter than 12 characters', () => {
    const r = run({
      MIGRATE_DATABASE_URL: DEV_LOOKING,
      OWNER_EMAIL: EMAIL,
      OWNER_ALLOWLIST: EMAIL,
      OWNER_PASSWORD: 'short',
    });
    expect(r.code).not.toBe(0);
    expect(r.stderr).toContain('OWNER_PASSWORD');
  }, 70_000);
});
