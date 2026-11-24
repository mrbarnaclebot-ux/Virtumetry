import { describe, it, expect } from 'vitest';
import { listQuery } from '../src/routes/worlds.js';

// zod 3 -> 4 (spec §10 R30): request parsing must behave exactly as before.

describe('zod 4 request contract', () => {
  it('list query coerces strings, defaults, and rejects junk with path-bearing issues', () => {
    expect(listQuery.parse({})).toEqual({ limit: 20, offset: 0 });
    expect(listQuery.parse({ limit: '5', offset: '10' })).toEqual({ limit: 5, offset: 10 });
    const bad = listQuery.safeParse({ limit: 'abc' });
    expect(bad.success).toBe(false);
    expect(bad.error?.issues[0]).toMatchObject({ path: ['limit'], code: expect.any(String) });
    expect(typeof bad.error?.issues[0]?.message).toBe('string');
  });
});
