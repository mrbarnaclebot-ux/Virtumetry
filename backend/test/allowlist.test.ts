import { describe, it, expect } from 'vitest';
import { parseAllowlist, isAllowlisted } from '../src/auth/better-auth.js';

describe('OWNER_ALLOWLIST parsing (D-03)', () => {
  it('trims, lowercases and drops empties', () => {
    expect(parseAllowlist(' A@x.com , ,b@Y.com ')).toEqual(new Set(['a@x.com', 'b@y.com']));
  });

  it('undefined or empty = nobody', () => {
    expect(parseAllowlist(undefined).size).toBe(0);
    expect(parseAllowlist('').size).toBe(0);
    expect(isAllowlisted(parseAllowlist(''), 'a@x.com')).toBe(false);
  });

  it('isAllowlisted is case-insensitive and rejects empty input', () => {
    const allow = parseAllowlist('owner-a@example.com');
    expect(isAllowlisted(allow, ' Owner-A@Example.COM ')).toBe(true);
    expect(isAllowlisted(allow, 'stranger@example.com')).toBe(false);
    expect(isAllowlisted(allow, '')).toBe(false);
    expect(isAllowlisted(allow, undefined)).toBe(false);
  });
});
