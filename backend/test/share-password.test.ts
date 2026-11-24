import { describe, it, expect } from 'vitest';
import { hashSharePassword, verifySharePassword } from '../src/share-password.js';

describe('share password (D-15, T-05-12/13)', () => {
  it('hashes in the scrypt$N$r$p$salt$hash format', async () => {
    expect(await hashSharePassword('abcd')).toMatch(/^scrypt\$16384\$8\$1\$[A-Za-z0-9_-]{22}\$[A-Za-z0-9_-]{43}$/);
  });

  it('verifies the right password and rejects a wrong one', async () => {
    const h = await hashSharePassword('correct horse');
    expect(await verifySharePassword('correct horse', h)).toBe(true);
    expect(await verifySharePassword('correct hors', h)).toBe(false);
  });

  it('salts: two hashes of one password differ', async () => {
    expect(await hashSharePassword('abcd')).not.toBe(await hashSharePassword('abcd'));
  });

  it.each([
    '',
    'nonsense',
    'scrypt$16384$8$1$AAAA',
    'bcrypt$16384$8$1$AAAAAAAAAAAAAAAAAAAAAA$AAAA',
    'scrypt$abc$8$1$AAAAAAAAAAAAAAAAAAAAAA$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
    'scrypt$16384$8$1$AAAAAAAAAAAAAAAAAAAAAA$AAAA',
    'scrypt$999999999$8$1$AAAAAAAAAAAAAAAAAAAAAA$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
  ])('malformed stored hash %j → false, no throw', async (stored) => {
    expect(await verifySharePassword('abcd', stored)).toBe(false);
  });
});
