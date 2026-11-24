import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import { router } from 'expo-router';
import { Alert } from 'react-native';

import LibraryScreen from '@/app/(tabs)/index';
import { __setLocalScansForTest, getLocalScans } from '@/capture/store';
import type { LibraryItem, LocalScan } from '@/library/display-state';
import { apiFetch } from '@/lib/api';
import { endSession } from '@/lib/session';

jest.mock('@/config/api', () => ({ API_URL: 'https://api.test.invalid', APP_ENV: 'test' }));
jest.mock('@/lib/auth-client', () => ({
  authClient: { getCookie: jest.fn(async () => 'better-auth.session_token=abc') },
}));
jest.mock('@/lib/session', () => ({ endSession: jest.fn(async () => {}) }));
jest.mock('expo-router', () => ({ router: { push: jest.fn() } }));

const now = Date.now();
const iso = (minsAgo: number) => new Date(now - minsAgo * 60_000).toISOString();
const CREATED = '2026-11-20T10:00:00.000Z';
const date = new Date(CREATED).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });

const local = (id: string, title: string, over: Partial<LocalScan> = {}): LocalScan => ({
  id,
  sessionId: id,
  title,
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
  globalThis.fetch = fetchMock as unknown as typeof fetch;
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
    __setLocalScansForTest([local('l1', 'Hallway')]);
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
      screen.getByText('Walk slowly around a room with your phone, and it comes back here in 3D.'),
    ).toBeTruthy();
  });

  it('shows a spinner on first load', async () => {
    fetchMock.mockReturnValue(new Promise(() => {}));
    await renderLibrary();
    expect(screen.getByTestId('library-loading')).toBeTruthy();
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
    const client = await renderLibrary();
    await screen.findByText('Ready');

    fetchMock.mockRejectedValueOnce(new TypeError('Network request failed'));
    await act(async () => {
      await client.refetchQueries({ queryKey: ['worlds'] });
    });
    await screen.findByText("Couldn't refresh. Showing your last saved list.");
    expect(screen.getByText('Ready')).toBeTruthy();
  });

  it('ends the session with a notice on 401', async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 401, json: async () => ({}) } as Response);
    await renderLibrary();
    await waitFor(() => expect(endSession).toHaveBeenCalledWith({ notice: true }));
  });

  it('ends the session on 403 account_deleted (WR-02)', async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 403, json: async () => ({ error: 'account_deleted' }) } as Response);
    await renderLibrary();
    await waitFor(() => expect(endSession).toHaveBeenCalledWith({ notice: true }));
  });

  it('ApiError carries the server error code, and none for a non-JSON proxy body (iter-2 WR-01)', async () => {
    fetchMock.mockResolvedValueOnce({ ok: false, status: 404, json: async () => ({ error: 'world_not_found' }) } as Response);
    await expect(apiFetch('/v1/scans/x/uploads:missing')).rejects.toMatchObject({ status: 404, code: 'world_not_found' });
    fetchMock.mockResolvedValueOnce({ ok: false, status: 404, json: async (): Promise<unknown> => { throw new SyntaxError('html'); } } as Response);
    await expect(apiFetch('/v1/scans/x/uploads:missing')).rejects.toMatchObject({ status: 404, code: undefined });
  });

  it('labels rows, the more button and the progress bar', async () => {
    fetchMock.mockResolvedValue(page([w('Kitchen', { status: 'uploading', progress: 40 }), w('Attic', { status: 'cancelled' })]));
    await renderLibrary();
    await screen.findByText('Uploading · 40%');

    expect(screen.getByLabelText('Kitchen, Uploading · 40%')).toBeTruthy();
    expect(screen.getByLabelText(`Attic, Cancelled, ${date}`)).toBeTruthy();
    expect(screen.getByTestId('row-progress').props.accessibilityValue).toEqual({ min: 0, max: 100, now: 40 });

    const alertSpy = jest.spyOn(Alert, 'alert').mockImplementation(() => {});
    await fireEvent.press(screen.getByRole('button', { name: 'More actions for Kitchen' }));
    expect(alertSpy).toHaveBeenCalledWith('Kitchen', undefined, [
      expect.objectContaining({ text: 'Rename' }),
      expect.objectContaining({ text: 'Delete', style: 'destructive' }),
      expect.objectContaining({ text: 'Cancel', style: 'cancel' }),
    ]);
  });

  it('hides a local scan once the server row is past uploading', async () => {
    __setLocalScansForTest([
      local('l1', 'Hallway', { serverWorldId: 'Kitchen', uploadState: 'done' }),
      local('l2', 'Porch', { serverWorldId: 'Bedroom', uploadState: 'uploading' }),
    ]);
    fetchMock.mockResolvedValue(page([w('Kitchen', { status: 'processing' }), w('Bedroom', { status: 'uploading', progress: 10 })]));
    await renderLibrary();
    await screen.findByText('Kitchen');
    expect(screen.queryByText('Hallway')).toBeNull();
    expect(screen.getByText('Porch')).toBeTruthy();
    // The uploading server row is not listed twice (WR-01).
    expect(screen.queryByText('Bedroom')).toBeNull();    // The done entry is pruned from the store once its world is listed (WR-07).
    await waitFor(() => expect(getLocalScans().map((x) => x.id)).toEqual(['l2']));
  });

  it('local rows open their capture step; server rows are not buttons', async () => {
    __setLocalScansForTest([
      local('l1', 'Hallway'),
      local('l2', 'Porch', { uploadState: 'uploading', progress: { uploaded: 12, total: 32 } }),
    ]);
    fetchMock.mockResolvedValue(page([w('Kitchen', { status: 'ready' })]));
    await renderLibrary();
    await screen.findByText('Ready');
    expect(screen.getByText('Uploading · 38%')).toBeTruthy();

    await fireEvent.press(screen.getByRole('button', { name: /^Hallway, Saved on phone/ }));
    expect(router.push).toHaveBeenLastCalledWith({ pathname: '/capture/[id]', params: { id: 'l1', step: 'review' } });
    await fireEvent.press(screen.getByRole('button', { name: /^Porch, Uploading/ }));
    expect(router.push).toHaveBeenLastCalledWith({ pathname: '/capture/[id]', params: { id: 'l2', step: 'upload' } });
  });

  it('a ready server row opens the viewer; other server rows stay disabled (D-14)', async () => {
    fetchMock.mockResolvedValue(page([w('Kitchen', { status: 'ready' }), w('Bedroom', { status: 'processing' })]));
    await renderLibrary();
    await screen.findByText('Ready');

    const ready = screen.getByRole('button', { name: /^Kitchen, Ready/ });
    expect(ready.props.accessibilityHint).toBe('Opens the room');
    await fireEvent.press(ready);
    expect(router.push).toHaveBeenLastCalledWith({ pathname: '/world/[id]', params: { id: 'Kitchen' } });

    expect(screen.queryByRole('button', { name: /^Bedroom, Processing/ })).toBeNull();
    expect(screen.getByLabelText(/^Bedroom, Processing/)).toBeDisabled();
  });
});
