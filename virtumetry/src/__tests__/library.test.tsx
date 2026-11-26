import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import { useNetworkState } from 'expo-network';
import { router } from 'expo-router';
import { Alert, StyleSheet } from 'react-native';

import LibraryScreen, { __resetBudgetBannerForTest } from '@/app/(tabs)/index';
import { __setLocalScansForTest, getLocalScans } from '@/capture/store';
import { __resetFirstRunForTest, markOnboarded, markOnboardingSkipped } from '@/design/first-run';
import { haptic } from '@/design/haptics';
import type { LibraryItem, LocalScan } from '@/library/display-state';
import { apiFetch, type BudgetAlert } from '@/lib/api';
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
  __resetBudgetBannerForTest();
  __resetFirstRunForTest();
  (router.push as jest.Mock).mockClear();
});
afterEach(() => {
  jest.restoreAllMocks();
  (useNetworkState as jest.Mock).mockReturnValue({ isConnected: true, isInternetReachable: true });
});

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
    expect(screen.getByText('Usually 30 min to 2 h')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'New scan' })).toBeTruthy();
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

  it('empty state after a finished intro: headline, body and CTA, no steps (critique F3)', async () => {
    markOnboardingSkipped(false);
    fetchMock.mockResolvedValue(page([]));
    await renderLibrary();
    await screen.findByText('No scans yet');
    expect(screen.queryByText('Scan the room slowly')).toBeNull();
    expect(screen.getByRole('button', { name: 'Scan a room' })).toBeTruthy();
  });

  it('shows the empty state with steps when the intro was skipped', async () => {
    markOnboardingSkipped(true);
    fetchMock.mockResolvedValue(page([]));
    await renderLibrary();
    await screen.findByText('No scans yet');
    expect(
      screen.getByText('Walk slowly around a room with your phone, and it comes back here in 3D.'),
    ).toBeTruthy();
    for (const step of ['Scan the room slowly', 'Check the cost, then approve', 'Walk, measure and share']) {
      expect(screen.getByText(step)).toBeTruthy();
    }
    // The EmptyState CTA is the single primary; the header button is hidden.
    expect(screen.queryByRole('button', { name: 'New scan' })).toBeNull();
    await fireEvent.press(screen.getByRole('button', { name: 'Scan a room' }));
    expect(router.push).toHaveBeenLastCalledWith('/capture/prep');
  });

  it('shows skeleton rows on first load', async () => {
    fetchMock.mockReturnValue(new Promise(() => {}));
    await renderLibrary();
    const loading = screen.getByTestId('library-loading');
    expect(loading.props.accessibilityLabel).toBe('Loading your scans');
    expect(loading.props.accessibilityState).toEqual({ busy: true });
  });

  it('offline with no cache says so and retries on Try again', async () => {
    (useNetworkState as jest.Mock).mockReturnValue({ isConnected: false, isInternetReachable: false });
    fetchMock.mockRejectedValue(new TypeError('Network request failed'));
    await renderLibrary();
    await screen.findByText("You're offline");
    expect(screen.getByText("Your scans show up here when you're back online.")).toBeTruthy();
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    await fireEvent.press(screen.getByRole('button', { name: 'Try again' }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
  });

  it('offline with a cached list shows the offline banner over the rows', async () => {
    (useNetworkState as jest.Mock).mockReturnValue({ isConnected: false, isInternetReachable: false });
    fetchMock.mockResolvedValue(page([w('Kitchen', { status: 'ready' })]));
    await renderLibrary();
    expect(await screen.findByText("You're offline. Showing your last saved list.")).toBeTruthy();
    expect(screen.getByText("Uploads resume when you're back online.")).toBeTruthy();
    expect(screen.getByText('Ready')).toBeTruthy();
    expect(screen.queryByText("Couldn't refresh. Showing your last saved list.")).toBeNull();
  });

  it('opens a new scan when onboarding left the scan intent', async () => {
    markOnboarded('scan');
    fetchMock.mockResolvedValue(page([]));
    await renderLibrary();
    expect(router.push).toHaveBeenCalledTimes(1);
    expect(router.push).toHaveBeenLastCalledWith('/capture/prep');
  });

  it('does not open a new scan without the intent', async () => {
    fetchMock.mockResolvedValue(page([]));
    await renderLibrary();
    await screen.findByText('No scans yet');
    expect(router.push).not.toHaveBeenCalled();
  });

  it('a world turning ready during the session fires one success haptic', async () => {
    const success = jest.spyOn(haptic, 'success').mockImplementation(() => {});
    fetchMock.mockResolvedValue(page([w('Kitchen', { status: 'processing' }), w('Attic', { status: 'ready' })]));
    const client = await renderLibrary();
    await screen.findByText('Processing · Building your 3D room');
    // Already ready on first load: no moment.
    expect(success).not.toHaveBeenCalled();

    fetchMock.mockResolvedValue(page([w('Kitchen', { status: 'ready' }), w('Attic', { status: 'ready' })]));
    await act(async () => {
      await client.refetchQueries({ queryKey: ['worlds'] });
    });
    await waitFor(() => expect(success).toHaveBeenCalledTimes(1));
    await act(async () => {
      await client.refetchQueries({ queryKey: ['worlds'] });
    });
    expect(success).toHaveBeenCalledTimes(1);
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

    fetchMock.mockResolvedValueOnce(page([w('Kitchen', { status: 'ready' })]));
    const calls = fetchMock.mock.calls.length;
    await fireEvent.press(screen.getByRole('button', { name: 'Refresh' }));
    await waitFor(() => expect(screen.queryByText("Couldn't refresh. Showing your last saved list.")).toBeNull());
    expect(fetchMock.mock.calls.length).toBe(calls + 1);
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

  it('titles unnamed scans by capture date and time; local rows show their first frame (critique F3)', async () => {
    __setLocalScansForTest([local('l1', '')]);
    fetchMock.mockResolvedValue(page([w('w1', { title: null, status: 'ready' })]));
    await renderLibrary();
    await screen.findByText('Ready');
    const when = new Date(CREATED).toLocaleString(undefined, { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' });
    expect(screen.getAllByText(when)).toHaveLength(2);
    expect(screen.queryByText(/Untitled/)).toBeNull();
    expect(screen.getByText('30 frames')).toBeTruthy();
    expect(JSON.stringify(screen.getByTestId('row-thumb').props.source)).toContain('file:///mock/document/sessions/l1/frames/000001.jpg');
  });

  it('a ready room with a thumbnail gets a full-width 16:10 frame; other rows stay compact (critique R3)', async () => {
    fetchMock.mockResolvedValue(
      page([w('Living room', { status: 'ready', assets: { thumbnail_url: 'https://r2.test.invalid/t.jpg' } as LibraryItem['assets'] }), w('Attic', { status: 'processing' })]),
    );
    await renderLibrary();
    await screen.findByText('Ready');
    const thumb = screen.getByTestId('row-thumb');
    expect(StyleSheet.flatten(thumb.props.style)).toMatchObject({ width: '100%', aspectRatio: 16 / 10 });
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

describe('budget banner (D-13)', () => {
  const daily: BudgetAlert = { window: 'daily', share: 0.8, spent: 820, budget: 1000 };
  const monthly: BudgetAlert = { window: 'monthly', share: 0.8, spent: 900, budget: 1000 };
  const withAlert = (budgetAlert: BudgetAlert | null, worlds = [w('Kitchen', { status: 'ready' })]) =>
    ok({ worlds, has_more: false, next_offset: null, budgetAlert });
  const dismiss = () => screen.getByRole('button', { name: 'Dismiss budget alert' });

  it('shows the daily percent and consequence', async () => {
    fetchMock.mockResolvedValue(withAlert(daily));
    await renderLibrary();
    expect(await screen.findByText("You've used 82% of today's processing budget.")).toBeTruthy();
    expect(screen.getByText('New scans may wait until tomorrow.')).toBeTruthy();
  });

  it('shows monthly copy, and "all of" at or over 100%', async () => {
    fetchMock.mockResolvedValue(withAlert({ ...monthly, spent: 1200 }));
    await renderLibrary();
    expect(await screen.findByText("You've used all of this month's processing budget.")).toBeTruthy();
    expect(screen.getByText('New scans may wait until next month.')).toBeTruthy();
  });

  it('is absent when budgetAlert is null or missing', async () => {
    fetchMock.mockResolvedValue(withAlert(null));
    await renderLibrary();
    await screen.findByText('Ready');
    expect(screen.queryByRole('button', { name: 'Dismiss budget alert' })).toBeNull();
  });

  it('stays dismissed for its window across refreshes; a monthly alert still shows', async () => {
    fetchMock.mockResolvedValue(withAlert(daily));
    const client = await renderLibrary();
    await screen.findByText("You've used 82% of today's processing budget.");
    await fireEvent.press(dismiss());
    expect(screen.queryByText(/today's processing budget/)).toBeNull();

    await act(async () => {
      await client.refetchQueries({ queryKey: ['worlds'] });
    });
    expect(screen.queryByText(/today's processing budget/)).toBeNull();

    fetchMock.mockResolvedValue(withAlert(monthly));
    await act(async () => {
      await client.refetchQueries({ queryKey: ['worlds'] });
    });
    expect(await screen.findByText("You've used 90% of this month's processing budget.")).toBeTruthy();
  });

  it('never shows in the empty state', async () => {
    fetchMock.mockResolvedValue(withAlert(daily, []));
    await renderLibrary();
    await screen.findByText('No scans yet');
    expect(screen.queryByText(/processing budget/)).toBeNull();
  });
});
