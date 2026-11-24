import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import { ActivityIndicator, Alert, RefreshControl } from 'react-native';

import LibraryScreen from '@/app/(tabs)/index';
import type { LibraryItem } from '@/library/display-state';
import { __setLocalScansForTest } from '@/library/local-scans';
import { endSession } from '@/lib/session';

jest.mock('@/config/api', () => ({ API_URL: 'https://api.test.invalid', APP_ENV: 'test' }));
jest.mock('@/lib/auth-client', () => ({
  authClient: { getCookie: jest.fn(async () => 'better-auth.session_token=abc') },
}));
jest.mock('@/lib/session', () => ({ endSession: jest.fn(async () => {}) }));

const now = Date.now();
const iso = (minsAgo: number) => new Date(now - minsAgo * 60_000).toISOString();
const CREATED = '2026-11-20T10:00:00.000Z';
const date = new Date(CREATED).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });

function w(id: string, over: Partial<LibraryItem>): LibraryItem {
  return {
    id,
    title: id,
    caption: null,
    status: 'processing',
    phase: null,
    progress: null,
    heartbeat_at: iso(1),
    created_at: CREATED,
    failure_stage: null,
    failure_code: null,
    failure_message: null,
    charged: false,
    eta_seconds: null,
    credits_spent: null,
    assets: {},
    ...over,
  };
}

const LIST = [
  w('Kitchen', { status: 'uploading', progress: 40 }),
  w('Bedroom', { status: 'processing' }),
  w('Living room', { status: 'ready', assets: { thumbnail_url: 'https://r2.test.invalid/t.jpg' } }),
  w('Garage', { status: 'failed', failure_code: 'WORLD_GENERATION_FAILED', failure_message: 'RAW provider text' }),
  w('Attic', { status: 'cancelled' }),
];

const ok = (body: unknown) => ({ ok: true, status: 200, json: async () => body }) as Response;
const page = (worlds: LibraryItem[]) => ok({ worlds, has_more: false, next_offset: null });

let fetchMock: jest.Mock;

beforeEach(() => {
  fetchMock = jest.fn();
  global.fetch = fetchMock as unknown as typeof fetch;
  (endSession as jest.Mock).mockClear();
  __setLocalScansForTest([]);
});
afterEach(() => jest.restoreAllMocks());

async function renderLibrary() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } });
  await render(
    <QueryClientProvider client={client}>
      <LibraryScreen />
    </QueryClientProvider>,
  );
  return client;
}

describe('library screen', () => {
  it('renders every state, with local scans first', async () => {
    __setLocalScansForTest([{ id: 'l1', title: 'Hallway', createdAt: CREATED }]);
    fetchMock.mockResolvedValue(page(LIST));
    await renderLibrary();

    await screen.findByText('Uploading · 40%');
    expect(screen.getByText('Processing · Building your 3D room')).toBeTruthy();
    expect(screen.getByText('Usually 30 min – 2 h')).toBeTruthy();
    expect(screen.getByText('Ready')).toBeTruthy();
    expect(screen.getByText("Failed · The scan couldn't be turned into a room")).toBeTruthy();
    expect(screen.getByText(`Not charged · ${date}`)).toBeTruthy();
    expect(screen.getByText('Cancelled')).toBeTruthy();
    expect(screen.queryByText(/RAW provider text/)).toBeNull();

    const titles = screen.getAllByText(/^(Hallway|Kitchen|Bedroom|Living room|Garage|Attic)$/).map(
      (n) => n.props.children,
    );
    expect(titles[0]).toBe('Hallway');
    expect(screen.getByText('Saved on phone · Not uploaded')).toBeTruthy();
  });

  it('calls GET /v1/worlds with the session cookie and credentials omit', async () => {
    fetchMock.mockResolvedValue(page([]));
    await renderLibrary();
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://api.test.invalid/v1/worlds?limit=100');
    expect(init.credentials).toBe('omit');
    expect(init.headers.Cookie).toBe('better-auth.session_token=abc');
  });

  it('shows the empty state when there are no scans', async () => {
    fetchMock.mockResolvedValue(page([]));
    await renderLibrary();
    await screen.findByText('No scans yet');
    expect(
      screen.getByText('Scans you capture show up here, with their progress and status. Pull down to refresh.'),
    ).toBeTruthy();
  });

  it('shows a spinner on first load', async () => {
    fetchMock.mockReturnValue(new Promise(() => {}));
    await renderLibrary();
    expect(screen.UNSAFE_getByType(ActivityIndicator)).toBeTruthy();
  });

  it('shows the error block with no cache and retries on Try again', async () => {
    fetchMock.mockRejectedValueOnce(new TypeError('Network request failed'));
    await renderLibrary();
    await screen.findByText("Couldn't load your scans");
    expect(screen.getByText('Check your connection, then try again.')).toBeTruthy();

    fetchMock.mockResolvedValueOnce(page([]));
    await fireEvent.press(screen.getByRole('button', { name: 'Try again' }));
    await screen.findByText('No scans yet');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('keeps the list and shows the refresh error when a refresh fails', async () => {
    fetchMock.mockResolvedValueOnce(page([w('Kitchen', { status: 'ready' })]));
    await renderLibrary();
    await screen.findByText('Ready');

    fetchMock.mockRejectedValueOnce(new TypeError('Network request failed'));
    const refresh = screen.UNSAFE_getByType(RefreshControl);
    await act(async () => {
      await refresh.props.onRefresh();
    });
    await screen.findByText("Couldn't refresh. Showing your last saved list.");
    expect(screen.getByText('Ready')).toBeTruthy();
  });

  it('ends the session with a notice on 401', async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 401, json: async () => ({}) } as Response);
    await renderLibrary();
    await waitFor(() => expect(endSession).toHaveBeenCalledWith({ notice: true }));
  });

  it('labels rows, the more button and the progress bar', async () => {
    fetchMock.mockResolvedValue(page([w('Kitchen', { status: 'uploading', progress: 40 }), w('Attic', { status: 'cancelled' })]));
    await renderLibrary();
    await screen.findByText('Uploading · 40%');

    expect(screen.getByLabelText('Kitchen, Uploading · 40%')).toBeTruthy();
    expect(screen.getByLabelText(`Attic, Cancelled, ${date}`)).toBeTruthy();
    expect(screen.getByRole('progressbar').props.accessibilityValue).toEqual({ min: 0, max: 100, now: 40 });

    const alertSpy = jest.spyOn(Alert, 'alert').mockImplementation(() => {});
    await fireEvent.press(screen.getByRole('button', { name: 'More actions for Kitchen' }));
    expect(alertSpy).toHaveBeenCalledWith('Kitchen', undefined, [
      expect.objectContaining({ text: 'Cancel', style: 'cancel' }),
    ]);
  });
});
