import { describe, it, expect } from 'vitest';
import { loadConfig, migrateUrl } from '../src/config.js';

const env = (o: Record<string, string | undefined>) => o as NodeJS.ProcessEnv;

const pooled = (ep: string, region = 'us-west-2') =>
  `postgres://u:p@${ep}-pooler.c-1.${region}.aws.neon.tech/neondb?sslmode=require`;
const direct = (ep: string, region = 'us-west-2') =>
  `postgres://u:p@${ep}.c-1.${region}.aws.neon.tech/neondb?sslmode=require`;

const PROD_EP = 'ep-cold-bread-arwg787p'; // must equal src/isolation.ts VIRTUMETRY_PROD_ENDPOINT_IDS
const DEV_EP = 'ep-mute-fog-arwonnkz';
const VS_EP = 'ep-withered-paper-ajlntp59';

const base = {
  DATABASE_URL: 'postgres://u:p@localhost:5432/db',
  DEV_AUTH_TOKEN: 'dev-token',
};

const s3 = (bucket: string) => ({
  STORAGE_DRIVER: 's3',
  S3_ENDPOINT: 'https://a.r2.cloudflarestorage.com',
  S3_BUCKET: bucket,
  S3_ACCESS_KEY_ID: 'ak',
  S3_SECRET_ACCESS_KEY: 'sk',
});

// A complete, valid production config.
const prodBase = {
  NODE_ENV: 'production',
  AUTH_MODE: 'apple',
  APPLE_BUNDLE_ID: 'com.example.app',
  DATABASE_URL: pooled(PROD_EP),
  MIGRATE_DATABASE_URL: direct(PROD_EP),
  ...s3('virtumetry-prod'),
};

// What backend/.env looks like locally.
const devLocal = {
  DATABASE_URL: pooled(DEV_EP),
  MIGRATE_DATABASE_URL: direct(DEV_EP),
  AUTH_MODE: 'dev',
  DEV_AUTH_TOKEN: 'dev-token',
  ...s3('virtumetry-dev'),
};

describe('loadConfig', () => {
  it('applies defaults', () => {
    const cfg = loadConfig(env(base));
    expect(cfg.PORT).toBe(8080);
    expect(cfg.AUTH_MODE).toBe('dev');
    expect(cfg.STORAGE_DRIVER).toBe('local');
    expect(cfg.PROVIDER_MODE).toBe('mock');
    expect(cfg.DAILY_CREDIT_BUDGET).toBe(2000);
    expect(cfg.DAILY_SCAN_QUOTA).toBe(10);
    expect(cfg.LOCAL_STORAGE_DIR).toBe('./data');
    expect(cfg.PUBLIC_BASE_URL).toBe('http://localhost:8080');
  });

  it('applies Phase 2 defaults', () => {
    const cfg = loadConfig(env(base));
    expect(cfg.MONTHLY_CREDIT_BUDGET).toBe(10000);
    expect(cfg.MOCK_SCENARIO).toBe('happy');
    expect(cfg.MOCK_PROCESSING_SECONDS).toBe(5);
    expect(cfg.TRACK_POLL_SECONDS).toBe(60);
    expect(cfg.BUNDLE_URL_TTL_SECONDS).toBe(86400);
    expect(cfg.RATE_LIMIT_WEBHOOK_MAX).toBe(120);
  });

  it('MOCK_OUTPUTS_SET defaults to default, accepts demo-room, rejects unknown sets', () => {
    expect(loadConfig(env(base)).MOCK_OUTPUTS_SET).toBe('default');
    expect(loadConfig(env({ ...base, MOCK_OUTPUTS_SET: 'demo-room' })).MOCK_OUTPUTS_SET).toBe('demo-room');
    expect(() => loadConfig(env({ ...base, MOCK_OUTPUTS_SET: 'nope' }))).toThrow(/MOCK_OUTPUTS_SET/);
  });

  it('accepts every mock scenario and rejects unknown ones', () => {
    expect(loadConfig(env({ ...base, MOCK_SCENARIO: '429' })).MOCK_SCENARIO).toBe('429');
    expect(() => loadConfig(env({ ...base, MOCK_SCENARIO: 'explode' }))).toThrow(/MOCK_SCENARIO/);
  });

  it('coerces numeric env vars', () => {
    const cfg = loadConfig(env({ ...base, PORT: '9090', DAILY_SCAN_QUOTA: '3' }));
    expect(cfg.PORT).toBe(9090);
    expect(cfg.DAILY_SCAN_QUOTA).toBe(3);
  });

  it('stores the SpAItial / Cloudflare names without requiring them', () => {
    const cfg = loadConfig(env({ ...base, SPAITIAL_API_KEY: 'k', CLOUDFLARE_ACCOUNT_ID: 'c' }));
    expect(cfg.SPAITIAL_API_KEY).toBe('k');
    expect(cfg.CLOUDFLARE_ACCOUNT_ID).toBe('c');
  });

  it('requires DATABASE_URL', () => {
    expect(() => loadConfig(env({ DEV_AUTH_TOKEN: 'x' }))).toThrow(/DATABASE_URL/);
  });

  it('requires DEV_AUTH_TOKEN in dev mode', () => {
    expect(() => loadConfig(env({ DATABASE_URL: base.DATABASE_URL }))).toThrow(/DEV_AUTH_TOKEN/);
  });

  it('requires APPLE_BUNDLE_ID in apple mode', () => {
    expect(() => loadConfig(env({ ...base, AUTH_MODE: 'apple' }))).toThrow(/APPLE_BUNDLE_ID/);
  });

  it('requires S3 vars when driver is s3', () => {
    expect(() => loadConfig(env({ ...base, STORAGE_DRIVER: 's3' }))).toThrow(/S3_/);
  });

  it('prodBase boots', () => {
    const cfg = loadConfig(env(prodBase));
    expect(cfg.AUTH_MODE).toBe('apple');
    expect(cfg.S3_BUCKET).toBe('virtumetry-prod');
  });

  it('a dev-branch local config boots', () => {
    const cfg = loadConfig(env(devLocal));
    expect(cfg.AUTH_MODE).toBe('dev');
    expect(cfg.S3_BUCKET).toBe('virtumetry-dev');
  });

  describe('paid provider (D-12)', () => {
    it('refuses PROVIDER_MODE=live without ALLOW_PAID_PROVIDER', () => {
      expect(() => loadConfig(env({ ...base, PROVIDER_MODE: 'live' }))).toThrow(/ALLOW_PAID_PROVIDER/);
    });

    it("does not accept ALLOW_PAID_PROVIDER='true'", () => {
      expect(() =>
        loadConfig(env({ ...base, PROVIDER_MODE: 'live', ALLOW_PAID_PROVIDER: 'true' })),
      ).toThrow(/ALLOW_PAID_PROVIDER/);
    });

    // Literal fakes only: these never reach a network (the client is not built).
    const live = {
      ...base,
      PROVIDER_MODE: 'live',
      ALLOW_PAID_PROVIDER: '1',
      SPAITIAL_API_KEY: 'spt_live_test',
      SPAITIAL_WEBHOOK_SECRET: 'whsec_test',
    };

    it('boots live with ALLOW_PAID_PROVIDER=1 + both secrets outside production', () => {
      const cfg = loadConfig(env(live));
      expect(cfg.PROVIDER_MODE).toBe('live');
      expect(cfg.SPAITIAL_BASE_URL).toBe('https://api.spaitial.ai');
    });

    it.each(['SPAITIAL_API_KEY', 'SPAITIAL_WEBHOOK_SECRET'])('refuses live without %s, naming it', (k) => {
      expect(() => loadConfig(env({ ...live, [k]: undefined }))).toThrow(new RegExp(`missing.*${k}`));
    });

    it('error messages never echo secret values', () => {
      expect(() => loadConfig(env({ ...live, SPAITIAL_WEBHOOK_SECRET: undefined }))).toThrow(
        /^(?!.*spt_live_test).*$/s,
      );
    });

    it('refuses live with a non-https SPAITIAL_BASE_URL', () => {
      expect(() => loadConfig(env({ ...live, SPAITIAL_BASE_URL: 'http://x' }))).toThrow(/SPAITIAL_BASE_URL/);
    });

    it('refuses live with BUNDLE_URL_TTL_SECONDS < 9000', () => {
      expect(() => loadConfig(env({ ...live, BUNDLE_URL_TTL_SECONDS: '3600' }))).toThrow(
        /BUNDLE_URL_TTL_SECONDS/,
      );
    });

    it('mock mode boots with no SpAItial vars set', () => {
      expect(loadConfig(env(base)).PROVIDER_MODE).toBe('mock');
    });
  });

  describe('BUDGET_ALERT_SHARE', () => {
    it.each([
      [undefined, 0.8],
      ['0.5', 0.5],
      ['1', 1],
    ])('%s -> %s', (v, want) => {
      expect(loadConfig(env({ ...base, BUDGET_ALERT_SHARE: v })).BUDGET_ALERT_SHARE).toBe(want);
    });

    it.each(['0', '1.5', 'abc'])('rejects %s', (v) => {
      expect(() => loadConfig(env({ ...base, BUDGET_ALERT_SHARE: v }))).toThrow(/BUDGET_ALERT_SHARE/);
    });
  });

  describe('HARD MONEY RULE fetch guard (setup-no-spaitial.ts)', () => {
    it.each(['https://api.spaitial.ai/v1/captures/limits', 'https://docs.spaitial.ai/x'])(
      'blocks %s before any socket',
      async (url) => {
        await expect(fetch(url)).rejects.toThrow(/HARD MONEY RULE.*spaitial/);
      },
    );
  });

  describe('dev auth in production (D-12)', () => {
    it('refuses AUTH_MODE=dev under production', () => {
      expect(() =>
        loadConfig(env({ ...prodBase, AUTH_MODE: 'dev', DEV_AUTH_TOKEN: 't' })),
      ).toThrow(/AUTH_MODE=dev refused/);
    });

    it('refuses AUTH_MODE=dev under production even with ALLOW_DEV_AUTH=1 (hatch gone)', () => {
      expect(() =>
        loadConfig(env({ ...prodBase, AUTH_MODE: 'dev', DEV_AUTH_TOKEN: 't', ALLOW_DEV_AUTH: '1' })),
      ).toThrow(/AUTH_MODE=dev refused/);
    });

    it('refuses DEV_AUTH_TOKEN set under production with AUTH_MODE=apple', () => {
      expect(() => loadConfig(env({ ...prodBase, DEV_AUTH_TOKEN: 't' }))).toThrow(/DEV_AUTH_TOKEN/);
    });

    it('allows dev auth outside production', () => {
      expect(loadConfig(env({ ...base, NODE_ENV: 'development' })).AUTH_MODE).toBe('dev');
    });
  });

  describe('local storage in production', () => {
    it('refuses the local driver', () => {
      expect(() => loadConfig(env({ ...prodBase, STORAGE_DRIVER: 'local' }))).toThrow(
        /STORAGE_DRIVER=local refused/,
      );
    });
  });

  describe('VirtSpace isolation (D-08)', () => {
    for (const nodeEnv of [undefined, 'production']) {
      const tag = nodeEnv ?? 'unset';
      it(`refuses the VirtSpace endpoint as DATABASE_URL (pooled/direct), NODE_ENV ${tag}`, () => {
        for (const url of [pooled(VS_EP, 'us-east-2'), direct(VS_EP, 'us-east-2')]) {
          const e = nodeEnv ? { ...prodBase, DATABASE_URL: url } : { ...base, DATABASE_URL: url };
          expect(() => loadConfig(env(e))).toThrow(/DATABASE_URL.*denylisted/);
        }
      });

      it(`refuses the VirtSpace endpoint as MIGRATE_DATABASE_URL, NODE_ENV ${tag}`, () => {
        for (const url of [pooled(VS_EP, 'us-east-2'), direct(VS_EP, 'us-east-2')]) {
          const e = nodeEnv
            ? { ...prodBase, MIGRATE_DATABASE_URL: url }
            : { ...base, MIGRATE_DATABASE_URL: url };
          expect(() => loadConfig(env(e))).toThrow(/MIGRATE_DATABASE_URL.*denylisted/);
        }
      });
    }

    it('refuses the VirtSpace endpoint id even outside the us-east-2 suffix', () => {
      expect(() => loadConfig(env({ ...base, DATABASE_URL: direct(VS_EP) }))).toThrow(/denylisted/);
    });

    it('refuses any us-east-2 Neon host', () => {
      expect(() =>
        loadConfig(env({ ...base, DATABASE_URL: pooled('ep-some-other-123', 'us-east-2') })),
      ).toThrow(/denylisted/);
    });

    it('does not echo the URL in the error', () => {
      expect(() =>
        loadConfig(env({ ...base, DATABASE_URL: pooled(VS_EP, 'us-east-2') })),
      ).toThrow(/^(?!.*u:p@).*$/s);
    });
  });

  describe('Virtumetry production endpoint outside production (D-08)', () => {
    for (const nodeEnv of [undefined, 'development', 'test']) {
      it(`refuses the prod endpoint with NODE_ENV ${nodeEnv ?? 'unset'}`, () => {
        for (const url of [pooled(PROD_EP), direct(PROD_EP)]) {
          expect(() => loadConfig(env({ ...base, NODE_ENV: nodeEnv, DATABASE_URL: url }))).toThrow(
            /production endpoint/,
          );
          expect(() =>
            loadConfig(env({ ...base, NODE_ENV: nodeEnv, MIGRATE_DATABASE_URL: url })),
          ).toThrow(/production endpoint/);
        }
      });
    }
  });

  describe('MIGRATE_DATABASE_URL in production (D-07, D-13)', () => {
    it('boots server/worker without MIGRATE_DATABASE_URL (only the migrator needs it)', () => {
      expect(() => loadConfig(env({ ...prodBase, MIGRATE_DATABASE_URL: undefined }))).not.toThrow();
    });

    it('migrateUrl refuses a missing MIGRATE_DATABASE_URL in production', () => {
      const cfg = loadConfig(env({ ...prodBase, MIGRATE_DATABASE_URL: undefined }));
      expect(() => migrateUrl(cfg)).toThrow(/MIGRATE_DATABASE_URL is required/);
    });

    it('migrateUrl returns the direct URL in production and DATABASE_URL elsewhere', () => {
      expect(migrateUrl(loadConfig(env(prodBase)))).toBe(direct(PROD_EP));
      expect(migrateUrl(loadConfig(env(base)))).toBe(base.DATABASE_URL);
    });

    it('refuses a -pooler MIGRATE_DATABASE_URL', () => {
      expect(() => loadConfig(env({ ...prodBase, MIGRATE_DATABASE_URL: pooled(PROD_EP) }))).toThrow(
        /MIGRATE_DATABASE_URL.*pooler/,
      );
    });

    it('refuses a MIGRATE endpoint different from the DATABASE endpoint', () => {
      expect(() =>
        loadConfig(env({ ...prodBase, MIGRATE_DATABASE_URL: direct('ep-other-west-999') })),
      ).toThrow(/MIGRATE_DATABASE_URL.*same Neon endpoint/);
    });
  });

  describe('bucket guards (D-09)', () => {
    for (const bucket of ['virtspace-assets', 'VirtSpace-Worlds', 'my-virtspace']) {
      it(`refuses bucket ${bucket} in any env`, () => {
        expect(() => loadConfig(env({ ...base, ...s3(bucket) }))).toThrow(/S3_BUCKET/);
        expect(() => loadConfig(env({ ...prodBase, S3_BUCKET: bucket }))).toThrow(/S3_BUCKET/);
      });
    }

    it('refuses virtumetry-prod outside production', () => {
      expect(() => loadConfig(env({ ...base, ...s3('virtumetry-prod') }))).toThrow(/S3_BUCKET/);
    });

    it('production with s3 requires S3_BUCKET=virtumetry-prod', () => {
      expect(() => loadConfig(env({ ...prodBase, S3_BUCKET: 'virtumetry-dev' }))).toThrow(/S3_BUCKET/);
    });
  });
});

describe('AUTH_MODE=session (D-05)', () => {
  const SECRET = 'x'.repeat(32);
  const session = {
    DATABASE_URL: 'postgres://u:p@localhost:5432/db',
    AUTH_MODE: 'session',
    BETTER_AUTH_SECRET: SECRET,
    BETTER_AUTH_URL: 'http://localhost:8080',
  };
  const prodSession = {
    ...prodBase,
    AUTH_MODE: 'session',
    APPLE_BUNDLE_ID: undefined,
    BETTER_AUTH_SECRET: SECRET,
    BETTER_AUTH_URL: 'https://api.example.com',
  };

  it('loads outside production with secret + URL, no DEV_AUTH_TOKEN needed', () => {
    expect(loadConfig(env(session)).AUTH_MODE).toBe('session');
  });

  it('requires BETTER_AUTH_SECRET, at least 32 chars, without echoing it', () => {
    expect(() => loadConfig(env({ ...session, BETTER_AUTH_SECRET: undefined }))).toThrow(
      /BETTER_AUTH_SECRET/,
    );
    const short = 'y'.repeat(31);
    let msg = '';
    try {
      loadConfig(env({ ...session, BETTER_AUTH_SECRET: short }));
    } catch (e) {
      msg = (e as Error).message;
    }
    expect(msg).toMatch(/BETTER_AUTH_SECRET/);
    expect(msg).not.toContain(short);
  });

  it('requires a parseable BETTER_AUTH_URL', () => {
    expect(() => loadConfig(env({ ...session, BETTER_AUTH_URL: undefined }))).toThrow(
      /BETTER_AUTH_URL/,
    );
    expect(() => loadConfig(env({ ...session, BETTER_AUTH_URL: 'not a url' }))).toThrow(
      /BETTER_AUTH_URL/,
    );
  });

  it('loads in production with secret + https URL + s3', () => {
    expect(loadConfig(env(prodSession)).AUTH_MODE).toBe('session');
  });

  it('production refuses dev mode and points at AUTH_MODE=session', () => {
    expect(() =>
      loadConfig(env({ ...prodSession, AUTH_MODE: 'dev', DEV_AUTH_TOKEN: 't' })),
    ).toThrow(/AUTH_MODE=session/);
  });

  it('production refuses DEV_AUTH_TOKEN in session mode', () => {
    expect(() => loadConfig(env({ ...prodSession, DEV_AUTH_TOKEN: 't' }))).toThrow(
      /DEV_AUTH_TOKEN/,
    );
  });

  it("production refuses AUTH_RATE_LIMIT='0'", () => {
    expect(() => loadConfig(env({ ...prodSession, AUTH_RATE_LIMIT: '0' }))).toThrow(
      /AUTH_RATE_LIMIT/,
    );
  });

  // WR-05: the Railway dev env runs NODE_ENV=development but is public.
  describe('deployed dev (RAILWAY_ENVIRONMENT_ID set, NODE_ENV=development)', () => {
    const railwayDev = {
      NODE_ENV: 'development',
      RAILWAY_ENVIRONMENT_ID: 'env-id',
      DATABASE_URL: pooled(DEV_EP),
      AUTH_MODE: 'session',
      BETTER_AUTH_SECRET: SECRET,
      BETTER_AUTH_URL: 'https://api-dev.example.com',
      ...s3('virtumetry-dev'),
    };
    it('loads when hardened', () => {
      expect(loadConfig(env(railwayDev)).AUTH_MODE).toBe('session');
    });
    it.each([
      [{ AUTH_RATE_LIMIT: '0' }, /AUTH_RATE_LIMIT/],
      [{ DEV_AUTH_TOKEN: 't' }, /DEV_AUTH_TOKEN/],
      [{ BETTER_AUTH_URL: 'http://api-dev.example.com' }, /BETTER_AUTH_URL/],
      [{ STORAGE_DRIVER: 'local' }, /STORAGE_DRIVER=local/],
    ])('refuses %o', (bad, msg) => {
      expect(() => loadConfig(env({ ...railwayDev, ...bad }))).toThrow(msg);
    });
  });

  it('production refuses a non-https BETTER_AUTH_URL', () => {
    expect(() =>
      loadConfig(env({ ...prodSession, BETTER_AUTH_URL: 'http://api.example.com' })),
    ).toThrow(/BETTER_AUTH_URL/);
  });
});

describe('share URLs (D-20/D-21)', () => {
  const railwayDev = {
    NODE_ENV: 'development',
    RAILWAY_ENVIRONMENT_ID: 'env-id',
    DATABASE_URL: pooled(DEV_EP),
    AUTH_MODE: 'session',
    BETTER_AUTH_SECRET: 'x'.repeat(48),
    BETTER_AUTH_URL: 'https://api-dev.example.com',
    ...s3('virtumetry-dev'),
  };

  it('accepts an https origin and strips a trailing slash', () => {
    expect(loadConfig(env({ ...base, WEB_SHARE_ORIGIN: 'https://share.example.com/' })).WEB_SHARE_ORIGIN).toBe(
      'https://share.example.com',
    );
  });

  it('rejects a non-URL or an origin with a path', () => {
    expect(() => loadConfig(env({ ...base, WEB_SHARE_ORIGIN: 'not a url' }))).toThrow(/WEB_SHARE_ORIGIN/);
    expect(() => loadConfig(env({ ...base, WEB_SHARE_ORIGIN: 'https://a.example.com/r' }))).toThrow(
      /WEB_SHARE_ORIGIN/,
    );
  });

  it('allows http://localhost locally', () => {
    expect(loadConfig(env({ ...base, WEB_SHARE_ORIGIN: 'http://localhost:8081' })).WEB_SHARE_ORIGIN).toBe(
      'http://localhost:8081',
    );
  });

  it('requires https when set on Railway', () => {
    expect(() => loadConfig(env({ ...railwayDev, WEB_SHARE_ORIGIN: 'http://share.example.com' }))).toThrow(
      /WEB_SHARE_ORIGIN/,
    );
    expect(() => loadConfig(env({ ...railwayDev, PUBLIC_BASE_URL: 'http://api.example.com' }))).toThrow(
      /PUBLIC_BASE_URL/,
    );
  });

  it('boots on Railway with neither var set (sharing degrades to 503, no crash loop)', () => {
    const cfg = loadConfig(env(railwayDev));
    expect(cfg.WEB_SHARE_ORIGIN).toBeUndefined();
    expect(cfg.PUBLIC_BASE_URL_EXPLICIT).toBe(false);
  });

  it('marks an env-provided PUBLIC_BASE_URL as explicit', () => {
    expect(
      loadConfig(env({ ...railwayDev, PUBLIC_BASE_URL: 'https://api-dev.example.com' })).PUBLIC_BASE_URL_EXPLICIT,
    ).toBe(true);
  });
});
