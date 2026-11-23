import { describe, it, expect } from 'vitest';
import { framesDoneBody, listQuery } from '../src/routes/worlds.js';

// zod 3 -> 4 (spec §10 R30): request parsing must behave exactly as before.

const pose = {
  index: 0,
  timestamp: 1,
  transform: Array(16).fill(0),
  intrinsics: Array(9).fill(0),
  exposureLocked: true,
};

describe('zod 4 request contract', () => {
  it('poses keep unknown fields verbatim, at the pose and depth level', () => {
    const parsed = framesDoneBody.parse({
      poses: [{ ...pose, futureField: 'x', depth: { width: 2, height: 3, extra: 1 } }],
    });
    expect(parsed?.poses?.[0]).toMatchObject({ futureField: 'x', depth: { extra: 1 } });
  });

  it('frames:done body may be absent or null', () => {
    expect(framesDoneBody.safeParse(undefined).success).toBe(true);
    expect(framesDoneBody.safeParse(null).success).toBe(true);
  });

  it('list query coerces strings, defaults, and rejects junk with path-bearing issues', () => {
    expect(listQuery.parse({})).toEqual({ limit: 20, offset: 0 });
    expect(listQuery.parse({ limit: '5', offset: '10' })).toEqual({ limit: 5, offset: 10 });
    const bad = listQuery.safeParse({ limit: 'abc' });
    expect(bad.success).toBe(false);
    expect(bad.error?.issues[0]).toMatchObject({ path: ['limit'], code: expect.any(String) });
    expect(typeof bad.error?.issues[0]?.message).toBe('string');
  });
});
