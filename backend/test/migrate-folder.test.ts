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

  it('history is a single fresh 0000_init migration', () => {
    expect(journal.entries).toHaveLength(1);
    expect(journal.entries[0]!.tag.startsWith('0000_init')).toBe(true);
  });
});
