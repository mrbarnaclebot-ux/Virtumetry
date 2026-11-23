// Apply pending migrations to the Neon DEV branch only (never drizzle-kit push).
// Usage: cd backend && node --env-file=.env scripts/migrate-dev.mjs
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { assertDevDb } from './dev-guard.mjs';

try {
  assertDevDb('MIGRATE_DATABASE_URL');
} catch (err) {
  console.error(`[migrate-dev] ${err.message}`);
  process.exit(1);
}

// src/migrate.ts still runs config.ts isolation checks itself.
const r = spawnSync(process.execPath, ['--import', 'tsx', 'src/migrate.ts'], {
  cwd: fileURLToPath(new URL('..', import.meta.url)),
  stdio: 'inherit',
});
process.exit(r.status ?? 1);
