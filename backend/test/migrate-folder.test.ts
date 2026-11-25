import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { MIGRATIONS_FOLDER } from '../src/migrate.js';

const journal = JSON.parse(
  fs.readFileSync(path.join(MIGRATIONS_FOLDER, 'meta', '_journal.json'), 'utf8'),
) as { entries: { tag: string }[] };

describe('drizzle migrations folder', () => {
  it('every journal entry has its SQL file', () => {
    expect(journal.entries.length).toBeGreaterThan(0);
    for (const { tag } of journal.entries) {
      expect(fs.existsSync(path.join(MIGRATIONS_FOLDER, `${tag}.sql`)), tag).toBe(true);
    }
  });

  it('history is 0000_init then the split Phase 2 add/drop migrations, then Better Auth, share links, then Phase 6 retry/alerts', () => {
    expect(journal.entries.map((e) => e.tag)).toEqual([
      expect.stringMatching(/^0000_init/),
      '0001_phase2_add',
      '0002_phase2_drop',
      '0003_better_auth',
      '0004_share_links',
      '0005_phase6_retry_alerts',
    ]);
  });
});
