import { describe, it, expect, afterEach, vi } from 'vitest';
import { getPool, closeDb, POOL_OPTIONS, withVerifyFullSslMode } from '../src/db/client.js';
import { resetConfigCache } from '../src/config.js';

// Spec §10 R28. Creating the pool does not connect, so no database is needed.

describe('getPool', () => {
  afterEach(async () => {
    await closeDb();
    resetConfigCache();
  });

  it('has an idle-error listener and the timeout options', () => {
    process.env['DATABASE_URL'] = 'postgres://u:p@localhost:5432/db';
    process.env['DEV_AUTH_TOKEN'] ??= 't';
    resetConfigCache();
    const pool = getPool();
    expect(pool.listenerCount('error')).toBe(1);
    expect(pool.options).toMatchObject(POOL_OPTIONS);
    // Emitting must not throw (it would, with no listener).
    expect(() => pool.emit('error', new Error('idle drop'))).not.toThrow();
  });
});

describe('withVerifyFullSslMode (R33)', () => {
  const h = 'postgres://u:p@ep-x-pooler.neon.tech/db';

  it.each(['prefer', 'require', 'verify-ca'])('rewrites sslmode=%s to verify-full', (mode) => {
    expect(withVerifyFullSslMode(`${h}?sslmode=${mode}&channel_binding=require`)).toBe(
      `${h}?sslmode=verify-full&channel_binding=require`,
    );
    expect(withVerifyFullSslMode(`${h}?a=1&sslmode=${mode}`)).toBe(`${h}?a=1&sslmode=verify-full`);
  });

  it.each([
    h,
    `${h}?sslmode=disable`,
    `${h}?sslmode=no-verify`,
    `${h}?sslmode=verify-full`,
    `${h}?sslmode=require&uselibpqcompat=true`,
  ])('leaves %s alone', (url) => {
    expect(withVerifyFullSslMode(url)).toBe(url);
  });

  it('the rewritten URL parses to a verifying TLS config with no warning', async () => {
    const { parse } = await import('pg-connection-string');
    const warn = vi.spyOn(process, 'emitWarning');
    const cfg = parse(withVerifyFullSslMode(`${h}?sslmode=require`));
    expect(cfg.ssl).toEqual({}); // {} = pg's default rejectUnauthorized + hostname check
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });
});
