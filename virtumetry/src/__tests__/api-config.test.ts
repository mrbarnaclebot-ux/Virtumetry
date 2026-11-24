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
