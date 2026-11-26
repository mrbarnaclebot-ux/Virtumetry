import { act, fireEvent, render, screen } from '@testing-library/react-native';
import { useNetworkState } from 'expo-network';

import SignInScreen from '@/app/sign-in';
import { haptic } from '@/design/haptics';
import { authClient } from '@/lib/auth-client';
import { consumeSessionEndedNotice } from '@/lib/session';

jest.mock('@/lib/auth-client', () => ({ authClient: { signIn: { email: jest.fn() } } }));
jest.mock('expo-network', () => ({ useNetworkState: jest.fn() }));
jest.mock('@/lib/session', () => ({ consumeSessionEndedNotice: jest.fn(() => false) }));

const signInEmail = authClient.signIn.email as unknown as jest.Mock;
const consumeNotice = consumeSessionEndedNotice as jest.Mock;
const networkState = useNetworkState as jest.Mock;

const MISMATCH = "That email and password don't match. Try again.";

async function fill(email = '  owner@example.com ', password = 'pw-123456') {
  await render(<SignInScreen />);
  await fireEvent.changeText(screen.getByLabelText('Email'), email);
  await fireEvent.changeText(screen.getByLabelText('Password'), password);
}

async function submitWith(result: unknown) {
  if (result instanceof Error) signInEmail.mockRejectedValueOnce(result);
  else signInEmail.mockResolvedValueOnce(result);
  await fill();
  await fireEvent.press(screen.getByRole('button', { name: 'Log in' }));
}

beforeEach(() => {
  signInEmail.mockReset();
  consumeNotice.mockReturnValue(false);
  networkState.mockReturnValue({ isConnected: true, isInternetReachable: true });
});

describe('sign-in screen', () => {
  it('disables Log in while either field is blank after trim', async () => {
    await fill('   ', 'pw');
    expect(screen.getByRole('button', { name: 'Log in' })).toBeDisabled();
    await fireEvent.changeText(screen.getByLabelText('Email'), 'owner@example.com');
    await fireEvent.changeText(screen.getByLabelText('Password'), '  ');
    expect(screen.getByRole('button', { name: 'Log in' })).toBeDisabled();
  });

  it('submits the trimmed email', async () => {
    await submitWith({ data: { user: {} }, error: null });
    expect(signInEmail).toHaveBeenCalledWith({ email: 'owner@example.com', password: 'pw-123456' });
  });

  it.each([
    [{ data: null, error: { status: 401, code: 'INVALID_EMAIL_OR_PASSWORD' } }, MISMATCH],
    [{ data: null, error: { status: 429 } }, 'Too many attempts. Wait a minute, then try again.'],
    [{ data: null, error: { status: 500 } }, 'Something went wrong on our side. Try again in a moment.'],
    [new TypeError('Network request failed'), "Can't reach Virtumetry. Check your connection and try again."],
    [{ data: null, error: { message: 'fetch failed' } }, "Can't reach Virtumetry. Check your connection and try again."],
  ])('maps %p to inline copy', async (result, copy) => {
    await submitWith(result);
    expect(await screen.findByText(copy)).toBeTruthy();
  });

  it('clears the error when the user types', async () => {
    await submitWith({ data: null, error: { status: 401 } });
    expect(await screen.findByText(MISMATCH)).toBeTruthy();
    await fireEvent.changeText(screen.getByLabelText('Password'), 'other');
    expect(screen.queryByText(MISMATCH)).toBeNull();
  });

  it('shows "Logging in…" while submitting', async () => {
    let resolve!: (v: unknown) => void;
    signInEmail.mockReturnValueOnce(new Promise((r) => (resolve = r)));
    await fill();
    // Don't await the press: its act() would wait on the still-pending sign-in.
    const pressing = fireEvent.press(screen.getByRole('button', { name: 'Log in' }));
    expect(await screen.findByText('Logging in…')).toBeTruthy();
    await act(async () => resolve({ data: {}, error: null }));
    await pressing;
  });

  it('has no sign-up or forgot-password affordance', async () => {
    await render(<SignInScreen />);
    expect(screen.queryByText(/sign ?up|forgot/i)).toBeNull();
  });

  it('shows the session-ended notice once after a forced logout', async () => {
    consumeNotice.mockReturnValue(true);
    await render(<SignInScreen />);
    expect(screen.getByText('You were logged out. Log in again to continue.')).toBeTruthy();
  });

  it('disables Log in until both fields are filled', async () => {
    await render(<SignInScreen />);
    const button = () => screen.getByRole('button', { name: 'Log in' });
    expect(button().props.accessibilityState.disabled).toBe(true);
    await fireEvent.changeText(screen.getByLabelText('Email'), 'owner@example.com');
    expect(button().props.accessibilityState.disabled).toBe(true);
    await fireEvent.changeText(screen.getByLabelText('Password'), 'pw-123456');
    expect(button().props.accessibilityState.disabled).toBe(false);
  });

  it('shows the offline banner and keeps Log in enabled once filled', async () => {
    networkState.mockReturnValue({ isConnected: false, isInternetReachable: false });
    await fill();
    expect(screen.getByText("You're offline. Connect to log in.")).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Log in' })).not.toBeDisabled();
  });

  it('hides the offline banner while reachability is unknown', async () => {
    networkState.mockReturnValue({});
    await render(<SignInScreen />);
    expect(screen.queryByText("You're offline. Connect to log in.")).toBeNull();
  });

  it('plays the error haptic once when a submit fails', async () => {
    const error = jest.spyOn(haptic, 'error');
    await submitWith({ data: null, error: { status: 401 } });
    expect(await screen.findByText(MISMATCH)).toBeTruthy();
    expect(error).toHaveBeenCalledTimes(1);
    error.mockRestore();
  });
});
