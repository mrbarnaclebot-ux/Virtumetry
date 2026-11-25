import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import { router, useLocalSearchParams } from 'expo-router';

import RetrySheet from '@/app/world/[id]/retry';
import type { LibraryItem } from '@/library/display-state';
import type { Quote } from '@/lib/api';

jest.mock('@/config/api', () => ({ API_URL: 'https://api.test.invalid', APP_ENV: 'test' }));
jest.mock('@/lib/auth-client', () => ({ authClient: { getCookie: jest.fn(async () => 'c=1') } }));
jest.mock('@/lib/session', () => ({ endSession: jest.fn(async () => {}) }));
jest.mock('expo-router', () => ({
  router: { back: jest.fn(), replace: jest.fn(), push: jest.fn() },
  useLocalSearchParams: jest.fn(),
}));

const world = (over: Partial<LibraryItem> = {}): LibraryItem => ({
  id: 'w1',
  title: 'Kitchen',
  caption: null,
  status: 'failed',
  phase: null,
  progress: null,
  heartbeat_at: '2026-11-24T10:00:00.000Z',
  created_at: '2026-11-24T10:00:00.000Z',
  failure_stage: 'submit',
  failure_code: 'PROVIDER_UNAVAILABLE',
  failure_message: 'raw provider text',
  charged: false,
  eta_seconds: null,
  credits_spent: null,
  assets: {},
  retryable: true,
  submit_attempt: 1,
  frame_count: 30,
  ...over,
});

const QUOTE: Quote = { credits: 930, usd: 9.3, budgetRemaining: 4070, budgetWindow: 'daily', withinBudget: true };
const ok = (body: unknown) => ({ ok: true, status: 200, json: async () => body }) as Response;
const fail = (status: number, body: unknown = {}) => ({ ok: false, status, json: async () => body }) as Response;

let fetchMock: jest.Mock;
let worlds: LibraryItem[];
let quoteResponse: () => Promise<Response>;
let retryResponse: () => Promise<Response>;
let detailResponse: () => Promise<Response>;

const calls = (part: string, method?: string) =>
  fetchMock.mock.calls.filter(([url, init]) => String(url).includes(part) && (!method || init?.method === method));
const quoteCalls = () => calls('/v1/quote');
const retryPosts = () => calls('/v1/worlds/w1/retry', 'POST');

beforeEach(() => {
  jest.clearAllMocks();
  (useLocalSearchParams as jest.Mock).mockReturnValue({ id: 'w1' });
  worlds = [world()];
  quoteResponse = async () => ok(QUOTE);
  retryResponse = async () => ok({ world: world({ status: 'submitting', retryable: false }) });
  detailResponse = async () => fail(503);
  fetchMock = jest.fn(async (url: string) => {
    if (url.includes('/v1/quote')) return quoteResponse();
    if (url.includes('/retry')) return retryResponse();
    if (url.includes('/v1/worlds?')) return ok({ worlds, has_more: false, next_offset: null, budgetAlert: null });
    if (url.includes('/v1/worlds/')) return detailResponse();
    return fail(503);
  });
  globalThis.fetch = fetchMock as unknown as typeof fetch;
});

async function renderSheet() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity }, mutations: { gcTime: Infinity } } });
  const invalidate = jest.spyOn(client, 'invalidateQueries');
  await render(
    <QueryClientProvider client={client}>
      <RetrySheet />
    </QueryClientProvider>,
  );
  return { invalidate };
}

const approve = () => screen.getByRole('button', { name: 'Approve and retry' });

describe('retryable failure', () => {
  it('shows reason, guidance, charge line and one fresh quote', async () => {
    await renderSheet();
    await screen.findByText('~930 credits');
    expect(screen.getByText('Retry processing')).toBeTruthy();
    expect(screen.getByText('Failed · Something went wrong while processing')).toBeTruthy();
    expect(screen.getByText('The processing service had a problem on its side. Trying again often works.')).toBeTruthy();
    expect(screen.getByText('Not charged for this run')).toBeTruthy();
    expect(screen.getByText(/This retry will use/)).toBeTruthy();
    expect(screen.getByText('This is a new paid run. Nothing is charged until you approve.')).toBeTruthy();
    expect(screen.queryByText('raw provider text')).toBeNull();
    expect(quoteCalls()).toHaveLength(1);
    expect(quoteCalls()[0][0]).toContain('/v1/quote?frames=30');
    expect(approve()).toBeEnabled();
  });

  it('over the daily budget: Approve and retry stays disabled', async () => {
    quoteResponse = async () => ok({ ...QUOTE, budgetRemaining: 100, withinBudget: false });
    await renderSheet();
    await screen.findByText("This retry would go over today's limit. Try again tomorrow.");
    expect(approve()).toBeDisabled();
  });

  it('two presses after a network error reuse one Idempotency-Key and the quoted credits', async () => {
    retryResponse = async () => {
      throw new TypeError('Network request failed');
    };
    await renderSheet();
    await screen.findByText('~930 credits');
    await fireEvent.press(approve());
    await screen.findByText("Couldn't start the retry. Check your connection and try again.");
    await waitFor(() => expect(approve()).toBeEnabled());
    await fireEvent.press(approve());
    await waitFor(() => expect(retryPosts()).toHaveLength(2));
    const [a, b] = retryPosts().map(([, init]) => init);
    expect(a.headers['Idempotency-Key']).toBeTruthy();
    expect(b.headers['Idempotency-Key']).toBe(a.headers['Idempotency-Key']);
    expect(JSON.parse(a.body)).toEqual({ approved_max_credits: 930 });
    expect(JSON.parse(b.body)).toEqual({ approved_max_credits: 930 });
  });

  it('409 not_retryable hides the primary and turns Cancel into Close', async () => {
    retryResponse = async () => fail(409, { error: 'not_retryable' });
    await renderSheet();
    await screen.findByText('~930 credits');
    await fireEvent.press(approve());
    await screen.findByText("This scan can't be retried anymore. Close this and check its status in your Library.");
    expect(screen.queryByRole('button', { name: 'Approve and retry' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Close' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Cancel' })).toBeNull();
  });

  it('approval_below_quote says the cost changed and refetches the quote', async () => {
    retryResponse = async () => fail(400, { error: 'approval_below_quote', quote_credits: 1000 });
    await renderSheet();
    await screen.findByText('~930 credits');
    await fireEvent.press(approve());
    await screen.findByText('The cost changed. Check the new quote, then approve again.');
    await waitFor(() => expect(quoteCalls()).toHaveLength(2));
  });

  it('429 asks to wait', async () => {
    retryResponse = async () => fail(429, { error: 'rate_limited' });
    await renderSheet();
    await screen.findByText('~930 credits');
    await fireEvent.press(approve());
    await screen.findByText('Too many tries. Wait a minute, then try again.');
  });

  it('success invalidates the worlds query and goes back', async () => {
    const { invalidate } = await renderSheet();
    await screen.findByText('~930 credits');
    await fireEvent.press(approve());
    await waitFor(() => expect(router.back).toHaveBeenCalledTimes(1));
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['worlds'] });
  });
});

describe('non-retryable failure', () => {
  it.each([[false], [undefined]])('retryable=%s: guidance and Scan again, never a quote', async (retryable) => {
    worlds = [world({ retryable, failure_stage: 'validate', failure_code: 'CAMERA_JUMP' })];
    await renderSheet();
    await screen.findByText('Scan failed');
    expect(
      screen.getByText("This capture can't be turned into a room. Scan again: move slowly, keep the room well lit and cover every wall."),
    ).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Close' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Approve and retry' })).toBeNull();
    await fireEvent.press(screen.getByRole('button', { name: 'Scan again' }));
    expect(router.replace).toHaveBeenCalledWith('/capture/prep');
    expect(quoteCalls()).toHaveLength(0);
  });
});

describe('world load', () => {
  it('missing from the list and detail fails: error with Try again', async () => {
    worlds = [];
    await renderSheet();
    await screen.findByText("Couldn't open this scan. Check your connection, then try again.");
    expect(screen.getByRole('button', { name: 'Try again' })).toBeTruthy();
    expect(quoteCalls()).toHaveLength(0);
  });

  it('missing from the list falls back to the detail endpoint', async () => {
    worlds = [];
    detailResponse = async () => ok({ world: world(), assets: {} });
    await renderSheet();
    await screen.findByText('~930 credits');
  });
});
