// Run the pg integration tests against the Neon DEV branch direct host.
// TEST_DATABASE_URL is set in-process from MIGRATE_DATABASE_URL, never printed.
// Usage: cd backend && node --env-file=.env scripts/test-pg.mjs [vitest args]
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { assertDevDb } from './dev-guard.mjs';

let url;
try {
  url = assertDevDb('MIGRATE_DATABASE_URL');
} catch (err) {
  console.error(`[test-pg] ${err.message}`);
  process.exit(1);
}

const args = process.argv.slice(2);
// Direct node invocation, no npx: avoids Windows .cmd shell quirks.
const r = spawnSync(
  process.execPath,
  ['node_modules/vitest/vitest.mjs', 'run', ...(args.length ? args : ['test/integration'])],
  {
    cwd: fileURLToPath(new URL('..', import.meta.url)),
    env: { ...process.env, TEST_DATABASE_URL: url },
    stdio: 'inherit',
  },
);
process.exit(r.status ?? 1);
