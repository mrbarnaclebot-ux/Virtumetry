// Real Better Auth expo client against the in-memory SecureStore from jest.setup.ts (AUTH-02).
jest.mock('@/config/api', () => ({ API_URL: 'https://api.test.invalid', APP_ENV: 'test' }));

type SecureStoreMock = { __store: Map<string, string>; __reset: () => void };
const secureStore = jest.requireMock('expo-secure-store') as SecureStoreMock;

function freshClient() {
  let client: typeof import('@/lib/auth-client').authClient | undefined;
  jest.isolateModules(() => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports -- fresh module instance per boot
    client = require('@/lib/auth-client').authClient;
  });
  return client!;
}

const inOneDay = () => new Date(Date.now() + 86_400_000).toISOString();

describe('authClient persistence', () => {
  beforeEach(() => secureStore.__reset());

  it('reads the stored session cookie on a fresh boot (storagePrefix virtumetry)', async () => {
    secureStore.__store.set(
      'virtumetry_cookie',
      JSON.stringify({ 'better-auth.session_token': { value: 'tok-abc.sig', expires: inOneDay() } }),
    );
    const cookie = await freshClient().getCookie();
    expect(cookie).toContain('better-auth.session_token=tok-abc.sig');
  });

  it('ignores a cookie stored under another prefix', async () => {
    secureStore.__store.set(
      'better-auth_cookie',
      JSON.stringify({ 'better-auth.session_token': { value: 'tok-abc.sig', expires: inOneDay() } }),
    );
    expect(await freshClient().getCookie()).toBe('');
  });

  it('does not return an expired cookie', async () => {
    secureStore.__store.set(
      'virtumetry_cookie',
      JSON.stringify({
        'better-auth.session_token': { value: 'old', expires: new Date(Date.now() - 1000).toISOString() },
      }),
    );
    expect(await freshClient().getCookie()).toBe('');
  });
});
