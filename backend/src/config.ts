import { z } from 'zod';
import { captureConfig } from './capture-config.js';
import {
  VIRTUMETRY_PROD_ENDPOINT_IDS,
  isDeniedBucket,
  isDeniedDbUrl,
  isPoolerUrl,
  neonEndpointId,
} from './isolation.js';

// Zod-validated environment loader. Validation runs on demand (loadConfig /
// getConfig) rather than at import time so tests can inject their own env and
// so importing a module never throws for a missing var.
//
// refine() is the single boot choke point: the server, the worker and
// migrate.ts all go through getConfig(), so every guard here covers all three.

const numberFromEnv = (def: number) =>
  z
    .string()
    .optional()
    .transform((v) => (v === undefined || v === '' ? def : Number(v)))
    .pipe(z.number().int().nonnegative());

// Scripted mock-provider behaviours (D-13); tests pick one per provider instance.
export const MOCK_SCENARIOS = [
  'happy',
  'failed',
  '402',
  '409',
  '429',
  '503',
  'duplicate_webhooks',
  'webhook_dropped',
] as const;

// Which committed fixture directory the mock serves (D-02). Fixed list: no env path is ever joined.
export const MOCK_OUTPUTS_SETS = ['default', 'demo-room'] as const;

const baseSchema = z.object({
  DATABASE_URL: z.string().min(1, 'DATABASE_URL is required'),
  // Direct (non-pooler) Neon host for src/migrate.ts only: its session-scoped
  // advisory lock is unreliable through the pgbouncer pooler. Required in
  // production (same endpoint as DATABASE_URL); optional elsewhere.
  MIGRATE_DATABASE_URL: z.string().min(1).optional(),
  PORT: numberFromEnv(8080),
  // Deployment environment. Only 'production' is load-bearing (see refine());
  // anything else is treated as a non-production run.
  NODE_ENV: z.string().optional(),
  // Set by Railway on every deployed service (dev included): the hardening
  // guards in refine() apply whenever it is present, not only in production.
  RAILWAY_ENVIRONMENT_ID: z.string().optional(),

  AUTH_MODE: z.enum(['dev', 'session', 'apple']).default('dev'),
  DEV_AUTH_TOKEN: z.string().optional(),
  APPLE_BUNDLE_ID: z.string().optional(),
  // Better Auth (AUTH_MODE=session, D-01/D-05). Secret >= 32 chars per env.
  BETTER_AUTH_SECRET: z.string().optional(),
  BETTER_AUTH_URL: z.string().optional(),
  // Comma-separated emails allowed to sign in (D-03). Empty = nobody.
  OWNER_ALLOWLIST: z.string().optional(),
  // '0' disables Better Auth's own limiter — tests only, refused in production.
  AUTH_RATE_LIMIT: z.string().optional(),

  STORAGE_DRIVER: z.enum(['local', 's3']).default('local'),
  LOCAL_STORAGE_DIR: z.string().default('./data'),
  // Base URL used to build dev-storage "presigned" links for the local driver.
  PUBLIC_BASE_URL: z.string().optional(),
  // Origin (no path) of the web share page (D-20/D-21): CORS allow-origin for
  // /v1/public/* and the /s/:slug redirect target. Unset = sharing answers 503.
  WEB_SHARE_ORIGIN: z.string().optional(),

  S3_ENDPOINT: z.string().optional(),
  S3_REGION: z.string().default('auto'),
  S3_BUCKET: z.string().optional(),
  S3_ACCESS_KEY_ID: z.string().optional(),
  S3_SECRET_ACCESS_KEY: z.string().optional(),

  PROVIDER_MODE: z.enum(['mock', 'live']).default('mock'),
  // Every real reconstruction costs money: PROVIDER_MODE=live boots only with
  // this set to exactly '1' (D-12).
  ALLOW_PAID_PROVIDER: z.string().optional(),
  // Live Echo-3 key: unread until Phase 6 (the mock never needs it).
  SPAITIAL_API_KEY: z.string().optional(),
  // HMAC secret for the provider webhook route (Phase 2: mock-signed webhooks).
  SPAITIAL_WEBHOOK_SECRET: z.string().optional(),
  // Mock provider: scenario for manual/dev runs and time-to-complete (D-13).
  MOCK_SCENARIO: z.enum(MOCK_SCENARIOS).default('happy'),
  MOCK_OUTPUTS_SET: z.enum(MOCK_OUTPUTS_SETS).default('default'),
  MOCK_PROCESSING_SECONDS: numberFromEnv(5),
  // How long the track job snoozes between provider status polls (D-16).
  TRACK_POLL_SECONDS: numberFromEnv(60),
  // Presigned GET TTL for the capture bundle handed to the provider (D-08: 24 h).
  BUNDLE_URL_TTL_SECONDS: numberFromEnv(86400),
  CLOUDFLARE_ACCOUNT_ID: z.string().optional(),
  CLOUDFLARE_API_TOKEN: z.string().optional(),

  // Daily spend cap enforced by the worker's reserveCredits guard.
  DAILY_CREDIT_BUDGET: numberFromEnv(2000),
  // Monthly (UTC) spend cap, checked alongside the daily one (D-18).
  // Default is an auto-mode resolution; owner to confirm before Phase 6.
  MONTHLY_CREDIT_BUDGET: numberFromEnv(10000),
  DAILY_SCAN_QUOTA: numberFromEnv(10),
  // D-08: optional JSON overriding capture thresholds (src/capture-config.ts).
  CAPTURE_CONFIG_JSON: z.string().optional(),

  // Worker loop poll interval (ms) between empty claim attempts.
  WORKER_POLL_MS: numberFromEnv(2000),

  // --- Rate limiting (spec §10 R10) -----------------------------------------
  // Window shared by every bucket below.
  RATE_LIMIT_WINDOW_MS: numberFromEnv(60_000),
  // Per AUTHENTICATED user. Must stay well clear of the app's Library poll of
  // GET /v1/worlds plus detail fetches.
  RATE_LIMIT_MAX: numberFromEnv(300),
  // Per IP, applied to everything including unauthenticated traffic. Higher than
  // the per-user cap because a NAT or an office egress is legitimately many users.
  RATE_LIMIT_IP_MAX: numberFromEnv(600),
  // POST /v1/worlds only. Each accepted call can become a billable generation,
  // and DAILY_SCAN_QUOTA is 10/day, so a minute's worth is deliberately tiny.
  RATE_LIMIT_CREATE_MAX: numberFromEnv(12),
  // FAILED authentications per IP per window before that IP is refused outright.
  AUTH_FAIL_MAX: numberFromEnv(20),
  // Per IP on the provider webhook route (unauthenticated until HMAC verifies).
  RATE_LIMIT_WEBHOOK_MAX: numberFromEnv(120),
  // Per IP on the public share routes (D-17/D-20, T-05-11).
  RATE_LIMIT_PUBLIC_MAX: numberFromEnv(60),
  RATE_LIMIT_SHARE_OPEN_MAX: numberFromEnv(20),
  RATE_LIMIT_LANDING_MAX: numberFromEnv(120),
  // Wrong share passwords per slug per window before that slug answers 429 (T-05-12).
  SHARE_FAIL_MAX: numberFromEnv(10),
  // Reverse-proxy hops in front of the API. req.ip — the key for the per-IP
  // buckets above — is taken that many hops from the right of X-Forwarded-For.
  // A hop count, not `true`: trusting the whole header lets a client pick its
  // own IP by prepending to it. 0 = no proxy (use the socket).
  TRUST_PROXY_HOPS: numberFromEnv(1),

  // Graceful shutdown budget (spec §10 R10). The API uses it as a hard ceiling
  // on draining in-flight HTTP requests; the worker as the deadline it gives the
  // in-flight job before exiting anyway. Keep it UNDER the platform's own
  // SIGTERM→SIGKILL window — this cannot outlive SIGKILL and must not try.
  SHUTDOWN_GRACE_MS: numberFromEnv(20000),

  // How often the worker sweeps for worlds stuck in `uploading` >24 h.
  REAPER_INTERVAL_MS: numberFromEnv(900000),
});

export type Config = z.infer<typeof baseSchema> & {
  PUBLIC_BASE_URL: string;
  /** True when PUBLIC_BASE_URL came from the env, not the localhost default. */
  PUBLIC_BASE_URL_EXPLICIT: boolean;
};

type DbVar = 'DATABASE_URL' | 'MIGRATE_DATABASE_URL';

/** Isolation checks for one connection string. Errors name the var, never the URL. */
function checkDbUrl(name: DbVar, url: string, isProd: boolean): void {
  let ep: string | null;
  let denied: boolean;
  try {
    ep = neonEndpointId(url);
    denied = isDeniedDbUrl(url);
  } catch {
    throw new Error(`${name} is not a valid connection URL`);
  }
  if (denied) {
    throw new Error(`${name} refused: denylisted host (src/isolation.ts)`);
  }
  if (!isProd && ep !== null && VIRTUMETRY_PROD_ENDPOINT_IDS.includes(ep)) {
    throw new Error(
      `${name} refused: Virtumetry production endpoint outside NODE_ENV=production`,
    );
  }
}

function refine(cfg: z.infer<typeof baseSchema>): Config {
  const isProd = cfg.NODE_ENV === 'production';
  captureConfig(cfg); // D-08: a malformed CAPTURE_CONFIG_JSON fails boot

  // --- Isolation first (D-08, D-09): fires even with NODE_ENV unset. --------
  checkDbUrl('DATABASE_URL', cfg.DATABASE_URL, isProd);
  if (cfg.MIGRATE_DATABASE_URL) {
    checkDbUrl('MIGRATE_DATABASE_URL', cfg.MIGRATE_DATABASE_URL, isProd);
  }
  if (cfg.S3_BUCKET) {
    if (isDeniedBucket(cfg.S3_BUCKET)) {
      throw new Error('S3_BUCKET refused: denylisted bucket (src/isolation.ts)');
    }
    if (!isProd && cfg.S3_BUCKET === 'virtumetry-prod') {
      throw new Error('S3_BUCKET=virtumetry-prod refused outside NODE_ENV=production');
    }
  }
  if (isProd && cfg.STORAGE_DRIVER === 's3' && cfg.S3_BUCKET !== 'virtumetry-prod') {
    throw new Error('NODE_ENV=production requires S3_BUCKET=virtumetry-prod');
  }

  // --- Paid provider (D-12). ------------------------------------------------
  if (cfg.PROVIDER_MODE === 'live' && cfg.ALLOW_PAID_PROVIDER !== '1') {
    throw new Error('PROVIDER_MODE=live refused: set ALLOW_PAID_PROVIDER=1 to spend money deliberately');
  }

  // S3 driver requires its credentials; local driver does not.
  if (cfg.STORAGE_DRIVER === 's3') {
    const missing = (
      ['S3_ENDPOINT', 'S3_BUCKET', 'S3_ACCESS_KEY_ID', 'S3_SECRET_ACCESS_KEY'] as const
    ).filter((k) => !cfg[k]);
    if (missing.length > 0) {
      throw new Error(`STORAGE_DRIVER=s3 requires: ${missing.join(', ')}`);
    }
  }
  // Apple auth needs an audience; dev auth needs a shared token.
  if (cfg.AUTH_MODE === 'apple' && !cfg.APPLE_BUNDLE_ID) {
    throw new Error('AUTH_MODE=apple requires APPLE_BUNDLE_ID');
  }
  if (cfg.AUTH_MODE === 'dev' && !cfg.DEV_AUTH_TOKEN) {
    throw new Error('AUTH_MODE=dev requires DEV_AUTH_TOKEN');
  }
  if (cfg.AUTH_MODE === 'session') {
    if (!cfg.BETTER_AUTH_SECRET || cfg.BETTER_AUTH_SECRET.length < 32) {
      throw new Error('AUTH_MODE=session requires BETTER_AUTH_SECRET (at least 32 characters)');
    }
    if (!cfg.BETTER_AUTH_URL || !URL.canParse(cfg.BETTER_AUTH_URL)) {
      throw new Error('AUTH_MODE=session requires BETTER_AUTH_URL (a valid URL)');
    }
  }

  // Dev auth in production (D-12). AUTH_MODE defaults to 'dev', so a dropped
  // env var must never serve shared-token auth. No escape hatch.
  if (isProd && cfg.AUTH_MODE === 'dev') {
    throw new Error('AUTH_MODE=dev refused under NODE_ENV=production: set AUTH_MODE=session');
  }

  // Share URLs (D-20/D-21): format-checked only when set. Never required at
  // boot — a missing var degrades sharing to 503 share_unavailable instead.
  if (cfg.WEB_SHARE_ORIGIN !== undefined) {
    if (!URL.canParse(cfg.WEB_SHARE_ORIGIN)) throw new Error('WEB_SHARE_ORIGIN must be a valid URL');
    if (new URL(cfg.WEB_SHARE_ORIGIN).origin !== cfg.WEB_SHARE_ORIGIN.replace(/\/$/, '')) {
      throw new Error('WEB_SHARE_ORIGIN must be an origin (scheme://host[:port], no path)');
    }
  }
  if (cfg.PUBLIC_BASE_URL !== undefined && !URL.canParse(cfg.PUBLIC_BASE_URL)) {
    throw new Error('PUBLIC_BASE_URL must be a valid URL');
  }

  // Any public deployment (production, or the Railway dev env with NODE_ENV=
  // development so exp:// stays trusted) holds a real owner credential (WR-05).
  if (isProd || cfg.RAILWAY_ENVIRONMENT_ID) {
    const where = isProd ? 'NODE_ENV=production' : 'a deployed (Railway) service';
    if (cfg.DEV_AUTH_TOKEN) {
      throw new Error(`DEV_AUTH_TOKEN refused under ${where}: unset it`);
    }
    // Better Auth's sign-in limiter is the brute-force guard (D-06).
    if (cfg.AUTH_RATE_LIMIT === '0') {
      throw new Error(`AUTH_RATE_LIMIT=0 refused under ${where}: unset it`);
    }
    // Session cookies must only ever travel over TLS.
    if (cfg.AUTH_MODE === 'session' && !cfg.BETTER_AUTH_URL?.startsWith('https://')) {
      throw new Error(`BETTER_AUTH_URL must be https under ${where}`);
    }
    if (cfg.WEB_SHARE_ORIGIN !== undefined && !cfg.WEB_SHARE_ORIGIN.startsWith('https://')) {
      throw new Error(`WEB_SHARE_ORIGIN must be https under ${where}`);
    }
    if (cfg.PUBLIC_BASE_URL !== undefined && !cfg.PUBLIC_BASE_URL.startsWith('https://')) {
      throw new Error(`PUBLIC_BASE_URL must be https under ${where}`);
    }
    // The local driver's /dev-storage route serves objects unauthenticated.
    if (cfg.STORAGE_DRIVER === 'local') {
      throw new Error(`STORAGE_DRIVER=local refused under ${where}: set STORAGE_DRIVER=s3`);
    }
  }

  if (isProd) {
    // Migrations over the direct host of the same endpoint (D-07, D-13).
    // Only the migrator needs it (api preDeploy); migrateUrl() requires it there,
    // so the worker and api runtime boot without it.
    if (cfg.MIGRATE_DATABASE_URL && isPoolerUrl(cfg.MIGRATE_DATABASE_URL)) {
      throw new Error('MIGRATE_DATABASE_URL refused: must be the direct host, not the -pooler host');
    }
    if (
      cfg.MIGRATE_DATABASE_URL &&
      neonEndpointId(cfg.MIGRATE_DATABASE_URL) !== neonEndpointId(cfg.DATABASE_URL)
    ) {
      throw new Error('MIGRATE_DATABASE_URL refused: must be the same Neon endpoint as DATABASE_URL');
    }
  }

  return {
    ...cfg,
    WEB_SHARE_ORIGIN: cfg.WEB_SHARE_ORIGIN?.replace(/\/$/, ''),
    PUBLIC_BASE_URL: (cfg.PUBLIC_BASE_URL ?? `http://localhost:${cfg.PORT}`).replace(/\/$/, ''),
    PUBLIC_BASE_URL_EXPLICIT: cfg.PUBLIC_BASE_URL !== undefined,
  };
}

/**
 * The URL migrate.ts connects with. Production must use the direct host
 * (refine() already checked it is non-pooler and same-endpoint when set);
 * elsewhere DATABASE_URL is an acceptable stand-in.
 */
export function migrateUrl(cfg: Config): string {
  if (cfg.MIGRATE_DATABASE_URL) return cfg.MIGRATE_DATABASE_URL;
  if (cfg.NODE_ENV === 'production') {
    throw new Error('MIGRATE_DATABASE_URL is required under NODE_ENV=production');
  }
  return cfg.DATABASE_URL;
}

/** Validate an env object into a typed Config. Throws on invalid input. */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = baseSchema.safeParse(env);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `${i.path.join('.')}: ${i.message}`)
      .join('; ');
    throw new Error(`Invalid environment: ${issues}`);
  }
  return refine(parsed.data);
}

let cached: Config | undefined;

/** Memoized config for the running process. */
export function getConfig(): Config {
  if (!cached) cached = loadConfig();
  return cached;
}

/** Test hook — clears the memoized config. */
export function resetConfigCache(): void {
  cached = undefined;
}
