import { describe, it, expect } from 'vitest';
import { loadConfig } from '../src/config.js';

const base = {
  DATABASE_URL: 'postgres://u:p@localhost:5432/db',
  DEV_AUTH_TOKEN: 'dev-token',
};

// Production refuses the local storage driver (R33), so booting prod configs need s3.
const s3 = {
  STORAGE_DRIVER: 's3',
  S3_ENDPOINT: 'https://r2.example.com',
  S3_BUCKET: 'worlds',
  S3_ACCESS_KEY_ID: 'ak',
  S3_SECRET_ACCESS_KEY: 'sk',
};

describe('loadConfig', () => {
  it('applies defaults', () => {
    const cfg = loadConfig(base as NodeJS.ProcessEnv);
    expect(cfg.PORT).toBe(8080);
    expect(cfg.AUTH_MODE).toBe('dev');
    expect(cfg.STORAGE_DRIVER).toBe('local');
    expect(cfg.PROVIDER_MODE).toBe('mock');
    expect(cfg.DAILY_CREDIT_BUDGET).toBe(2000); // fits one HQ (§10 R18)
    expect(cfg.DAILY_SCAN_QUOTA).toBe(10);
    expect(cfg.LOCAL_STORAGE_DIR).toBe('./data');
    expect(cfg.PUBLIC_BASE_URL).toBe('http://localhost:8080');
    expect(cfg.STITCHER_WIDTH).toBe(4096);
  });

  it('coerces numeric env vars', () => {
    const cfg = loadConfig(
      { ...base, PORT: '9090', DAILY_SCAN_QUOTA: '3', STITCHER_WIDTH: '8192' } as NodeJS.ProcessEnv,
    );
    expect(cfg.PORT).toBe(9090);
    expect(cfg.STITCHER_WIDTH).toBe(8192);
    expect(cfg.DAILY_SCAN_QUOTA).toBe(3);
  });

  it('requires DATABASE_URL', () => {
    expect(() => loadConfig({ DEV_AUTH_TOKEN: 'x' } as NodeJS.ProcessEnv)).toThrow(
      /DATABASE_URL/,
    );
  });

  it('requires DEV_AUTH_TOKEN in dev mode', () => {
    expect(() =>
      loadConfig({ DATABASE_URL: base.DATABASE_URL } as NodeJS.ProcessEnv),
    ).toThrow(/DEV_AUTH_TOKEN/);
  });

  // spec §10 R2 — AUTH_MODE defaults to 'dev', so a dropped env var must not
  // silently serve shared-token auth to production traffic.
  describe('dev auth in production', () => {
    it('refuses to boot with AUTH_MODE=dev under NODE_ENV=production', () => {
      expect(() =>
        loadConfig({ ...base, NODE_ENV: 'production' } as NodeJS.ProcessEnv),
      ).toThrow(/ALLOW_DEV_AUTH/);
    });

    it('refuses an explicitly-set AUTH_MODE=dev in production too', () => {
      expect(() =>
        loadConfig({
          ...base,
          NODE_ENV: 'production',
          AUTH_MODE: 'dev',
        } as NodeJS.ProcessEnv),
      ).toThrow(/refused under NODE_ENV=production/);
    });

    it('boots when ALLOW_DEV_AUTH=1 makes it a deliberate choice', () => {
      const cfg = loadConfig({
        ...base,
        ...s3,
        NODE_ENV: 'production',
        ALLOW_DEV_AUTH: '1',
      } as NodeJS.ProcessEnv);
      expect(cfg.AUTH_MODE).toBe('dev');
    });

    it('does not accept a truthy-but-not-1 ALLOW_DEV_AUTH', () => {
      expect(() =>
        loadConfig({
          ...base,
          NODE_ENV: 'production',
          ALLOW_DEV_AUTH: 'true',
        } as NodeJS.ProcessEnv),
      ).toThrow(/ALLOW_DEV_AUTH/);
    });

    it('allows dev auth outside production without the flag', () => {
      expect(
        loadConfig({ ...base, NODE_ENV: 'development' } as NodeJS.ProcessEnv).AUTH_MODE,
      ).toBe('dev');
      expect(loadConfig(base as NodeJS.ProcessEnv).AUTH_MODE).toBe('dev');
    });

    it('apple mode boots in production untouched', () => {
      const cfg = loadConfig({
        ...base,
        ...s3,
        NODE_ENV: 'production',
        AUTH_MODE: 'apple',
        APPLE_BUNDLE_ID: 'com.example.app',
      } as NodeJS.ProcessEnv);
      expect(cfg.AUTH_MODE).toBe('apple');
    });
  });

  // spec §10 R33 — the local driver serves /dev-storage unauthenticated.
  describe('local storage in production', () => {
    const prod = { ...base, NODE_ENV: 'production', ALLOW_DEV_AUTH: '1' };

    it('refuses the defaulted local driver', () => {
      expect(() => loadConfig(prod as NodeJS.ProcessEnv)).toThrow(
        /STORAGE_DRIVER=local refused/,
      );
    });

    it('refuses an explicit local driver too', () => {
      expect(() =>
        loadConfig({ ...prod, STORAGE_DRIVER: 'local' } as NodeJS.ProcessEnv),
      ).toThrow(/STORAGE_DRIVER=local refused/);
    });

    it('boots with s3', () => {
      expect(loadConfig({ ...prod, ...s3 } as NodeJS.ProcessEnv).STORAGE_DRIVER).toBe('s3');
    });
  });

  it('requires APPLE_BUNDLE_ID in apple mode', () => {
    expect(() =>
      loadConfig({ ...base, AUTH_MODE: 'apple' } as NodeJS.ProcessEnv),
    ).toThrow(/APPLE_BUNDLE_ID/);
  });

  it('requires S3 vars when driver is s3', () => {
    expect(() =>
      loadConfig({ ...base, STORAGE_DRIVER: 's3' } as NodeJS.ProcessEnv),
    ).toThrow(/S3_/);
  });

  it('accepts a complete s3 config', () => {
    const cfg = loadConfig({
      ...base,
      STORAGE_DRIVER: 's3',
      S3_ENDPOINT: 'https://r2.example.com',
      S3_BUCKET: 'worlds',
      S3_ACCESS_KEY_ID: 'ak',
      S3_SECRET_ACCESS_KEY: 'sk',
    } as NodeJS.ProcessEnv);
    expect(cfg.STORAGE_DRIVER).toBe('s3');
    expect(cfg.S3_BUCKET).toBe('worlds');
  });
});
