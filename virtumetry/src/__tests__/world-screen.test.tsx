import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen } from '@testing-library/react-native';

import WorldScreen from '@/app/world/[id]/index';
import type { LibraryItem } from '@/library/display-state';
import type { ViewerProps } from '@/viewer/types';

const viewerProps: { current: ViewerProps | null } = { current: null };

jest.mock('@/viewer/world-viewer', () => {
  const { View } = jest.requireActual('react-native');
  return {
    __esModule: true,
    default: (p: ViewerProps) => {
      viewerProps.current = p;
      return <View testID="world-viewer" />;
    },
  };
});
jest.mock('@/config/api', () => ({ API_URL: 'https://api.test.invalid', APP_ENV: 'test' }));
jest.mock('@/lib/auth-client', () => ({ authClient: { getCookie: jest.fn(async () => 'c=1') } }));
jest.mock('@/lib/session', () => ({ endSession: jest.fn(async () => {}) }));
jest.mock('expo-keep-awake', () => ({ useKeepAwake: jest.fn() }));
jest.mock('expo-router', () => ({
  router: { back: jest.fn() },
  useLocalSearchParams: jest.fn(() => ({ id: 'w1' })),
}));
jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 47, bottom: 34, left: 0, right: 0 }),
}));

const META = { scene_bounds: { min: [-2, 0, -2], max: [2, 2.5, 2] } };

const world = (over: Partial<LibraryItem> & { floorplan_meta?: unknown } = {}) => ({
  id: 'w1',
  title: 'Kitchen',
  caption: null,
  status: 'ready',
  phase: null,
  progress: null,
  heartbeat_at: '2026-11-24T10:00:00.000Z',
  created_at: '2026-11-24T10:00:00.000Z',
  failure_stage: null,
  failure_code: null,
  failure_message: null,
  eta_seconds: null,
  credits_spent: null,
  assets: {},
  floorplan_meta: META,
  ...over,
});
const ASSETS = {
  splat_url: 'https://r2.test.invalid/splat.ply',
  collider_url: 'https://r2.test.invalid/collider.ply',
  floorplan_url: 'https://r2.test.invalid/floorplan.png',
  cameras_url: 'https://r2.test.invalid/cameras.json',
};

const ok = (body: unknown) => ({ ok: true, status: 200, json: async () => body }) as Response;
const fail = (status: number, error: string) => ({ ok: false, status, json: async () => ({ error }) }) as Response;

let fetchMock: jest.Mock;
beforeEach(() => {
  viewerProps.current = null;
  fetchMock = jest.fn();
  globalThis.fetch = fetchMock as unknown as typeof fetch;
});

const newClient = () => new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } });
const ui = (client: QueryClient) => (
  <QueryClientProvider client={client}>
    <WorldScreen />
  </QueryClientProvider>
);

it('shows a spinner and Back while the world loads', async () => {
  fetchMock.mockReturnValue(new Promise(() => {}));
  await render(ui(newClient()));
  expect(screen.getByTestId('world-loading')).toBeTruthy();
  expect(screen.getByRole('button', { name: 'Back' })).toBeTruthy();
});

it('passes the detail response to the viewer, and never refetches on remount', async () => {
  fetchMock.mockResolvedValue(ok({ world: world(), assets: ASSETS }));
  const client = newClient();
  const first = await render(ui(client));
  await screen.findByTestId('world-viewer');

  expect(fetchMock.mock.calls[0][0]).toBe('https://api.test.invalid/v1/worlds/w1');
  expect(viewerProps.current).toMatchObject({
    splatUrl: ASSETS.splat_url,
    colliderUrl: ASSETS.collider_url,
    floorplanUrl: ASSETS.floorplan_url,
    camerasUrl: ASSETS.cameras_url,
    floorplanMeta: META,
    title: 'Kitchen',
    insets: { top: 47 + 44, bottom: 34 },
    dom: { scrollEnabled: false },
  });
  expect(screen.getByText('Kitchen')).toBeTruthy();

  await first.unmount();
  await render(ui(client));
  await screen.findByTestId('world-viewer');
  expect(fetchMock).toHaveBeenCalledTimes(1);
});

it('falls back to "Untitled scan" and a null floor plan', async () => {
  fetchMock.mockResolvedValue(ok({ world: world({ title: '  ', floorplan_meta: undefined }), assets: ASSETS }));
  await render(ui(newClient()));
  await screen.findByTestId('world-viewer');
  expect(viewerProps.current).toMatchObject({ title: 'Untitled scan', floorplanMeta: null });
});

it('404: this scan is not available', async () => {
  fetchMock.mockResolvedValue(fail(404, 'world_not_found'));
  await render(ui(newClient()));
  await screen.findByText("This scan isn't available");
  expect(screen.getByText('It may have been deleted.')).toBeTruthy();
  expect(screen.queryByRole('button', { name: 'Try again' })).toBeNull();
  expect(screen.queryByTestId('world-viewer')).toBeNull();
  expect(fetchMock).toHaveBeenCalledTimes(1); // 4xx is final, no retry
});

it('not ready: no viewer', async () => {
  fetchMock.mockResolvedValue(ok({ world: world({ status: 'processing' }), assets: {} }));
  await render(ui(newClient()));
  await screen.findByText("This scan isn't ready yet");
  expect(screen.getByText('Open it again from your Library when it says Ready.')).toBeTruthy();
  expect(screen.queryByTestId('world-viewer')).toBeNull();
});

it('network failure: retried twice, then Try again refetches', async () => {
  fetchMock.mockRejectedValue(new TypeError('Network request failed'));
  await render(ui(newClient()));
  await screen.findByText("Couldn't open this scan", {}, { timeout: 8000 });
  expect(fetchMock).toHaveBeenCalledTimes(3);

  fetchMock.mockResolvedValue(ok({ world: world(), assets: ASSETS }));
  await fireEvent.press(screen.getByRole('button', { name: 'Try again' }));
  await screen.findByTestId('world-viewer');
  expect(fetchMock).toHaveBeenCalledTimes(4);
});
