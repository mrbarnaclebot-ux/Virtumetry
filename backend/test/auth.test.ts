import { describe, it, expect } from 'vitest';
import { parseDevAuth, secretEquals } from '../src/auth.js';

const TOKEN = 'secret-dev-token';

// spec §10 R2 — the shared dev token must be compared in constant time, and the
// comparison must survive mismatched lengths without throwing.
describe('secretEquals', () => {
  it('is true only for an exact match', () => {
    expect(secretEquals(TOKEN, TOKEN)).toBe(true);
    expect(secretEquals(TOKEN, 'secret-dev-toked')).toBe(false);
  });

  it('is length-safe: a prefix or a longer string returns false, never throws', () => {
    expect(secretEquals(TOKEN, 'secret')).toBe(false);
    expect(secretEquals('secret', TOKEN)).toBe(false);
    expect(secretEquals(TOKEN, `${TOKEN}-extra`)).toBe(false);
    expect(secretEquals('', TOKEN)).toBe(false);
    expect(secretEquals('', '')).toBe(true);
  });

  it('handles multi-byte characters by byte value', () => {
    expect(secretEquals('tökén', 'tökén')).toBe(true);
    expect(secretEquals('tökén', 'token')).toBe(false);
  });
});

describe('parseDevAuth', () => {
  it('accepts a valid bearer token + x-dev-user', () => {
    const res = parseDevAuth(
      { authorization: `Bearer ${TOKEN}`, 'x-dev-user': 'alice@example.com' },
      TOKEN,
    );
    expect(res).toEqual({
      ok: true,
      subject: 'alice@example.com',
      displayName: 'alice@example.com',
    });
  });

  it('rejects a missing Authorization header', () => {
    const res = parseDevAuth({ 'x-dev-user': 'alice' }, TOKEN);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.status).toBe(401);
  });

  it('rejects a wrong bearer token', () => {
    const res = parseDevAuth(
      { authorization: 'Bearer nope', 'x-dev-user': 'alice' },
      TOKEN,
    );
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.status).toBe(401);
  });

  it('rejects a token that is a prefix of the real one (length-safe compare)', () => {
    const res = parseDevAuth(
      { authorization: 'Bearer secret-dev', 'x-dev-user': 'alice' },
      TOKEN,
    );
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.status).toBe(401);
  });

  it('rejects a missing x-dev-user header', () => {
    const res = parseDevAuth({ authorization: `Bearer ${TOKEN}` }, TOKEN);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.status).toBe(401);
  });

  it('errors 500 when no dev token is configured', () => {
    const res = parseDevAuth({ authorization: 'Bearer x' }, undefined);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.status).toBe(500);
  });
});
