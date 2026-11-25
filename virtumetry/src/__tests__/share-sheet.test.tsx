import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import { Alert, Share as RNShare, type AlertButton } from 'react-native';

import ShareSheet from '@/app/world/[id]/share';
import { openCountLabel, type Share } from '@/lib/shares';

jest.mock('@/config/api', () => ({ API_URL: 'https://api.test.invalid', APP_ENV: 'test' }));
jest.mock('@/lib/auth-client', () => ({ authClient: { getCookie: jest.fn(async () => 'c=1') } }));
jest.mock('@/lib/session', () => ({ endSession: jest.fn(async () => {}) }));
jest.mock('expo-router', () => ({
  router: { back: jest.fn() },
  useLocalSearchParams: jest.fn(() => ({ id: 'w1' })),
}));

const BASE = 'https://api.test.invalid/v1/worlds/w1/shares';
const share = (id: string, over: Partial<Share> = {}): Share => ({
  id,
  slug: `slug-${id}`,
  url: `https://api.test.invalid/s/slug-${id}`,
  has_password: false,
  open_count: 0,
  created_at: '2026-11-24T10:00:00.000Z',
  revoked_at: null,
  ...over,
});
const date = new Date('2026-11-24T10:00:00.000Z').toLocaleDateString(undefined, {
  month: 'short',
  day: 'numeric',
  year: 'numeric',
});

const res = (status: number, body?: unknown) => ({ ok: status < 400, status, json: async () => body ?? {} }) as Response;

// Fake server: GET lists `server`; POST/DELETE go through `mutate`.
let server: Share[];
let mutate: jest.Mock;
let fetchMock: jest.Mock;
let alertSpy: jest.SpyInstance;
let shareSpy: jest.SpyInstance;

beforeEach(() => {
  server = [
    share('s2', { open_count: 3, has_password: true, created_at: '2026-11-24T11:00:00.000Z' }),
    share('s1', { open_count: 1 }),
    share('s0', { revoked_at: '2026-11-24T12:00:00.000Z' }),
  ];
  mutate = jest.fn();
  fetchMock = jest.fn(async (url: string, init: RequestInit = {}) => {
    if (!init.method || init.method === 'GET') return res(200, { shares: server });
    return mutate(url, init);
  });
  globalThis.fetch = fetchMock as unknown as typeof fetch;
  alertSpy = jest.spyOn(Alert, 'alert').mockImplementation(() => {});
  shareSpy = jest.spyOn(RNShare, 'share').mockResolvedValue({ action: 'dismissedAction', activityType: undefined });
});
afterEach(() => jest.restoreAllMocks());

async function renderSheet() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: Infinity }, mutations: { retry: false } },
  });
  await render(
    <QueryClientProvider client={client}>
      <ShareSheet />
    </QueryClientProvider>,
  );
}
const urls = () => screen.queryAllByText(/^https:\/\/api\.test\.invalid\/s\//).map((n) => n.props.children as string);
const createButton = () => screen.getByRole('button', { name: 'Create link' });
const calls = (method: string) => mutate.mock.calls.filter(([, init]) => init.method === method);
const lastButtons = () => (alertSpy.mock.calls.at(-1)?.[2] ?? []) as AlertButton[];
const pressAlert = async (text: string) => {
  const b = lastButtons().find((x) => x.text === text);
  if (!b) throw new Error(`no alert button ${text}`);
  await act(async () => b.onPress?.());
};

it('openCountLabel', () => {
  expect([0, 1, 5].map(openCountLabel)).toEqual(['Not opened yet', 'Opened 1 time', 'Opened 5 times']);
});

describe('list', () => {
  it('shows live links newest first with counts, dates and a lock only on password links', async () => {
    await renderSheet();
    await screen.findByText(server[0].url);
    expect(urls()).toEqual([server[0].url, server[1].url]);
    expect(screen.getByText(`Opened 3 times · Created ${date}`)).toBeTruthy();
    expect(screen.getByText(`Opened 1 time · Created ${date}`)).toBeTruthy();
    expect(screen.getAllByTestId('share-lock')).toHaveLength(1);
    expect(screen.getByLabelText(`${server[0].url}, password protected, Opened 3 times, created ${date}`)).toBeTruthy();
    expect(screen.getByLabelText(`${server[1].url}, Opened 1 time, created ${date}`)).toBeTruthy();
  });

  it('empty state', async () => {
    server = [];
    await renderSheet();
    expect(await screen.findByText('No links yet')).toBeTruthy();
    expect(
      screen.getByText('Create a link to let anyone who has it walk through this room in a browser.'),
    ).toBeTruthy();
  });

  it('load failure shows an error and Try again refetches', async () => {
    fetchMock.mockResolvedValueOnce(res(500));
    await renderSheet();
    expect(await screen.findByText("Couldn't load your links.")).toBeTruthy();
    await fireEvent.press(screen.getByRole('button', { name: 'Try again' }));
    await screen.findByText(server[0].url);
  });

  it('row share button opens the share sheet with that URL', async () => {
    await renderSheet();
    await screen.findByText(server[0].url);
    await fireEvent.press(screen.getAllByRole('button', { name: 'Share link' })[1]);
    expect(shareSpy).toHaveBeenCalledWith({ url: server[1].url });
  });

  it('Done goes back', async () => {
    const { router } = jest.requireMock('expo-router');
    await renderSheet();
    await fireEvent.press(screen.getByRole('button', { name: 'Done' }));
    expect(router.back).toHaveBeenCalled();
  });
});

describe('create', () => {
  it('without a password: POST {}, row on top, share sheet opens', async () => {
    const created = share('s3', { created_at: '2026-11-24T13:00:00.000Z' });
    mutate.mockImplementation(async () => {
      server = [created, ...server];
      return res(201, created);
    });
    await renderSheet();
    await screen.findByText(server[0].url);
    await fireEvent.press(createButton());

    await waitFor(() => expect(shareSpy).toHaveBeenCalledWith({ url: created.url }));
    const [[url, init]] = calls('POST');
    expect(url).toBe(BASE);
    expect(JSON.parse(init.body as string)).toEqual({});
    expect(urls()[0]).toBe(created.url);
  });

  it('with a password: needs 6+ chars, sends it, then clears the field and turns the switch off', async () => {
    const created = share('s3', { has_password: true });
    mutate.mockImplementation(async () => res(201, created));
    await renderSheet();
    await screen.findByText(server[0].url);

    const toggle = screen.getByLabelText('Protect with a password');
    await fireEvent(toggle, 'valueChange', true);
    const input = screen.getByLabelText('Password');
    expect(input.props.secureTextEntry).toBe(true);
    expect(input.props.maxLength).toBe(64);
    expect(
      screen.getByText("Send the password separately. You can't see it again after you create the link."),
    ).toBeTruthy();

    await fireEvent.changeText(input, 'abcde');
    expect(createButton().props.accessibilityState).toMatchObject({ disabled: true });
    await fireEvent(input, 'submitEditing');
    expect(screen.getByText('Use at least 6 characters.')).toBeTruthy();
    expect(mutate).not.toHaveBeenCalled();

    await fireEvent.changeText(input, 'abcdef');
    expect(createButton().props.accessibilityState).toMatchObject({ disabled: false });
    await fireEvent.press(createButton());

    await waitFor(() => expect(shareSpy).toHaveBeenCalledWith({ url: created.url }));
    expect(JSON.parse(calls('POST')[0][1].body as string)).toEqual({ password: 'abcdef' });
    expect(screen.queryByLabelText('Password')).toBeNull();
    expect(screen.getByLabelText('Protect with a password').props.value).toBe(false);
  });

  it('failure shows the create error and opens nothing', async () => {
    mutate.mockImplementation(async () => res(500));
    await renderSheet();
    await screen.findByText(server[0].url);
    await fireEvent.press(createButton());
    expect(
      await screen.findByText("Couldn't create the link. Check your connection and try again."),
    ).toBeTruthy();
    expect(shareSpy).not.toHaveBeenCalled();
  });
});

describe('revoke', () => {
  async function confirmRevokeFirst() {
    await renderSheet();
    await screen.findByText(server[0].url);
    await fireEvent.press(screen.getAllByRole('button', { name: 'Revoke link' })[0]);
    expect(alertSpy).toHaveBeenLastCalledWith(
      'Turn off this link?',
      "Anyone with it won't be able to open the room anymore. People who already have it open keep what's loaded. You can't undo this.",
      expect.any(Array),
    );
    expect(lastButtons().map((b) => [b.text, b.style])).toEqual([
      ['Keep link', 'cancel'],
      ['Revoke link', 'destructive'],
    ]);
  }

  it('Keep link sends nothing', async () => {
    await confirmRevokeFirst();
    await pressAlert('Keep link');
    expect(mutate).not.toHaveBeenCalled();
    expect(urls()).toHaveLength(2);
  });

  it('removes the row before the DELETE resolves', async () => {
    let resolve!: (r: Response) => void;
    mutate.mockReturnValue(new Promise<Response>((r) => (resolve = r)));
    await confirmRevokeFirst();
    const gone = server[0].url;
    await pressAlert('Revoke link');

    await waitFor(() => expect(screen.queryByText(gone)).toBeNull());
    const [[url, init]] = calls('DELETE');
    expect(url).toBe(`${BASE}/s2`);
    expect(init.body).toBeUndefined();

    server = server.map((s) => (s.id === 's2' ? { ...s, revoked_at: '2026-11-24T14:00:00.000Z' } : s));
    await act(async () => resolve(res(204)));
    await waitFor(() => expect(urls()).toEqual([server[1].url]));
  });

  it('a failed DELETE puts the row back with the error line', async () => {
    mutate.mockImplementation(async () => res(500));
    await confirmRevokeFirst();
    await pressAlert('Revoke link');
    expect(await screen.findByText("Couldn't turn off the link. It still works. Try again.")).toBeTruthy();
    expect(urls()).toEqual([server[0].url, server[1].url]);
  });
});
