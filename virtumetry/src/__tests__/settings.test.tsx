import { act, fireEvent, render, screen } from '@testing-library/react-native';
import { router } from 'expo-router';
import { Alert, type AlertButton } from 'react-native';

import SettingsScreen from '@/app/(tabs)/settings';
import { authClient } from '@/lib/auth-client';
import { queryClient } from '@/lib/query-client';

jest.mock('expo-router', () => ({ router: { push: jest.fn() } }));
let mockAppEnv = 'test';
jest.mock('@/config/api', () => ({
  API_URL: 'https://api.test.invalid',
  get APP_ENV() {
    return mockAppEnv;
  },
}));
jest.mock('expo-constants', () => ({ __esModule: true, default: { expoConfig: { version: '1.0.0' } } }));
jest.mock('@/lib/auth-client', () => ({
  authClient: {
    useSession: () => ({ data: { user: { email: 'owner@example.com' } }, isPending: false }),
    signOut: jest.fn(),
    $store: { notify: jest.fn(), atoms: {} },
  },
}));

type SecureStoreMock = { __store: Map<string, string>; __reset: () => void };
const secureStore = jest.requireMock('expo-secure-store') as SecureStoreMock;
const signOut = authClient.signOut as unknown as jest.Mock;

let alertSpy: jest.SpyInstance;
let clearSpy: jest.SpyInstance;

beforeEach(() => {
  signOut.mockReset();
  secureStore.__reset();
  alertSpy = jest.spyOn(Alert, 'alert').mockImplementation(() => {});
  clearSpy = jest.spyOn(queryClient, 'clear');
});
afterEach(() => jest.restoreAllMocks());

async function confirmLogOut() {
  await fireEvent.press(screen.getByRole('button', { name: 'Log out' }));
  const buttons = alertSpy.mock.calls[0][2] as AlertButton[];
  await act(async () => {
    await buttons.find((b) => b.text === 'Log out')!.onPress!();
  });
}

describe('settings screen', () => {
  it('shows the account and the signed-in email', async () => {
    await render(<SettingsScreen />);
    expect(screen.getByText('Settings')).toBeTruthy();
    expect(screen.getByText('Account')).toBeTruthy();
    expect(screen.getByText('Signed in as')).toBeTruthy();
    expect(screen.getByText('owner@example.com')).toBeTruthy();
  });

  it('asks for confirmation before logging out', async () => {
    await render(<SettingsScreen />);
    await fireEvent.press(screen.getByRole('button', { name: 'Log out' }));
    expect(alertSpy).toHaveBeenCalledWith(
      'Log out?',
      "You'll need your email and password to log back in.",
      [
        expect.objectContaining({ text: 'Cancel', style: 'cancel' }),
        expect.objectContaining({ text: 'Log out', style: 'destructive' }),
      ],
    );
    expect(signOut).not.toHaveBeenCalled();
  });

  it('signs out and clears the query cache on confirm', async () => {
    signOut.mockResolvedValueOnce({ data: { success: true }, error: null });
    await render(<SettingsScreen />);
    await confirmLogOut();
    expect(signOut).toHaveBeenCalledTimes(1);
    expect(clearSpy).toHaveBeenCalled();
  });

  it('still clears the local session when sign-out fails on the network', async () => {
    signOut.mockRejectedValueOnce(new TypeError('Network request failed'));
    secureStore.__store.set('virtumetry_cookie', '{"x":{"value":"y","expires":null}}');
    secureStore.__store.set('virtumetry_session_data', '{"user":{}}');
    await render(<SettingsScreen />);
    await confirmLogOut();
    expect(secureStore.__store.has('virtumetry_cookie')).toBe(false);
    expect(secureStore.__store.has('virtumetry_session_data')).toBe(false);
    expect(authClient.$store.notify).toHaveBeenCalledWith('$sessionSignal');
    expect(clearSpy).toHaveBeenCalled();
  });

  it('Replay intro resets the coach marks and opens onboarding in replay mode', async () => {
    for (const id of ['capture-prep', 'walk', 'measure']) secureStore.__store.set(`vm.coach.${id}`, '1');
    secureStore.__store.set('vm.onboarding.v1', '1');
    await render(<SettingsScreen />);
    await fireEvent.press(screen.getByRole('button', { name: /Replay intro/ }));
    await act(async () => {});
    for (const id of ['capture-prep', 'walk', 'measure']) expect(secureStore.__store.has(`vm.coach.${id}`)).toBe(false);
    expect(secureStore.__store.get('vm.onboarding.v1')).toBe('1');
    expect(router.push).toHaveBeenCalledWith({ pathname: '/onboarding', params: { replay: '1' } });
  });

  it('shows the version and app env footer', async () => {
    await render(<SettingsScreen />);
    expect(screen.getByText('Virtumetry 1.0.0 · test')).toBeTruthy();
  });

  it('hides the app env in production', async () => {
    mockAppEnv = 'production';
    try {
      await render(<SettingsScreen />);
      expect(screen.getByText('Virtumetry 1.0.0')).toBeTruthy();
    } finally {
      mockAppEnv = 'test';
    }
  });
});
