import { describe, it, expect } from 'vitest';
import { SignJWT, generateKeyPair, exportJWK, createLocalJWKSet, jwtVerify } from 'jose';

// The jose API surface auth.ts depends on (spec §10 R11, jose 5 -> 6).
//
// verifyAppleToken() calls createRemoteJWKSet(new URL(...)) and then
// jwtVerify(token, jwks, { issuer, audience }), reading payload.sub. A type
// check alone would not catch a behavioural change in that flow, and the real
// path needs Apple's network JWKS — so this exercises the identical call shape
// against a LOCAL key set: same jwtVerify, same options, same payload access.

const ISSUER = 'https://appleid.apple.com';
const AUDIENCE = 'com.example.virtspace';

async function makeKeyAndJwks() {
  const { publicKey, privateKey } = await generateKeyPair('RS256', { extractable: true });
  const jwk = await exportJWK(publicKey);
  jwk.kid = 'test-key';
  jwk.alg = 'RS256';
  const jwks = createLocalJWKSet({ keys: [jwk] });
  return { privateKey, jwks };
}

function sign(privateKey: CryptoKey, claims: Record<string, unknown>, sub = 'apple-sub-1') {
  return new SignJWT(claims)
    .setProtectedHeader({ alg: 'RS256', kid: 'test-key' })
    .setIssuer(ISSUER)
    .setAudience(AUDIENCE)
    .setSubject(sub)
    .setIssuedAt()
    .setExpirationTime('5m')
    .sign(privateKey);
}

describe('jose contract used by verifyAppleToken', () => {
  it('verifies a well-formed token and exposes payload.sub', async () => {
    const { privateKey, jwks } = await makeKeyAndJwks();
    const token = await sign(privateKey as CryptoKey, { email: 'a@example.com' });

    const { payload } = await jwtVerify(token, jwks, {
      issuer: ISSUER,
      audience: AUDIENCE,
    });

    expect(payload.sub).toBe('apple-sub-1');
    expect(payload['email']).toBe('a@example.com');
  });

  it('rejects a wrong audience', async () => {
    const { privateKey, jwks } = await makeKeyAndJwks();
    const token = await sign(privateKey as CryptoKey, {});
    await expect(
      jwtVerify(token, jwks, { issuer: ISSUER, audience: 'com.someone.else' }),
    ).rejects.toThrow();
  });

  it('rejects a wrong issuer', async () => {
    const { privateKey, jwks } = await makeKeyAndJwks();
    const token = await sign(privateKey as CryptoKey, {});
    await expect(
      jwtVerify(token, jwks, { issuer: 'https://evil.example', audience: AUDIENCE }),
    ).rejects.toThrow();
  });

  it('rejects a token signed by a different key', async () => {
    const { privateKey } = await makeKeyAndJwks();
    const { jwks: otherJwks } = await makeKeyAndJwks();
    const token = await sign(privateKey as CryptoKey, {});
    await expect(
      jwtVerify(token, otherJwks, { issuer: ISSUER, audience: AUDIENCE }),
    ).rejects.toThrow();
  });

  it('rejects an expired token', async () => {
    const { privateKey, jwks } = await makeKeyAndJwks();
    const token = await new SignJWT({})
      .setProtectedHeader({ alg: 'RS256', kid: 'test-key' })
      .setIssuer(ISSUER)
      .setAudience(AUDIENCE)
      .setSubject('apple-sub-1')
      .setIssuedAt(Math.floor(Date.now() / 1000) - 3600)
      .setExpirationTime(Math.floor(Date.now() / 1000) - 60)
      .sign(privateKey as CryptoKey);

    await expect(
      jwtVerify(token, jwks, { issuer: ISSUER, audience: AUDIENCE }),
    ).rejects.toThrow();
  });
});
