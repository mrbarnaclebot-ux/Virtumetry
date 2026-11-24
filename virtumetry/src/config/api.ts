export const PROD_API_HOST = 'api-production-adfc8f68.up.railway.app';

const LOCAL_HOST = /^(localhost|127\.0\.0\.1|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/;

/** Pure: which backend this build talks to. Throws on any unsafe combination (D-11). */
export function resolveApiUrl({ appEnv, apiUrl }: { appEnv?: string; apiUrl?: string }): string {
  if (!apiUrl) throw new Error('EXPO_PUBLIC_API_URL is required');
  const u = new URL(apiUrl);
  const local = LOCAL_HOST.test(u.hostname);
  if (u.protocol !== 'https:' && !(appEnv === 'development' && local)) {
    throw new Error('API URL must be https (http only for development on localhost/LAN)');
  }
  if (appEnv !== 'production' && u.hostname === PROD_API_HOST) {
    throw new Error('non-production build refuses the production API');
  }
  return u.origin;
}

// Dot-access only: Expo inlines process.env.EXPO_PUBLIC_* in this exact form.
export const APP_ENV = process.env.EXPO_PUBLIC_APP_ENV ?? 'unknown';
export const API_URL = resolveApiUrl({
  appEnv: process.env.EXPO_PUBLIC_APP_ENV,
  apiUrl: process.env.EXPO_PUBLIC_API_URL,
});
