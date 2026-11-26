import { fireEvent, render, screen } from '@testing-library/react-native';
import { router } from 'expo-router';
import { Linking } from 'react-native';

import PrepScreen from '@/app/capture/prep';
import { haptic } from '@/design/haptics';

jest.mock('expo-router', () => ({ router: { replace: jest.fn(), back: jest.fn(), push: jest.fn() } }));

type Perm = { granted: boolean; status: string; canAskAgain: boolean };
let mockPerm: Perm | null;
const mockRequest = jest.fn<Promise<Perm>, []>();
const mockGetPermission = jest.fn(async () => mockPerm!);
jest.mock('expo-camera', () => ({
  useCameraPermissions: () => [mockPerm, mockRequest, mockGetPermission],
}));

const store: Map<string, string> = jest.requireMock('expo-secure-store').__store;

beforeEach(() => {
  store.clear();
  jest.clearAllMocks();
  mockPerm = { granted: false, status: 'undetermined', canAskAgain: true };
});

it('first run shows the checklist and the camera priming card', async () => {
  await render(<PrepScreen />);
  for (const t of ['Turn the lights on', 'Open the doors', 'Watch for mirrors and glare', 'Walk slowly']) {
    expect(screen.getByText(t)).toBeTruthy();
  }
  expect(screen.getByText('Camera access')).toBeTruthy();
});

it('compact variant shows the short line and persists "Don\'t show again"', async () => {
  store.set('vm.prep.seen', '1');
  const selection = jest.spyOn(haptic, 'selection');
  await render(<PrepScreen />);
  expect(screen.getByText('Lights on · Doors open · No mirrors · Walk slowly')).toBeTruthy();
  expect(screen.queryByText('Camera access')).toBeNull();
  await fireEvent(screen.getByRole('switch'), 'valueChange', true);
  expect(store.get('vm.prep.skip')).toBe('1');
  expect(selection).toHaveBeenCalledTimes(1);
  selection.mockRestore();
});

it('Continue with permission granted goes straight to the scan', async () => {
  mockPerm = { granted: true, status: 'granted', canAskAgain: true };
  await render(<PrepScreen />);
  await fireEvent.press(screen.getByRole('button', { name: 'Continue' }));
  expect(mockRequest).not.toHaveBeenCalled();
  expect(router.replace).toHaveBeenCalledWith('/capture/scan');
  expect(store.get('vm.prep.seen')).toBe('1');
});

it('undetermined asks once; denial shows the Settings path and the test capture', async () => {
  mockRequest.mockResolvedValue({ granted: false, status: 'denied', canAskAgain: false });
  await render(<PrepScreen />);
  await fireEvent.press(screen.getByRole('button', { name: 'Continue' }));
  expect(mockRequest).toHaveBeenCalledTimes(1);
  expect(store.get('vm.camera.asked')).toBe('1');
  expect(router.replace).not.toHaveBeenCalled();

  expect(screen.getByRole('header', { name: 'Camera access is off' })).toBeTruthy();
  const open = jest.spyOn(Linking, 'openSettings').mockResolvedValue();
  await fireEvent.press(screen.getByRole('button', { name: 'Open Settings' }));
  expect(open).toHaveBeenCalled();

  await fireEvent.press(screen.getByRole('button', { name: 'Use test capture' }));
  expect(router.replace).toHaveBeenCalledWith('/capture/scan');
  await fireEvent.press(screen.getByRole('button', { name: 'Not now' }));
  expect(router.back).toHaveBeenCalled();
});

it('permanently denied shows the denied state on open', async () => {
  mockPerm = { granted: false, status: 'denied', canAskAgain: false };
  await render(<PrepScreen />);
  expect(screen.getByText('Camera access is off')).toBeTruthy();
});
