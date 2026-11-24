import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createTestSchema } from '../helpers/pg-schema.js';
import { creditEvents } from '../../src/db/schema.js';
import { resetTodayMockSpend } from '../../scripts/budget-reset-dev.js';

// D-24 budget:reset-dev. Delete logic runs on a throwaway schema; the script
// itself is only exercised through its guard, which refuses before connecting.

const url = process.env.TEST_DATABASE_URL;
const BACKEND = fileURLToPath(new URL('../..', import.meta.url));

describe.skipIf(!url)('resetTodayMockSpend (real Postgres)', () => {
  let schema: Awaited<ReturnType<typeof createTestSchema>>;

  beforeAll(async () => {
    schema = await createTestSchema(url!, { max: 2 });
  }, 60_000);

  afterAll(async () => {
    await schema?.drop();
  });

  it("deletes only today's mock rows; live and yesterday's rows stay", async () => {
    const yesterday = new Date(Date.now() - 36 * 3600_000);
    await schema.db.insert(creditEvents).values([
      { amount: 930, providerMode: 'mock' },
      { amount: 930, providerMode: 'mock' },
      { amount: 930, providerMode: 'live' },
      { amount: 930, providerMode: 'mock', createdAt: yesterday },
    ]);
    expect(await resetTodayMockSpend(schema.db)).toBe(2);
    const left = await schema.db.select().from(creditEvents);
    expect(left.map((r) => r.providerMode).sort()).toEqual(['live', 'mock']);
    expect(left.find((r) => r.providerMode === 'mock')!.createdAt.getTime()).toBe(yesterday.getTime());
  });
});

describe('budget:reset-dev script guard (no DB connection)', () => {
  it('refuses a non-dev database host without printing it', () => {
    const r = spawnSync(process.execPath, ['--import', 'tsx', 'scripts/budget-reset-dev.ts'], {
      cwd: BACKEND,
      env: {
        PATH: process.env.PATH ?? '',
        ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}),
        MIGRATE_DATABASE_URL: 'postgres://u:p@example.invalid/db',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
      encoding: 'utf8',
      timeout: 60_000,
    });
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain('MIGRATE_DATABASE_URL');
    expect(`${r.stdout}${r.stderr}`).not.toContain('example.invalid');
    expect(r.stdout).not.toContain('deleted');
  }, 70_000);
});
