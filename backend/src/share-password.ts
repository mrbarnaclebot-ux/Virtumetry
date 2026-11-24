import { randomBytes, scrypt as scryptCb, timingSafeEqual, type ScryptOptions } from 'node:crypto';

// Share-link passwords (D-15, T-05-12/13). Stored as
// `scrypt$N$r$p$<salt b64url>$<hash b64url>` so params can change later
// without breaking existing links.

const N = 16384;
const R = 8;
const P = 1;
const KEYLEN = 32;

function scrypt(pw: string, salt: Buffer, keylen: number, opts: ScryptOptions): Promise<Buffer> {
  return new Promise((resolve, reject) =>
    scryptCb(pw, salt, keylen, opts, (err, key) => (err ? reject(err) : resolve(key))),
  );
}

export async function hashSharePassword(pw: string): Promise<string> {
  const salt = randomBytes(16);
  const hash = await scrypt(pw, salt, KEYLEN, { N, r: R, p: P });
  return `scrypt$${N}$${R}$${P}$${salt.toString('base64url')}$${hash.toString('base64url')}`;
}

/** Constant-time check; any malformed stored string is simply `false`. */
export async function verifySharePassword(pw: string, stored: string): Promise<boolean> {
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const [n, r, p] = parts.slice(1, 4).map(Number) as [number, number, number];
  // Bound the params: a hostile stored string must not become a memory bomb.
  if (![n, r, p].every(Number.isInteger) || n < 2 || n > 2 ** 17 || r < 1 || r > 16 || p < 1 || p > 4) {
    return false;
  }
  const salt = Buffer.from(parts[4]!, 'base64url');
  const expected = Buffer.from(parts[5]!, 'base64url');
  if (salt.length === 0 || expected.length !== KEYLEN) return false;
  try {
    const actual = await scrypt(pw, salt, expected.length, { N: n, r, p, maxmem: 256 * 1024 * 1024 });
    return timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}
