import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import { router } from 'expo-router';
import { Alert, type AlertButton } from 'react-native';

import CaptureScreen from '@/app/capture/[id]';
import { haptic } from '@/design/haptics';
import * as store from '@/capture/store';
import { __setLocalScansForTest, getLocalScans } from '@/capture/store';
import { __resetToastsForTest, toast } from '@/components/ui/toast';
import type { LocalScan } from '@/library/display-state';

jest.mock('@/config/api', () => ({ API_URL: 'https://api.test.invalid', APP_ENV: 'test' }));
jest.mock('@/lib/auth-client', () => ({ authClient: { getCookie: jest.fn(async () => 'c=1') } }));
jest.mock('@/lib/session', () => ({ endSession: jest.fn(async () => {}) }));
jest.mock('@/upload/manager', () => ({ kickUploadManager: jest.fn(), useUploadProgress: jest.fn() }));
jest.mock('expo-router', () => ({
  router: { back: jest.fn(), replace: jest.fn(), push: jest.fn() },
  useLocalSearchParams: jest.fn(() => ({ id: 's1', step: 'review' })),
}));

const seedScan = (over: Partial<LocalScan> = {}): LocalScan => ({
  id: 's1',
  sessionId: 's1',
  title: null,
  createdAt: '2026-11-24T10:00:00.000Z',
  dir: 'file:///mock/document/sessions/s1',
  frameCount: 30,
  durationS: 7.8,
  imageW: 640,
  imageH: 480,
  readiness: 'red',
  readinessReason: 'Keep going: 120 more frames',
  precheckIssues: [],
  uploadState: 'saved',
  ...over,
});

let toastSuccess: jest.SpyInstance;
let toastError: jest.SpyInstance;

beforeEach(() => {
  jest.restoreAllMocks();
  jest.clearAllMocks();
  __resetToastsForTest();
  toastSuccess = jest.spyOn(toast, 'success').mockImplementation(() => {});
  toastError = jest.spyOn(toast, 'error').mockImplementation(() => {});
  // capture config: offline -> bundled defaults
  globalThis.fetch = jest.fn(async () => ({ ok: false, status: 503, json: async () => ({}) })) as unknown as typeof fetch;
});

async function renderReview(scan: LocalScan) {
  __setLocalScansForTest([scan]);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } });
  await render(
    <QueryClientProvider client={client}>
      <CaptureScreen />
    </QueryClientProvider>,
  );
}

it('shows frames, duration, cost, readiness and passing checks with Check cost enabled', async () => {
  await renderReview(seedScan());
  expect(screen.getByText('Review scan')).toBeTruthy();
  expect(screen.getByText('Saved on phone')).toBeTruthy();
  expect(screen.getByText('30')).toBeTruthy();
  expect(screen.getByText('0:08')).toBeTruthy();
  // One money grammar: USD primary, credits secondary.
  expect(screen.getByText('$9.30')).toBeTruthy();
  expect(screen.getByText('930 credits')).toBeTruthy();
  expect(screen.getByText('Keep scanning')).toBeTruthy();
  expect(screen.getByText('Keep going: 120 more frames')).toBeTruthy();
  expect(screen.getByText('Checks passed')).toBeTruthy();
  const checkCost = screen.getByRole('button', { name: 'Check cost' });
  expect(checkCost).toBeEnabled();
  expect(screen.queryByRole('button', { name: 'Upload' })).toBeNull();
  await fireEvent.press(checkCost);
  expect(screen.getByText('Approve processing')).toBeTruthy();
  // One top-bar pattern: the quote goes back to Review from the leading chevron.
  await fireEvent.press(screen.getByRole('button', { name: 'Review' }));
  expect(screen.getByText('Review scan')).toBeTruthy();
});

it('shows the middle frame as the hero; a thumbnail swaps it with a selection haptic', async () => {
  const selection = jest.spyOn(haptic, 'selection');
  await renderReview(seedScan());
  expect(screen.getByRole('button', { name: 'Library' })).toBeTruthy();
  // 30 frames sample to 1, 8, 16, 23, 30: the middle one leads.
  expect(screen.getByLabelText('Frame 16 of 30')).toBeTruthy();
  expect(screen.getByRole('button', { name: 'Show frame 16' }).props.accessibilityState).toMatchObject({ selected: true });
  await fireEvent.press(screen.getByRole('button', { name: 'Show frame 1' }));
  expect(screen.getByLabelText('Frame 1 of 30')).toBeTruthy();
  expect(screen.getByRole('button', { name: 'Show frame 1' }).props.accessibilityState).toMatchObject({ selected: true });
  expect(selection).toHaveBeenCalledTimes(1);
  // Tapping the current hero is a no-op.
  await fireEvent.press(screen.getByRole('button', { name: 'Show frame 1' }));
  expect(selection).toHaveBeenCalledTimes(1);
});

it('a failing check disables Check cost and explains why', async () => {
  const reason = 'Too few photos (8 of 20 needed). Scan again and keep walking.';
  await renderReview(seedScan({ frameCount: 8, precheckIssues: [{ code: 'FRAME_COUNT_OUT_OF_RANGE', n: 8, min: 20, max: 5000 }] }));
  expect(screen.getByText("Didn't pass checks")).toBeTruthy();
  const checkCost = screen.getByRole('button', { name: 'Check cost' });
  expect(checkCost).toBeDisabled();
  expect(checkCost.props.accessibilityHint).toBe(reason);
  // Sighted users see why too: once in the checks list, once under the button.
  expect(screen.getAllByText(reason)).toHaveLength(2);
});

it('Discard confirms, then deletes the scan and closes', async () => {
  const alert = jest.spyOn(Alert, 'alert').mockImplementation(() => {});
  await renderReview(seedScan());
  await fireEvent.press(screen.getByRole('button', { name: 'Discard' }));
  expect(alert).toHaveBeenCalledWith(
    'Discard this scan?',
    "This deletes its 30 photos from your phone. You can't undo this.",
    expect.any(Array),
  );
  const buttons = alert.mock.calls[0][2] as AlertButton[];
  expect(getLocalScans()).toHaveLength(1);
  await act(async () => buttons.find((b) => b.text === 'Discard')!.onPress!());
  expect(getLocalScans()).toHaveLength(0);
  await waitFor(() => expect(router.back).toHaveBeenCalled());
  expect(toastSuccess).toHaveBeenCalledWith('Scan discarded');
});

it('a failed discard keeps the scan and says so in a toast, not a second Alert', async () => {
  const alert = jest.spyOn(Alert, 'alert').mockImplementation(() => {});
  jest.spyOn(store, 'discardLocalScan').mockImplementation(() => {
    throw new Error('disk');
  });
  await renderReview(seedScan());
  await fireEvent.press(screen.getByRole('button', { name: 'Discard' }));
  const buttons = alert.mock.calls[0][2] as AlertButton[];
  await act(async () => buttons.find((b) => b.text === 'Discard')!.onPress!());
  expect(toastError).toHaveBeenCalledWith("Couldn't discard. Try again.");
  expect(toastSuccess).not.toHaveBeenCalled();
  expect(alert).toHaveBeenCalledTimes(1);
  expect(getLocalScans()).toHaveLength(1);
});
