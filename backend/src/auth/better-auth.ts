import { betterAuth } from 'better-auth';
import { drizzleAdapter } from 'better-auth/adapters/drizzle';
import { APIError, createAuthMiddleware } from 'better-auth/api';
import { expo } from '@better-auth/expo';
import type { Config } from '../config.js';
import type { Db } from '../db/client.js';
import { user, session, account, verification } from '../db/schema.js';

// Better Auth factory (D-01). Email + password for allowlisted owners only:
// sign-up is disabled (D-02) and sign-in is gated on OWNER_ALLOWLIST (D-03).

/** Comma-separated emails → lowercase set. Empty/undefined = nobody. */
export function parseAllowlist(raw?: string): Set<string> {
  return new Set(
    (raw ?? '')
      .split(',')
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean),
  );
}

export function isAllowlisted(allow: Set<string>, email: string | null | undefined): boolean {
  return !!email && allow.has(email.trim().toLowerCase());
}

export function createAuth({ db, config }: { db: Db; config: Config }) {
  const allow = parseAllowlist(config.OWNER_ALLOWLIST);
  return betterAuth({
    secret: config.BETTER_AUTH_SECRET,
    baseURL: config.BETTER_AUTH_URL, // basePath defaults to /api/auth
    database: drizzleAdapter(db, {
      provider: 'pg',
      schema: { user, session, account, verification },
    }),
    emailAndPassword: { enabled: true, disableSignUp: true },
    plugins: [expo()],
    // Explicit: expo() only auto-trusts exp:// when NODE_ENV==='development'
    // (D-06, D-13a). Expo Go is a dev-only client.
    trustedOrigins: ['virtumetry://', ...(config.NODE_ENV === 'production' ? [] : ['exp://'])],
    rateLimit: {
      // Default is off outside production (Pitfall 2), so set it explicitly.
      enabled: config.AUTH_RATE_LIMIT !== '0',
      window: 60,
      max: 100,
      customRules: { '/sign-in/email': { window: 60, max: 5 } },
    }, // ponytail: memory store, correct only while the api is a single replica
    // Set by our Fastify bridge from req.ip (hop-trusted), never by the client.
    advanced: {
      ipAddress: { ipAddressHeaders: ['x-vm-client-ip'] },
      // Explicit: Better Auth silently skips origin/CSRF checks when it detects a
      // test runner (isTest()), which would make the D-06 origin test vacuous.
      disableOriginCheck: false,
    },
    hooks: {
      before: createAuthMiddleware(async (ctx) => {
        if (ctx.path !== '/sign-in/email') return;
        const body = (ctx.body ?? {}) as { email?: unknown; password?: unknown };
        if (!isAllowlisted(allow, String(body.email ?? ''))) {
          // Hash anyway so a stranger's email costs the same time as a real check.
          await ctx.context.password.hash(String(body.password ?? ''));
          throw new APIError('UNAUTHORIZED', {
            message: 'Invalid email or password',
            code: 'INVALID_EMAIL_OR_PASSWORD',
          });
        }
      }),
    },
  });
}

export type Auth = ReturnType<typeof createAuth>;
