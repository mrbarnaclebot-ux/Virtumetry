import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import { useLocalSearchParams } from 'expo-router';

import CaptureScreen from '@/app/capture/[id]';
import { __setLocalScansForTest, getLocalScan, updateLocalScan } from '@/capture/store';
import type { LocalScan } from '@/library/display-state';
import type { Quote } from '@/lib/api';
import { kickUploadManager, useUploadProgress } from '@/upload/manager';

jest.mock('@/config/api', () => ({ API_URL: 'https://api.test.invalid', APP_ENV: 'test' }));
jest.mock('@/lib/auth-client', () => ({ authClient: { getCookie: jest.fn(async () => 'c=1') } }));
jest.mock('@/lib/session', () => ({ endSession: jest.fn(async () => {}) }));
jest.mock('@/upload/manager', () => ({ kickUploadManager: jest.fn(), useUploadProgress: jest.fn() }));
jest.mock('expo-router', () => ({
  router: { back: jest.fn(), replace: jest.fn(), push: jest.fn() },
  useLocalSearchParams: jest.fn(),
}));

const scan = (over: Partial<LocalScan> = {}): LocalScan => ({
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
  precheckIssues: [],
  uploadState: 'saved',
  ...over,
});

const QUOTE: Quote = { credits: 930, usd: 9.3, budgetRemaining: 4070, budgetWindow: 'daily', withinBudget: true };
const ok = (body: unknown) => ({ ok: true, status: 200, json: async () => body }) as Response;

let fetchMock: jest.Mock;
let quoteResponse: () => Promise<Response>;

const scanPosts = () => fetchMock.mock.calls.filter(([url, init]) => String(url).includes('/v1/scans') && init?.method === 'POST');

beforeEach(() => {
  jest.clearAllMocks();
  quoteResponse = async () => ok(QUOTE);
  fetchMock = jest.fn(async (url: string) => {
    if (url.includes('/v1/quote')) return quoteResponse();
    if (url.includes('/v1/scans')) return ok({ world: { id: 'w1', status: 'uploading' } });
    return { ok: false, status: 503, json: async () => ({}) };
  });
  globalThis.fetch = fetchMock as unknown as typeof fetch;
  (useUploadProgress as jest.Mock).mockReturnValue(undefined);
});

async function renderStep(step: 'quote' | 'upload', s: LocalScan = scan()) {
  (useLocalSearchParams as jest.Mock).mockReturnValue({ id: s.id, step });
  __setLocalScansForTest([s]);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity }, mutations: { gcTime: Infinity } } });
  await render(
    <QueryClientProvider client={client}>
      <CaptureScreen />
    </QueryClientProvider>,
  );
}

const approve = () => screen.getByRole('button', { name: 'Approve & process' });

describe('quote step', () => {
  it('Approve is disabled while the quote loads', async () => {
    quoteResponse = () => new Promise(() => {});
    await renderStep('quote');
    expect(screen.getByText('Getting quote…')).toBeTruthy();
    expect(approve()).toBeDisabled();
  });

  it('within budget: shows the quote; only the Approve tap creates the scan and starts the upload', async () => {
    await renderStep('quote');
    await screen.findByText('~930 credits');
    expect(screen.getByText('4,070 credits left today')).toBeTruthy();
    expect(fetchMock.mock.calls[0][0]).toContain('/v1/quote?frames=30');
    expect(approve()).toBeEnabled();
    expect(scanPosts()).toHaveLength(0);
    expect(kickUploadManager).not.toHaveBeenCalled();

    await fireEvent.press(approve());
    await waitFor(() => expect(kickUploadManager).toHaveBeenCalledTimes(1));
    const posts = scanPosts();
    expect(posts).toHaveLength(1);
    expect(posts[0][1].headers['Idempotency-Key']).toBe('s1');
    expect(JSON.parse(posts[0][1].body).approved_max_credits).toBe(930);
    expect(getLocalScan('s1')).toMatchObject({ uploadState: 'uploading', serverWorldId: 'w1', approvedMaxCredits: 930 });
    expect(await screen.findByText('Uploading')).toBeTruthy();
  });

  it('over the daily budget: Approve stays disabled with the reason', async () => {
    quoteResponse = async () => ok({ ...QUOTE, budgetRemaining: 100, withinBudget: false });
    await renderStep('quote');
    await screen.findByText("This scan would go over today's limit. Try again tomorrow.");
    expect(approve()).toBeDisabled();
    await fireEvent.press(approve());
    expect(scanPosts()).toHaveLength(0);
  });

  it('a refused create (4xx) puts the scan back to saved and says so', async () => {
    fetchMock.mockImplementation(async (url: string) =>
      url.includes('/v1/quote') ? ok(QUOTE) : { ok: false, status: 429, json: async () => ({}) },
    );
    await renderStep('quote');
    await screen.findByText('~930 credits');
    await fireEvent.press(approve());
    await screen.findByText("Couldn't start the upload. Check your connection and try again.");
    expect(getLocalScan('s1')?.uploadState).toBe('saved');
    expect(kickUploadManager).not.toHaveBeenCalled();
  });

  it('a refused inline create never reverts a scan the manager already created (iter-2 WR-02)', async () => {
    fetchMock.mockImplementation(async (url: string) => {
      if (url.includes('/v1/quote')) return ok(QUOTE);
      // A manager pass won the race and stored the world before this response landed.
      updateLocalScan('s1', { serverWorldId: 'w1', uploadState: 'uploading' });
      return { ok: false, status: 429, json: async () => ({ error: 'rate_limited' }) };
    });
    await renderStep('quote');
    await screen.findByText('~930 credits');
    await fireEvent.press(approve());
    await screen.findByText("Couldn't start the upload. Check your connection and try again.");
    expect(getLocalScan('s1')).toMatchObject({ uploadState: 'uploading', serverWorldId: 'w1' });
  });

  it('a lost create response keeps the approval durable for the manager (WR-02)', async () => {
    fetchMock.mockImplementation(async (url: string) => {
      if (url.includes('/v1/quote')) return ok(QUOTE);
      throw new TypeError('Network request failed');
    });
    await renderStep('quote');
    await screen.findByText('~930 credits');
    await fireEvent.press(approve());
    await waitFor(() => expect(kickUploadManager).toHaveBeenCalledTimes(1));
    expect(getLocalScan('s1')).toMatchObject({ uploadState: 'approved', approvedMaxCredits: 930 });
    expect(getLocalScan('s1')?.serverWorldId).toBeUndefined();
  });

  it('a quote error offers Try again', async () => {
    quoteResponse = async () => ({ ok: false, status: 500, json: async () => ({}) }) as Response;
    await renderStep('quote');
    await screen.findByText("Couldn't get a quote. Check your connection and try again.");
    expect(approve()).toBeDisabled();
    quoteResponse = async () => ok(QUOTE);
    await fireEvent.press(screen.getByRole('button', { name: 'Try again' }));
    await screen.findByText('~930 credits');
  });
});

describe('upload step', () => {
  it('shows percent, bar and file count from live progress', async () => {
    (useUploadProgress as jest.Mock).mockReturnValue({ uploaded: 12, total: 32 });
    await renderStep('upload', scan({ uploadState: 'uploading', serverWorldId: 'w1' }));
    expect(screen.getByText('Uploading · 38%')).toBeTruthy();
    expect(screen.getByText('12 of 32 files')).toBeTruthy();
    expect(screen.getByRole('progressbar').props.accessibilityValue).toMatchObject({ now: 38 });
    expect(
      screen.getByText('You can close this screen. The upload picks up where it left off when you open the app again.'),
    ).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Back to Library' })).toBeTruthy();
  });

  it('shows Uploading… before the first reconcile', async () => {
    await renderStep('upload', scan({ uploadState: 'approved' }));
    expect(screen.getByText('Uploading…')).toBeTruthy();
  });

  it('paused waits for a connection and keeps the stored progress', async () => {
    await renderStep('upload', scan({ uploadState: 'paused', progress: { uploaded: 5, total: 32 } }));
    expect(screen.getByText('Upload paused · Waiting for connection')).toBeTruthy();
    expect(screen.getByText('5 of 32 files')).toBeTruthy();
  });

  it('done hands off to processing', async () => {
    await renderStep('upload', scan({ uploadState: 'done' }));
    expect(screen.getByText('Uploaded · Processing started')).toBeTruthy();
    expect(screen.getByText("You'll see progress in your library.")).toBeTruthy();
  });

  it('blocked by checks shows the mapped reason and Not charged', async () => {
    await renderStep('upload', scan({ uploadState: 'blocked', failureCode: 'CAMERA_JUMP' }));
    expect(screen.getByText("Didn't pass checks")).toBeTruthy();
    expect(screen.getByText('The camera position jumped during the scan. Scan again, moving slowly.')).toBeTruthy();
    expect(screen.getByText('Not charged')).toBeTruthy();
  });

  it('other failures use the library failed copy', async () => {
    await renderStep('upload', scan({ uploadState: 'failed', failureCode: 'UPLOAD_STALE' }));
    expect(screen.getByText("Failed · Upload didn't finish")).toBeTruthy();
  });
});
