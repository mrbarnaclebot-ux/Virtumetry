// Run the gated R2 Range preflight test against the virtumetry-dev bucket only.
// Usage: cd backend && node --env-file=.env scripts/test-r2.mjs
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { assertDevBucket } from './dev-guard.mjs';

try {
  assertDevBucket();
} catch (err) {
  console.error(`[test-r2] ${err.message}`);
  process.exit(1);
}

const r = spawnSync(
  process.execPath,
  ['node_modules/vitest/vitest.mjs', 'run', 'test/integration/r2-range.s3.test.ts'],
  {
    cwd: fileURLToPath(new URL('..', import.meta.url)),
    env: { ...process.env, R2_IT: '1' },
    stdio: 'inherit',
  },
);
process.exit(r.status ?? 1);
