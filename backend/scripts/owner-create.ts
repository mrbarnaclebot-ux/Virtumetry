// D-07: create the single owner account, or reset its password, on the Neon
// DEV branch only. Sign-up stays disabled; this goes through Better Auth's
// internal adapter (ensureOwnerCredential). A reset also logs out every session.
// Prints a status word only — never the email, password or connection string.
// Usage: cd backend && npm run owner:create
//   OWNER_EMAIL / OWNER_PASSWORD from env, else prompted (password hidden).
//   OWNER_ALLOWLIST must contain the email.
import { randomBytes } from 'node:crypto';
import { createInterface } from 'node:readline';
import { pathToFileURL } from 'node:url';
import pg from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import * as schema from '../src/db/schema.js';
import type { Config } from '../src/config.js';
import type { Db } from '../src/db/client.js';
import { createAuth, parseAllowlist } from '../src/auth/better-auth.js';
import { ensureOwnerCredential } from '../src/auth/owner.js';
import { assertDevDb } from './dev-guard.mjs';

/** Prompt on the terminal; `hidden` swallows the echo of what is typed. */
function ask(question: string, hidden = false): Promise<string> {
  if (!process.stdin.isTTY) {
    return Promise.reject(new Error(`${hidden ? 'OWNER_PASSWORD' : 'OWNER_EMAIL'} is not set (no terminal to prompt)`));
  }
  const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      if (hidden) process.stdout.write('\n');
      rl.close();
      resolve(answer);
    });
    if (hidden) (rl as unknown as { _writeToOutput: (s: string) => void })._writeToOutput = () => {};
  });
}

async function main(): Promise<void> {
  // Every refusal happens before any DB connection.
  if (process.env.NODE_ENV === 'production') throw new Error('NODE_ENV=production refused');
  const url = assertDevDb('MIGRATE_DATABASE_URL');

  const email = (process.env.OWNER_EMAIL ?? (await ask('Owner email: '))).trim().toLowerCase();
  if (!parseAllowlist(process.env.OWNER_ALLOWLIST).has(email)) {
    throw new Error('OWNER_EMAIL refused: not in OWNER_ALLOWLIST');
  }
  const password = process.env.OWNER_PASSWORD ?? (await ask('Owner password (hidden): ', true));
  if (password.length < 12) throw new Error('OWNER_PASSWORD refused: at least 12 characters');

  const pool = new pg.Pool({ connectionString: url, max: 1 });
  try {
    const db = drizzle(pool, { schema }) as unknown as Db;
    const config = {
      // Password hashing ignores the secret; an ephemeral one is fine here.
      BETTER_AUTH_SECRET: process.env.BETTER_AUTH_SECRET || randomBytes(32).toString('base64url'),
      BETTER_AUTH_URL: 'http://localhost',
      OWNER_ALLOWLIST: process.env.OWNER_ALLOWLIST,
      AUTH_RATE_LIMIT: '0',
    } as Config;
    const result = await ensureOwnerCredential(createAuth({ db, config }), email, password);
    console.log(`owner account ready (${result})`);
  } finally {
    await pool.end();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().then(
    () => process.exit(0),
    (err: unknown) => {
      // Our errors name variables only; scrub URLs from anything else (driver errors).
      console.error(`[owner:create] ${(err instanceof Error ? err.message : String(err)).replace(/\w+:\/\/\S+/g, '[url]')}`);
      process.exit(1);
    },
  );
}
