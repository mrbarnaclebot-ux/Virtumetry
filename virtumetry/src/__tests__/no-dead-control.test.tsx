/**
 * UX-07 no-dead-control sweep (UI-SPEC §12.3): on every key screen state, each button has a real
 * onPress and an accessible name, and each disabled button says why (hint or a visible reason).
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react-native';
import { useLocalSearchParams } from 'expo-router';
import { useNetworkState } from 'expo-network';
import { Pressable, Text } from 'react-native';
import type { ReactElement } from 'react';

import LibraryScreen, { __resetBudgetBannerForTest } from '@/app/(tabs)/index';
import SettingsScreen from '@/app/(tabs)/settings';
import CaptureScreen from '@/app/capture/[id]';
import PrepScreen from '@/app/capture/prep';
import ScanScreen from '@/app/capture/scan';
import SharePage from '@/app/r/[slug]';
import SignInScreen from '@/app/sign-in';
import WorldScreen from '@/app/world/[id]/index';
import RetrySheet from '@/app/world/[id]/retry';
import ShareSheet from '@/app/world/[id]/share';
import { __setLocalScansForTest } from '@/capture/store';
import { __resetCoachLockForTest } from '@/components/ui/coach-mark';
import { ToastProvider, __resetToastsForTest } from '@/components/ui/toast';
import { __resetFirstRunForTest } from '@/design/first-run';
import type { LibraryItem, LocalScan } from '@/library/display-state';
import { useUploadProgress } from '@/upload/manager';
import type { ViewerProps } from '@/viewer/types';

// RESEARCH Pitfall 8: host buttons don't expose onPress, so tag every Pressable with whether it has one.
jest.mock('react-native/Libraries/Components/Pressable/Pressable', () => {
  const React = jest.requireActual('react');
  const Real = jest.requireActual('react-native/Libraries/Components/Pressable/Pressable').default;
  return {
    __esModule: true,
    default: React.forwardRef(function TaggedPressable(p: { onPress?: unknown }, ref: unknown) {
      return React.createElement(Real, { ...p, ref, 'data-has-press': typeof p.onPress === 'function' });
    }),
  };
});

jest.mock('@/config/api', () => ({ API_URL: 'https://api.test.invalid', APP_ENV: 'test' }));
jest.mock('@/lib/auth-client', () => ({
  authClient: {
    getCookie: jest.fn(async () => 'c=1'),
    useSession: () => ({ data: { user: { email: 'owner@example.com' } }, isPending: false }),
    signOut: jest.fn(),
    $store: { notify: jest.fn(), atoms: {} },
    signIn: { email: jest.fn() },
  },
}));
jest.mock('@/lib/session', () => ({ endSession: jest.fn(async () => {}), consumeSessionEndedNotice: jest.fn(() => false) }));
jest.mock('expo-router', () => ({
  router: { back: jest.fn(), replace: jest.fn(), push: jest.fn() },
  useRouter: () => ({ back: jest.fn(), replace: jest.fn(), push: jest.fn() }),
  useLocalSearchParams: jest.fn(() => ({})),
}));
jest.mock('expo-router/head', () => ({ __esModule: true, default: () => null }));
jest.mock('expo-keep-awake', () => ({ useKeepAwake: jest.fn() }));
jest.mock('expo-constants', () => ({ __esModule: true, default: { expoConfig: { version: '1.0.0' } } }));
jest.mock('expo-camera', () => ({
  useCameraPermissions: () => [{ granted: false, status: 'undetermined', canAskAgain: true }, jest.fn(), jest.fn()],
}));
jest.mock('@/upload/manager', () => ({ kickUploadManager: jest.fn(), useUploadProgress: jest.fn() }));
jest.mock('@/design/haptics', () => ({
  haptic: { selection: jest.fn(), light: jest.fn(), medium: jest.fn(), success: jest.fn(), warning: jest.fn(), error: jest.fn() },
}));
jest.mock('@/viewer/world-viewer', () => {
  const { View } = jest.requireActual('react-native');
  return { __esModule: true, default: function MockViewer(_p: ViewerProps) { return <View testID="world-viewer" />; } };
});
jest.mock('@/viewer/load-viewer', () => {
  const { View } = jest.requireActual('react-native');
  return { loadViewer: async () => ({ default: () => <View testID="world-viewer" /> }) };
});

type Node = { props: Record<string, unknown>; children: (Node | string)[] };
const textOf = (n: Node | string): string => (typeof n === 'string' ? n : n.children.map(textOf).join(''));
const nameOf = (b: Node) => String(b.props.accessibilityLabel ?? textOf(b)).trim();

/**
 * Asserts the no-dead-control rule on the current screen. `reasons` maps a disabled button's name to
 * the reason text sighted users see; a disabled button with no hint must have one, and it must be on screen.
 */
function assertNoDeadControls(reasons: Record<string, string> = {}) {
  const buttons = screen.getAllByRole('button') as unknown as Node[];
  const problems: string[] = [];
  for (const b of buttons) {
    const name = nameOf(b);
    if (!name) problems.push('button with no accessible name');
    if (b.props['data-has-press'] !== true) problems.push(`${name || '?'}: no onPress`);
    const disabled = (b.props.accessibilityState as { disabled?: boolean } | undefined)?.disabled === true;
    if (disabled && !String(b.props.accessibilityHint ?? '').trim()) {
      const reason = reasons[name];
      if (!reason || screen.queryAllByText(reason).length === 0) problems.push(`${name}: disabled with no reason`);
    }
  }
  expect(problems).toEqual([]);
  return buttons.length;
}

const ok = (body: unknown) => ({ ok: true, status: 200, json: async () => body }) as Response;
const fail = (status: number, body: unknown = {}) => ({ ok: false, status, json: async () => body }) as Response;
let handler: (url: string, init?: RequestInit) => Promise<Response>;

const CREATED = '2026-11-24T10:00:00.000Z';
const world = (id: string, over: Partial<LibraryItem> = {}): LibraryItem => ({
  id,
  title: id,
  caption: null,
  status: 'ready',
  phase: null,
  progress: null,
  heartbeat_at: new Date().toISOString(),
  created_at: CREATED,
  failure_stage: null,
  failure_code: null,
  failure_message: null,
  charged: false,
  eta_seconds: null,
  credits_spent: null,
  assets: {},
  ...over,
});
const local = (id: string, over: Partial<LocalScan> = {}): LocalScan => ({
  id,
  sessionId: id,
  title: id,
  createdAt: CREATED,
  dir: `file:///mock/document/sessions/${id}`,
  frameCount: 30,
  durationS: 7.8,
  imageW: 640,
  imageH: 480,
  readiness: 'green',
  precheckIssues: [],
  uploadState: 'saved',
  ...over,
});
const page = (worlds: LibraryItem[], budgetAlert = null) => ok({ worlds, has_more: false, next_offset: null, budgetAlert });
const QUOTE = { credits: 930, usd: 9.3, budgetRemaining: 4070, budgetWindow: 'daily', withinBudget: true };
const ASSETS = {
  splat_url: 'https://r2.test.invalid/splat.ply',
  collider_url: 'https://r2.test.invalid/collider.ply',
  floorplan_url: 'https://r2.test.invalid/floorplan.png',
  cameras_url: 'https://r2.test.invalid/cameras.json',
};

const params = useLocalSearchParams as jest.Mock;
const network = useNetworkState as jest.Mock;
const offline = () => network.mockReturnValue({ isConnected: false, isInternetReachable: false });

async function show(ui: ReactElement) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity }, mutations: { retry: false } } });
  await render(
    <QueryClientProvider client={client}>
      <ToastProvider>{ui}</ToastProvider>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  jest.clearAllMocks();
  (jest.requireMock('expo-secure-store') as { __reset: () => void }).__reset();
  __resetToastsForTest();
  __resetFirstRunForTest();
  __resetCoachLockForTest();
  __resetBudgetBannerForTest();
  __setLocalScansForTest([]);
  network.mockReturnValue({ isConnected: true, isInternetReachable: true });
  (useUploadProgress as jest.Mock).mockReturnValue(undefined);
  handler = async () => fail(503);
  globalThis.fetch = jest.fn((url: string, init?: RequestInit) => handler(String(url), init)) as unknown as typeof fetch;
});

describe('sanity: the sweep catches a dead control', () => {
  it('flags a role=button Pressable with no onPress', async () => {
    await render(
      <Pressable accessibilityRole="button" accessibilityLabel="Dead">
        <Text>Dead</Text>
      </Pressable>,
    );
    expect(() => assertNoDeadControls()).toThrow();
  });

  it('flags an unnamed button and a disabled button with no reason', async () => {
    await render(
      <>
        <Pressable accessibilityRole="button" onPress={() => {}} />
        <Pressable accessibilityRole="button" accessibilityLabel="Go" disabled onPress={() => {}} />
      </>,
    );
    expect(() => assertNoDeadControls()).toThrow();
  });
});

describe('Sign-in', () => {
  it('has no dead controls', async () => {
    await render(<SignInScreen />);
    expect(assertNoDeadControls()).toBeGreaterThan(0);
  });
});

describe('Library populated', () => {
  it('has no dead controls', async () => {
    __setLocalScansForTest([local('Hallway'), local('Porch', { uploadState: 'uploading', progress: { uploaded: 12, total: 32 } })]);
    handler = async () =>
      page([
        world('Kitchen'),
        world('Bedroom', { status: 'processing' }),
        world('Garage', { status: 'failed', failure_code: 'WORLD_GENERATION_FAILED' }),
        world('Attic', { status: 'cancelled' }),
      ]);
    await show(<LibraryScreen />);
    await screen.findByText('Attic');
    assertNoDeadControls();
  });
});

describe('Library empty', () => {
  it('has no dead controls', async () => {
    handler = async () => page([]);
    await show(<LibraryScreen />);
    await screen.findByText('No scans yet');
    assertNoDeadControls();
  });
});

describe('Library error', () => {
  it('has no dead controls', async () => {
    handler = async () => {
      throw new TypeError('Network request failed');
    };
    await show(<LibraryScreen />);
    await screen.findByRole('button', { name: 'Try again' });
    assertNoDeadControls();
  });
});

describe('Library offline', () => {
  it('has no dead controls', async () => {
    offline();
    handler = async () => {
      throw new TypeError('Network request failed');
    };
    await show(<LibraryScreen />);
    await screen.findByRole('button', { name: 'Try again' });
    assertNoDeadControls();
  });
});

describe('Settings', () => {
  it('has no dead controls', async () => {
    await show(<SettingsScreen />);
    await screen.findByText('owner@example.com');
    assertNoDeadControls();
  });
});

describe('Prep', () => {
  it('has no dead controls', async () => {
    await show(<PrepScreen />);
    await screen.findByText('Camera access');
    assertNoDeadControls();
  });
});

describe('Scan', () => {
  it('has no dead controls', async () => {
    handler = async () => {
      throw new TypeError('offline');
    };
    await show(<ScanScreen />);
    await screen.findByText('Ready to scan');
    assertNoDeadControls();
  });
});

describe('Review', () => {
  it('has no dead controls, clean and with a failing check', async () => {
    params.mockReturnValue({ id: 's1', step: 'review' });
    __setLocalScansForTest([local('s1')]);
    await show(<CaptureScreen />);
    await screen.findByText('Review scan');
    assertNoDeadControls();
    await screen.unmount();

    __setLocalScansForTest([local('s1', { frameCount: 8, precheckIssues: [{ code: 'FRAME_COUNT_OUT_OF_RANGE', n: 8, min: 20, max: 5000 }] })]);
    await show(<CaptureScreen />);
    await screen.findByText("Didn't pass checks");
    expect(screen.getByRole('button', { name: 'Check cost' })).toBeDisabled();
    assertNoDeadControls();
  });
});

describe('Quote', () => {
  it('has no dead controls, within and over budget', async () => {
    params.mockReturnValue({ id: 's1', step: 'quote' });
    __setLocalScansForTest([local('s1')]);
    handler = async (url) => (url.includes('/v1/quote') ? ok(QUOTE) : fail(503));
    await show(<CaptureScreen />);
    await screen.findByText('Approve processing');
    await screen.findByRole('button', { name: 'Approve and process', disabled: false });
    assertNoDeadControls();
    await screen.unmount();

    handler = async (url) => (url.includes('/v1/quote') ? ok({ ...QUOTE, budgetRemaining: 100, withinBudget: false }) : fail(503));
    await show(<CaptureScreen />);
    await screen.findByText("This scan would go over today's limit. Try again tomorrow.");
    assertNoDeadControls();
  });
});

describe('Upload', () => {
  it('has no dead controls', async () => {
    params.mockReturnValue({ id: 's1', step: 'upload' });
    (useUploadProgress as jest.Mock).mockReturnValue({ uploaded: 12, total: 32 });
    __setLocalScansForTest([local('s1', { uploadState: 'uploading', serverWorldId: 'w1' })]);
    await show(<CaptureScreen />);
    await screen.findByText('Uploading · 38%');
    assertNoDeadControls();
  });
});

describe('Share', () => {
  const shares = [
    { id: 's2', slug: 'b', url: 'https://api.test.invalid/s/b', has_password: true, open_count: 3, created_at: CREATED, revoked_at: null },
    { id: 's1', slug: 'a', url: 'https://api.test.invalid/s/a', has_password: false, open_count: 0, created_at: CREATED, revoked_at: CREATED },
  ];

  it('has no dead controls online and offline', async () => {
    params.mockReturnValue({ id: 'w1' });
    handler = async () => ok({ shares });
    await show(<ShareSheet />);
    await screen.findByText(shares[0].url);
    assertNoDeadControls();
    await screen.unmount();

    offline();
    await show(<ShareSheet />);
    await screen.findByText(shares[0].url);
    expect(screen.getByRole('button', { name: 'Create link' })).toBeDisabled();
    assertNoDeadControls();
  });
});

describe('Retry', () => {
  it('has no dead controls', async () => {
    params.mockReturnValue({ id: 'w1' });
    const failed = world('w1', {
      status: 'failed',
      failure_stage: 'submit',
      failure_code: 'PROVIDER_UNAVAILABLE',
      retryable: true,
      submit_attempt: 1,
      frame_count: 30,
    });
    handler = async (url) => {
      if (url.includes('/v1/quote')) return ok(QUOTE);
      if (url.includes('/v1/worlds?')) return page([failed]);
      return fail(503);
    };
    await show(<RetrySheet />);
    await screen.findByText('~$9.30');
    assertNoDeadControls();
  });
});

describe('World error', () => {
  it('has no dead controls', async () => {
    params.mockReturnValue({ id: 'w1' });
    handler = async () => fail(404, { error: 'world_not_found' });
    await show(<WorldScreen />);
    await screen.findByText("This scan isn't available");
    assertNoDeadControls();
  });
});

describe('World not ready', () => {
  it('has no dead controls', async () => {
    params.mockReturnValue({ id: 'w1' });
    handler = async () => ok({ world: world('w1', { status: 'processing' }), assets: {} });
    await show(<WorldScreen />);
    await screen.findByText("This scan isn't ready yet");
    assertNoDeadControls();
  });

  it('a ready world has no dead controls either', async () => {
    params.mockReturnValue({ id: 'w1' });
    handler = async () => ok({ world: world('w1'), assets: ASSETS });
    await show(<WorldScreen />);
    await screen.findByTestId('world-viewer');
    assertNoDeadControls();
  });
});

describe('Web gate', () => {
  it('has no dead controls', async () => {
    params.mockReturnValue({ slug: 'AAAAAAAAAAAAAAAAAAAAAA' });
    handler = async () => ok({ title: 'Kitchen', needs_password: true });
    await render(<SharePage />);
    await screen.findByLabelText('Password');
    assertNoDeadControls();
  });
});
