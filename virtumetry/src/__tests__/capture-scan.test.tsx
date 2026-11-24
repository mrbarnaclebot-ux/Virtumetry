import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, fireEvent, render, screen } from '@testing-library/react-native';
import { router } from 'expo-router';

import ScanScreen from '@/app/capture/scan';
import { __setLocalScansForTest, getLocalScans } from '@/capture/store';

jest.mock('@/config/api', () => ({ API_URL: 'https://api.test.invalid', APP_ENV: 'test' }));
jest.mock('@/lib/auth-client', () => ({ authClient: { getCookie: jest.fn(async () => null) } }));
jest.mock('@/lib/session', () => ({ endSession: jest.fn(async () => {}) }));
jest.mock('expo-router', () => ({ router: { replace: jest.fn(), back: jest.fn(), push: jest.fn() } }));
jest.mock('expo-keep-awake', () => ({ useKeepAwake: jest.fn() }));
// jest-expo turns .jpg requires into numbers with no localUri (Pitfall 7): serve fake cache files.
jest.mock('@/capture/fixture-assets', () => {
  const actual = jest.requireActual('@/capture/fixture-assets');
  const { File, Paths } = jest.requireActual('expo-file-system');
  return {
    ...actual,
    resolveFixtureFrame: async (k: number) => {
      const f = new File(Paths.cache, `scan-src-${k}.jpg`);
      f.write(`jpg-${k}`);
      return f.uri;
    },
  };
});

beforeEach(() => {
  jest.useFakeTimers();
  jest.clearAllMocks();
  __setLocalScansForTest([]);
  // Capture config fetch fails -> bundled defaults.
  globalThis.fetch = jest.fn(async () => {
    throw new TypeError('offline');
  }) as unknown as typeof fetch;
});
afterEach(() => jest.useRealTimers());

async function renderScan() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } });
  await render(
    <QueryClientProvider client={client}>
      <ScanScreen />
    </QueryClientProvider>,
  );
}

async function runToEnd() {
  await fireEvent.press(screen.getByRole('button', { name: 'Start scan' }));
  await act(async () => {
    await jest.advanceTimersByTimeAsync(10_000);
  });
}

it('idle shows Ready to scan and the base cost', async () => {
  await renderScan();
  expect(screen.getByText('Ready to scan')).toBeTruthy();
  expect(screen.getByText('$9.00 · 900 credits')).toBeTruthy();
  expect(screen.getByText('0 frames')).toBeTruthy();
  expect(screen.getByLabelText('Coverage: 0 of 12 directions seen')).toBeTruthy();
});

it('a good fixture run updates the HUD per keyframe and Stop saves on the phone', async () => {
  await renderScan();
  await fireEvent.press(screen.getByRole('button', { name: 'Good scenario' }));
  await runToEnd();

  expect(screen.getByText('30 frames')).toBeTruthy();
  expect(screen.getByText('$9.30 · 930 credits')).toBeTruthy();
  expect(screen.getByLabelText('Coverage: 1 of 12 directions seen')).toBeTruthy();
  expect(screen.getByText('Keep scanning')).toBeTruthy();

  await fireEvent.press(screen.getByRole('button', { name: 'Stop scan' }));
  const [scan] = getLocalScans();
  expect(scan).toMatchObject({ frameCount: 30, uploadState: 'saved', readiness: 'red', imageW: 640, imageH: 480 });
  expect(scan.durationS).toBeCloseTo(7.78, 1);
  expect(scan.precheckIssues.map((i) => i.code)).toContain('FRAME_COUNT_OUT_OF_RANGE');
  expect(router.back).toHaveBeenCalled();
});

it('Too few replays 8 frames and stays red', async () => {
  await renderScan();
  await fireEvent.press(screen.getByRole('button', { name: 'Too few scenario' }));
  await runToEnd();
  expect(screen.getByText('8 frames')).toBeTruthy();
  expect(screen.getByText('Keep scanning')).toBeTruthy();
});

it('Cancel with frames confirms before deleting the scan', async () => {
  const { Alert } = jest.requireActual('react-native');
  const alert = jest.spyOn(Alert, 'alert').mockImplementation(() => {});
  await renderScan();
  await fireEvent.press(screen.getByRole('button', { name: 'Good scenario' }));
  await runToEnd();
  await fireEvent.press(screen.getByRole('button', { name: 'Cancel scan' }));
  expect(alert).toHaveBeenCalledWith('Cancel scan?', 'The 30 photos captured so far will be deleted.', expect.any(Array));
  expect(router.back).not.toHaveBeenCalled();
  expect(getLocalScans()).toHaveLength(0);
});
