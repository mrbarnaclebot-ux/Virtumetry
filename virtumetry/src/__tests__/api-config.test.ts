import { PROD_API_HOST, resolveApiUrl } from '@/config/api';

const PROD = `https://${PROD_API_HOST}`;

describe('resolveApiUrl', () => {
  it('throws when the URL is missing', () => {
    expect(() => resolveApiUrl({ appEnv: 'development' })).toThrow(/required/);
  });

  it('returns the origin of an https URL', () => {
    expect(resolveApiUrl({ appEnv: 'development', apiUrl: 'https://api-dev.example.com/x' })).toBe(
      'https://api-dev.example.com',
    );
  });

  it('allows http on a LAN address in development', () => {
    expect(resolveApiUrl({ appEnv: 'development', apiUrl: 'http://192.168.1.20:8080' })).toBe(
      'http://192.168.1.20:8080',
    );
  });

  it('requires https on a LAN address outside development', () => {
    expect(() => resolveApiUrl({ appEnv: 'preview', apiUrl: 'http://192.168.1.20:8080' })).toThrow(
      /https/,
    );
  });

  it('requires https for a public host even in development', () => {
    expect(() => resolveApiUrl({ appEnv: 'development', apiUrl: 'http://example.com' })).toThrow(
      /https/,
    );
  });

  it.each(['development', 'preview', undefined])(
    'refuses the production API when appEnv is %s',
    (appEnv) => {
      expect(() => resolveApiUrl({ appEnv, apiUrl: PROD })).toThrow(/production/);
    },
  );

  it('allows the production API in production', () => {
    expect(resolveApiUrl({ appEnv: 'production', apiUrl: PROD })).toBe(PROD);
  });
});

// SC5: every build profile resolves to its own backend; dev/preview never reach production.
describe('build profiles', () => {
  /* eslint-disable @typescript-eslint/no-require-imports */
  const fs = require('fs') as typeof import('fs');
  const path = require('path') as typeof import('path');
  /* eslint-enable @typescript-eslint/no-require-imports */
  const root = path.join(__dirname, '..', '..');
  const eas = JSON.parse(fs.readFileSync(path.join(root, 'eas.json'), 'utf8'));
  const profiles = ['development', 'preview', 'production'] as const;
  const envOf = (p: string) => eas.build[p].env as Record<string, string>;

  it.each(profiles)('%s defines both public vars and resolves', (p) => {
    const env = envOf(p);
    expect(env.EXPO_PUBLIC_APP_ENV).toBe(p);
    expect(resolveApiUrl({ appEnv: env.EXPO_PUBLIC_APP_ENV, apiUrl: env.EXPO_PUBLIC_API_URL })).toMatch(
      /^https:\/\//,
    );
  });

  it.each(['development', 'preview'])('%s does not target production', (p) => {
    expect(new URL(envOf(p).EXPO_PUBLIC_API_URL).hostname).not.toBe(PROD_API_HOST);
    expect(() => resolveApiUrl({ appEnv: p, apiUrl: PROD })).toThrow(/production/);
  });

  it('production targets the production host', () => {
    expect(new URL(envOf('production').EXPO_PUBLIC_API_URL).hostname).toBe(PROD_API_HOST);
  });

  it('.env.development holds only the two public vars and matches the development profile', () => {
    const vars: Record<string, string> = {};
    for (const line of fs.readFileSync(path.join(root, '.env.development'), 'utf8').split(/\r?\n/)) {
      if (!line.trim() || line.startsWith('#')) continue;
      const i = line.indexOf('=');
      vars[line.slice(0, i)] = line.slice(i + 1);
    }
    expect(Object.keys(vars).sort()).toEqual(['EXPO_PUBLIC_API_URL', 'EXPO_PUBLIC_APP_ENV']);
    expect(vars.EXPO_PUBLIC_APP_ENV).toBe('development');
    const u = new URL(vars.EXPO_PUBLIC_API_URL);
    expect(u.protocol).toBe('https:');
    expect(u.hostname).not.toBe(PROD_API_HOST);
    expect(vars.EXPO_PUBLIC_API_URL).toBe(envOf('development').EXPO_PUBLIC_API_URL);
  });
});
