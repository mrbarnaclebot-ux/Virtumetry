import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, fireEvent, render, screen } from '@testing-library/react-native';
import { router } from 'expo-router';

import ScanScreen from '@/app/capture/scan';
import { __setLocalScansForTest, getLocalScans } from '@/capture/store';
import { __resetCoachLockForTest } from '@/components/ui/coach-mark';
import { haptic } from '@/design/haptics';
import { __resetFirstRunForTest, isCoachSeen, markCoachSeen } from '@/design/first-run';

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
  (jest.requireMock('expo-secure-store') as { __reset: () => void }).__reset();
  __resetFirstRunForTest();
  __resetCoachLockForTest();
  // Capture config fetch fails -> bundled defaults.
  globalThis.fetch = jest.fn(async () => {
    throw new TypeError('offline');
  }) as unknown as typeof fetch;
});
afterEach(() => {
  jest.useRealTimers();
  jest.restoreAllMocks();
});

const COACH = 'Walk until the ring fills. Stop at Good to finish.';
const tick = (ms: number) => act(async () => void jest.advanceTimersByTime(ms));

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
  expect(screen.getByText('0 frames · ~$9.00')).toBeTruthy();
  expect(screen.queryByText(/credits/)).toBeNull(); // USD only on the HUD
  expect(screen.getByLabelText('Coverage: 0 of 12 directions seen')).toBeTruthy();
});

it('a good fixture run updates the HUD per keyframe and Stop saves on the phone', async () => {
  await renderScan();
  await fireEvent.press(screen.getByRole('button', { name: 'Good scenario' }));
  await runToEnd();

  expect(screen.getByText('30 frames · ~$9.30')).toBeTruthy();
  expect(screen.getByLabelText('Coverage: 1 of 12 directions seen')).toBeTruthy();
  expect(screen.getByText('Keep scanning')).toBeTruthy();

  await fireEvent.press(screen.getByRole('button', { name: 'Stop scan' }));
  const [scan] = getLocalScans();
  expect(scan).toMatchObject({ frameCount: 30, uploadState: 'saved', readiness: 'red', imageW: 640, imageH: 480 });
  expect(scan.durationS).toBeCloseTo(7.78, 1);
  expect(scan.precheckIssues.map((i) => i.code)).toContain('FRAME_COUNT_OUT_OF_RANGE');
  expect(scan.readinessReason).toBeTruthy();
  expect(router.replace).toHaveBeenCalledWith({ pathname: '/capture/[id]', params: { id: scan.id, step: 'review' } });
});

it('Too few replays 8 frames and stays red', async () => {
  await renderScan();
  await fireEvent.press(screen.getByRole('button', { name: 'Too few scenario' }));
  await runToEnd();
  expect(screen.getByText('8 frames · ~$9.08')).toBeTruthy();
  expect(screen.getByText('Keep scanning')).toBeTruthy();
});

it('a fresh mount replays the scenario the UI shows, not the last one picked (CR-04)', async () => {
  await renderScan();
  await fireEvent.press(screen.getByRole('button', { name: 'Too few scenario' }));
  await screen.unmount();
  await renderScan(); // shows Good selected
  await runToEnd();
  expect(screen.getByText(/^30 frames/)).toBeTruthy();
});

it('readiness is the HUD headline: hudStatus type, panel order readiness, reason, meter, shutter', async () => {
  const { StyleSheet } = jest.requireActual('react-native');
  await renderScan();
  const head = StyleSheet.flatten(screen.getByText('Ready to scan').props.style);
  expect(head).toMatchObject({ fontSize: 22, fontWeight: '600' });
  expect(screen.getByText('Ready to scan').props.maxFontSizeMultiplier).toBe(1.3);
  const order = ['Ready to scan', 'Tap Start, then walk slowly around the room', '0 frames · ~$9.00', 'Start scan'];
  const all = JSON.stringify(screen.toJSON());
  const idx = order.map((t) => all.indexOf(JSON.stringify(t)));
  expect(idx.every((v, i) => v >= 0 && (i === 0 || v > idx[i - 1]))).toBe(true);
});

it('unmounting mid-recording discards the unsaved capture (WR-05)', async () => {
  const { getCaptureSource } = jest.requireActual('@/capture/source');
  const cancel = jest.spyOn(getCaptureSource(), 'cancel');
  await renderScan();
  await fireEvent.press(screen.getByRole('button', { name: 'Start scan' }));
  await act(async () => {
    await jest.advanceTimersByTimeAsync(1_000);
  });
  await screen.unmount();
  expect(cancel).toHaveBeenCalledTimes(1);
  cancel.mockRestore();
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

it('shows the honest test capture placeholder before the first frame', async () => {
  await renderScan();
  expect(screen.getByText('Test capture. Photos appear here when you start.')).toBeTruthy();
  expect(screen.queryByText('Test capture ready')).toBeNull();
});

it('capture-prep coach shows once on idle; Got it hides it and marks it seen', async () => {
  await renderScan();
  expect(screen.getByText(COACH)).toBeTruthy();
  await fireEvent.press(screen.getByRole('button', { name: 'Got it' }));
  await tick(150);
  expect(screen.queryByText(COACH)).toBeNull();
  expect(isCoachSeen('capture-prep')).toBe(true);
});

it('capture-prep coach never renders once seen', async () => {
  markCoachSeen('capture-prep');
  await renderScan();
  expect(screen.queryByText(COACH)).toBeNull();
});

it('Start dismisses the coach, marks it seen and starts; medium haptic on start and stop', async () => {
  const medium = jest.spyOn(haptic, 'medium');
  await renderScan();
  expect(screen.getByText(COACH)).toBeTruthy();
  await fireEvent.press(screen.getByRole('button', { name: 'Start scan' }));
  expect(isCoachSeen('capture-prep')).toBe(true);
  expect(medium).toHaveBeenCalledTimes(1);
  await tick(1_000);
  expect(screen.queryByText(COACH)).toBeNull();
  expect(screen.getByRole('button', { name: 'Stop scan' })).toBeTruthy();
  await fireEvent.press(screen.getByRole('button', { name: 'Stop scan' }));
  expect(medium).toHaveBeenCalledTimes(2);
});

it('switching scenario gives a selection haptic', async () => {
  const selection = jest.spyOn(haptic, 'selection');
  await renderScan();
  await fireEvent.press(screen.getByRole('button', { name: 'Gap scenario' }));
  expect(selection).toHaveBeenCalledTimes(1);
});
