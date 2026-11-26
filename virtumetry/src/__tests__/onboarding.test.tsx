import { act, fireEvent, screen, waitFor } from '@testing-library/react-native';
import { router } from 'expo-router';
import { renderRouter } from 'expo-router/testing-library';
import { Text } from 'react-native';

import RootLayout from '@/app/_layout';
import OnboardingScreen from '@/app/onboarding';
import { __setLocalScansForTest } from '@/capture/store';
import { __resetFirstRunForTest, consumeIntent, getOnboardingSkipped } from '@/design/first-run';
import { queryClient } from '@/lib/query-client';

jest.mock('@/config/api', () => ({ API_URL: 'https://api.test.invalid', APP_ENV: 'test' }));
jest.mock('expo-font', () => ({ ...jest.requireActual('expo-font'), useFonts: () => [true, null] }));
jest.mock('@/upload/manager', () => ({ startUploadManager: jest.fn(), stopUploadManager: jest.fn() }));

let mockSession: { data: { user: { email: string } } | null; isPending: boolean };
jest.mock('@/lib/auth-client', () => ({
  authClient: {
    useSession: () => mockSession,
    getCookie: jest.fn(async () => 'better-auth.session_token=abc'),
  },
}));

type SecureStoreMock = { __store: Map<string, string>; __reset: () => void; setItem: jest.Mock };
const secureStore = jest.requireMock('expo-secure-store') as SecureStoreMock;
const FLAG = 'vm.onboarding.v1';

const ok = (body: unknown) => ({ ok: true, status: 200, json: async () => body }) as Response;
const page = (worlds: unknown[]) => ok({ worlds, has_more: false, next_offset: null });
let fetchMock: jest.Mock;

const routes = {
  _layout: RootLayout,
  '(tabs)/index': () => <Text>Library stub</Text>,
  'sign-in': () => <Text>Sign-in stub</Text>,
  onboarding: OnboardingScreen,
};

beforeEach(() => {
  mockSession = { data: { user: { email: 'owner@example.com' } }, isPending: false };
  secureStore.__reset();
  secureStore.setItem.mockClear();
  __resetFirstRunForTest();
  __setLocalScansForTest([]);
  queryClient.clear();
  fetchMock = jest.fn(async () => page([]));
  globalThis.fetch = fetchMock as unknown as typeof fetch;
});
afterEach(() => jest.restoreAllMocks());

async function toLastPage() {
  for (let i = 0; i < 3; i++) await fireEvent.press(screen.getByRole('button', { name: 'Next' }));
}

describe('onboarding routing', () => {
  it('lands a first-time signed-in user on onboarding; Skip sets the flag and opens the Library', async () => {
    await renderRouter(routes, { initialUrl: '/' });
    expect(screen).toHavePathname('/onboarding');
    expect(screen.getByText('Walk the room')).toBeTruthy();
    await fireEvent.press(screen.getByRole('button', { name: 'Skip' }));
    expect(secureStore.__store.get(FLAG)).toBe('1');
    expect(screen).toHavePathname('/');
    expect(consumeIntent()).toBeNull();
    expect(getOnboardingSkipped()).toBe(true);
  });

  it('has no "1 of 4" eyebrow; the dots announce the page (critique F3)', async () => {
    await renderRouter(routes, { initialUrl: '/' });
    expect(screen.queryByText(/of 4/i)).toBeNull();
    expect(screen.getByLabelText('Page 1 of 4')).toBeTruthy();
    await fireEvent.press(screen.getByRole('button', { name: 'Next' }));
    expect(screen.getByLabelText('Page 2 of 4')).toBeTruthy();
  });

  it('never shows onboarding to an onboarded user', async () => {
    secureStore.__store.set(FLAG, '1');
    await renderRouter(routes, { initialUrl: '/' });
    expect(screen).toHavePathname('/');
    expect(screen.getByText('Library stub')).toBeTruthy();
  });

  it('sends a signed-out user to sign-in, not onboarding', async () => {
    mockSession = { data: null, isPending: false };
    await renderRouter(routes, { initialUrl: '/' });
    expect(screen).toHavePathname('/sign-in');
  });

  it('offers "Scan your first room" for an empty library and sets the scan intent', async () => {
    await renderRouter(routes, { initialUrl: '/' });
    await toLastPage();
    const cta = await waitFor(() => screen.getByRole('button', { name: 'Scan your first room' }));
    await fireEvent.press(cta);
    expect(secureStore.__store.get(FLAG)).toBe('1');
    expect(consumeIntent()).toBe('scan');
    expect(getOnboardingSkipped()).toBe(false);
    expect(screen).toHavePathname('/');
  });

  it('offers "Go to library" when the library has worlds', async () => {
    fetchMock.mockImplementation(async () => page([{ id: 'w1', title: 'Kitchen', status: 'ready' }]));
    await renderRouter(routes, { initialUrl: '/' });
    await toLastPage();
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    await act(async () => {});
    expect(screen.getByRole('button', { name: 'Go to library' })).toBeTruthy();
    await fireEvent.press(screen.getByRole('button', { name: 'Go to library' }));
    expect(consumeIntent()).toBeNull();
    expect(screen).toHavePathname('/');
  });

  it('offers "Go to library" while the worlds request is pending or failed', async () => {
    fetchMock.mockImplementation(() => new Promise(() => {}));
    await renderRouter(routes, { initialUrl: '/' });
    await toLastPage();
    expect(screen.getByRole('button', { name: 'Go to library' })).toBeTruthy();
  });

  it('offers "Go to library" when the worlds request fails', async () => {
    fetchMock.mockImplementation(async () => {
      throw new TypeError('Network request failed');
    });
    await renderRouter(routes, { initialUrl: '/' });
    await toLastPage();
    await act(async () => {});
    expect(screen.getByRole('button', { name: 'Go to library' })).toBeTruthy();
  });

  it('replay shows Close and Done, goes back and leaves the flag alone', async () => {
    secureStore.__store.set(FLAG, '1');
    await renderRouter(routes, { initialUrl: '/' });
    await act(async () => router.push({ pathname: '/onboarding', params: { replay: '1' } }));
    expect(screen).toHavePathname('/onboarding');
    expect(screen.getByRole('button', { name: 'Close' })).toBeTruthy();
    await toLastPage();
    await fireEvent.press(screen.getByRole('button', { name: 'Done' }));
    expect(screen).toHavePathname('/');
    expect(secureStore.setItem).not.toHaveBeenCalledWith(FLAG, expect.anything());
    expect(secureStore.setItem).not.toHaveBeenCalledWith('vm.onboarding.skipped.v1', expect.anything());
    expect(secureStore.__store.get(FLAG)).toBe('1');
  });
});
