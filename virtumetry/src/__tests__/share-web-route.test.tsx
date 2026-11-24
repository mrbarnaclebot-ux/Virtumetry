import { act, fireEvent, render, screen } from '@testing-library/react-native';

import SharePage from '@/app/r/[slug]';
import type { ViewerProps } from '@/viewer/types';

const viewer: { current: ViewerProps | null } = { current: null };

jest.mock('@/viewer/world-viewer', () => {
  const { View } = jest.requireActual('react-native');
  return {
    __esModule: true,
    default: function MockViewer(p: ViewerProps) {
      viewer.current = p;
      return <View testID="world-viewer" />;
    },
  };
});
jest.mock('@/config/api', () => ({ API_URL: 'https://api.test.invalid', APP_ENV: 'test' }));
jest.mock('@/lib/auth-client', () => ({ authClient: { getCookie: jest.fn(async () => 'c=1') } }));
jest.mock('@/lib/session', () => ({ endSession: jest.fn(async () => {}) }));
jest.mock('expo-router', () => ({ useLocalSearchParams: jest.fn(() => ({ slug: 'AAAAAAAAAAAAAAAAAAAAAA' })) }));
jest.mock('expo-router/head', () => ({ __esModule: true, default: () => null }));

const BASE = 'https://api.test.invalid/v1/public/shares/AAAAAAAAAAAAAAAAAAAAAA';
const META = { scene_bounds: { min: [-2, 0, -2], max: [2, 2.5, 2] } };
const OPEN = {
  title: 'Kitchen',
  floorplan_meta: META,
  assets: {
    splat_url: 'https://r2.test.invalid/splat.ply',
    collider_url: 'https://r2.test.invalid/collider.ply',
    floorplan_url: 'https://r2.test.invalid/floorplan.png',
    cameras_url: 'https://r2.test.invalid/cameras.json',
  },
};

const ok = (body: unknown) => ({ ok: true, status: 200, json: async () => body }) as Response;
const fail = (status: number, error: string) => ({ ok: false, status, json: async () => ({ error }) }) as Response;

let fetchMock: jest.Mock;
beforeEach(() => {
  viewer.current = null;
  fetchMock = jest.fn();
  globalThis.fetch = fetchMock as unknown as typeof fetch;
});

const bodyOf = (call: unknown[]) => (call[1] as RequestInit).body;

it('shows a spinner while the link is checked', async () => {
  fetchMock.mockReturnValue(new Promise(() => {}));
  await render(<SharePage />);
  expect(screen.getByTestId('share-checking')).toBeTruthy();
});

it('opens an unprotected link without a password or cookie and mounts the viewer', async () => {
  fetchMock.mockResolvedValueOnce(ok({ title: 'Kitchen', needs_password: false })).mockResolvedValueOnce(ok(OPEN));
  await render(<SharePage />);
  expect(await screen.findByTestId('world-viewer')).toBeTruthy();

  expect(fetchMock.mock.calls[0][0]).toBe(BASE);
  expect(fetchMock.mock.calls[1][0]).toBe(`${BASE}/open`);
  expect(JSON.parse(bodyOf(fetchMock.mock.calls[1]) as string)).toEqual({});
  for (const [, init] of fetchMock.mock.calls) {
    expect(init.credentials).toBe('omit');
    expect(JSON.stringify(init.headers ?? {})).not.toMatch(/cookie/i);
  }
  expect(viewer.current).toMatchObject({
    splatUrl: OPEN.assets.splat_url,
    colliderUrl: OPEN.assets.collider_url,
    floorplanUrl: OPEN.assets.floorplan_url,
    camerasUrl: OPEN.assets.cameras_url,
    floorplanMeta: META,
    title: 'Kitchen',
    insets: { top: 44, bottom: 0 },
  });
  expect(screen.getByRole('header', { name: 'Kitchen' })).toBeTruthy();
});

it('says a dead link is no longer available', async () => {
  fetchMock.mockResolvedValueOnce(fail(404, 'share_not_found'));
  await render(<SharePage />);
  expect(await screen.findByText('This link is no longer available')).toBeTruthy();
  expect(screen.getByText('The owner may have turned it off. Ask them for a new link.')).toBeTruthy();
  expect(screen.queryByRole('button')).toBeNull();
});

it('retries after a network error', async () => {
  fetchMock
    .mockRejectedValueOnce(new TypeError('Network request failed'))
    .mockResolvedValueOnce(ok({ title: 'Kitchen', needs_password: false }))
    .mockResolvedValueOnce(ok(OPEN));
  await render(<SharePage />);
  expect(await screen.findByText("Couldn't open this room")).toBeTruthy();
  await act(async () => fireEvent.press(screen.getByRole('button', { name: 'Try again' })));
  expect(await screen.findByTestId('world-viewer')).toBeTruthy();
});

it('gates a protected room: wrong password clears the field, right one opens', async () => {
  fetchMock
    .mockResolvedValueOnce(ok({ title: 'Kitchen', needs_password: true }))
    .mockResolvedValueOnce(fail(401, 'wrong_password'))
    .mockResolvedValueOnce(ok(OPEN));
  await render(<SharePage />);
  expect(await screen.findByText('This room is password protected')).toBeTruthy();

  const input = screen.getByLabelText('Password');
  await act(async () => fireEvent.changeText(input, 'nope'));
  await act(async () => fireEvent.press(screen.getByRole('button', { name: 'Open room' })));
  expect(await screen.findByText("That password isn't right. Try again.")).toBeTruthy();
  expect(screen.getByLabelText('Password').props.value).toBe('');
  expect(JSON.parse(bodyOf(fetchMock.mock.calls[1]) as string)).toEqual({ password: 'nope' });

  await act(async () => fireEvent.changeText(screen.getByLabelText('Password'), 'abcd'));
  await act(async () => fireEvent(screen.getByLabelText('Password'), 'submitEditing'));
  expect(await screen.findByTestId('world-viewer')).toBeTruthy();
  expect(JSON.parse(bodyOf(fetchMock.mock.calls[2]) as string)).toEqual({ password: 'abcd' });
});

it('tells the visitor to wait when rate limited', async () => {
  fetchMock
    .mockResolvedValueOnce(ok({ title: 'Kitchen', needs_password: true }))
    .mockResolvedValueOnce(fail(429, 'rate_limited'));
  await render(<SharePage />);
  await act(async () => fireEvent.changeText(await screen.findByLabelText('Password'), 'x1234'));
  await act(async () => fireEvent.press(screen.getByRole('button', { name: 'Open room' })));
  expect(await screen.findByText('Too many tries. Wait a minute, then try again.')).toBeTruthy();
});

it('shows the reload block when the viewer loses its context', async () => {
  fetchMock.mockResolvedValueOnce(ok({ title: 'Kitchen', needs_password: false })).mockResolvedValueOnce(ok(OPEN));
  await render(<SharePage />);
  await screen.findByTestId('world-viewer');
  await act(async () => viewer.current!.onError!({ code: 'context_lost' }));
  expect(screen.getByText('The viewer stopped working')).toBeTruthy();
  expect(screen.getByRole('button', { name: 'Reload page' })).toBeTruthy();
});

it('re-opens once for fresh URLs when an asset fetch fails after 14 minutes', async () => {
  const now = jest.spyOn(Date, 'now').mockReturnValue(1_000_000);
  const fresh = { ...OPEN, assets: { ...OPEN.assets, splat_url: 'https://r2.test.invalid/splat2.ply' } };
  fetchMock
    .mockResolvedValueOnce(ok({ title: 'Kitchen', needs_password: false }))
    .mockResolvedValueOnce(ok(OPEN))
    .mockResolvedValueOnce(ok(fresh));
  await render(<SharePage />);
  await screen.findByTestId('world-viewer');

  now.mockReturnValue(1_000_000 + 15 * 60_000);
  await act(async () => viewer.current!.onError!({ code: 'load_failed' }));
  expect(fetchMock).toHaveBeenCalledTimes(3);
  expect(viewer.current!.splatUrl).toBe(fresh.assets.splat_url);

  await act(async () => viewer.current!.onError!({ code: 'load_failed' }));
  expect(fetchMock).toHaveBeenCalledTimes(3);
  now.mockRestore();
});
