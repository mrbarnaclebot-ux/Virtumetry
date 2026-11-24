import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import { Alert, type AlertButton } from 'react-native';

import LibraryScreen from '@/app/(tabs)/index';
import type { LibraryItem } from '@/library/display-state';
import { __setLocalScansForTest } from '@/library/local-scans';

jest.mock('@/config/api', () => ({ API_URL: 'https://api.test.invalid', APP_ENV: 'test' }));
jest.mock('@/lib/auth-client', () => ({
  authClient: { getCookie: jest.fn(async () => 'better-auth.session_token=abc') },
}));
jest.mock('@/lib/session', () => ({ endSession: jest.fn(async () => {}) }));

const CREATED = '2026-11-20T10:00:00.000Z';

function w(id: string, title: string): LibraryItem {
  return {
    id,
    title,
    caption: null,
    status: 'ready',
    phase: null,
    progress: null,
    heartbeat_at: CREATED,
    created_at: CREATED,
    failure_stage: null,
    failure_code: null,
    failure_message: null,
    charged: true,
    eta_seconds: null,
    credits_spent: null,
    assets: {},
  };
}

const ok = (body: unknown) => ({ ok: true, status: 200, json: async () => body }) as Response;
const fail = (status: number) => ({ ok: false, status, json: async () => ({}) }) as Response;

// Fake server: GET lists `server`; PATCH/DELETE go through `mutate` so each test controls them.
let server: LibraryItem[];
let mutate: jest.Mock;
let fetchMock: jest.Mock;
let alertSpy: jest.SpyInstance;

beforeEach(() => {
  server = [w('w1', 'Kitchen'), w('w2', 'Bedroom'), w('w3', 'Garage')];
  mutate = jest.fn();
  fetchMock = jest.fn(async (url: string, init: RequestInit = {}) => {
    if (!init.method || init.method === 'GET') return ok({ worlds: server, has_more: false, next_offset: null });
    return mutate(url, init);
  });
  globalThis.fetch = fetchMock as unknown as typeof fetch;
  alertSpy = jest.spyOn(Alert, 'alert').mockImplementation(() => {});
  __setLocalScansForTest([]);
});
afterEach(() => jest.restoreAllMocks());

async function renderLibrary() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: Infinity }, mutations: { retry: false } },
  });
  await render(
    <QueryClientProvider client={client}>
      <LibraryScreen />
    </QueryClientProvider>,
  );
  await screen.findByText('Kitchen');
  return client;
}

/** Buttons of the most recent Alert.alert call. */
const lastButtons = () => (alertSpy.mock.calls.at(-1)?.[2] ?? []) as AlertButton[];
const press = async (text: string) => {
  const b = lastButtons().find((x) => x.text === text);
  if (!b) throw new Error(`no alert button ${text}`);
  await act(async () => b.onPress?.());
};
const openMenu = (title: string) =>
  fireEvent.press(screen.getByRole('button', { name: `More actions for ${title}` }));
const mutateCalls = (method: string) => mutate.mock.calls.filter(([, init]) => init.method === method);

describe('row action menu', () => {
  it('offers Rename, Delete (destructive) and Cancel', async () => {
    await renderLibrary();
    await openMenu('Kitchen');
    expect(alertSpy).toHaveBeenLastCalledWith('Kitchen', undefined, expect.any(Array));
    expect(lastButtons().map((b) => [b.text, b.style])).toEqual([
      ['Rename', undefined],
      ['Delete', 'destructive'],
      ['Cancel', 'cancel'],
    ]);
  });
});

describe('rename', () => {
  async function openRename() {
    await renderLibrary();
    await openMenu('Kitchen');
    await press('Rename');
    await screen.findByText('Rename scan');
    return screen.getByLabelText('Scan name');
  }
  const saveButton = () => screen.getByRole('button', { name: 'Save Name' });

  it('prefills the title with a counter and disables Save Name for empty or unchanged names', async () => {
    const input = await openRename();
    expect(input.props.value).toBe('Kitchen');
    expect(input.props.maxLength).toBe(80);
    expect(screen.getByText('7/80')).toBeTruthy();
    expect(saveButton().props.accessibilityState).toMatchObject({ disabled: true });

    await fireEvent.changeText(input, '');
    expect(saveButton().props.accessibilityState).toMatchObject({ disabled: true });
    await fireEvent.changeText(input, '   ');
    expect(saveButton().props.accessibilityState).toMatchObject({ disabled: true });
    await fireEvent.changeText(input, 'Den');
    expect(saveButton().props.accessibilityState).toMatchObject({ disabled: false });
    expect(screen.getByText('3/80')).toBeTruthy();
  });

  it('PATCHes the new title and shows the server name after saving', async () => {
    mutate.mockImplementation(async (_url, init) => {
      const { title } = JSON.parse(init.body);
      server = server.map((x) => (x.id === 'w1' ? { ...x, title } : x));
      return ok(server[0]);
    });
    const input = await openRename();
    await fireEvent.changeText(input, ' Den ');
    await fireEvent.press(saveButton());

    await waitFor(() => expect(screen.queryByText('Rename scan')).toBeNull());
    const [[url, init]] = mutateCalls('PATCH');
    expect(url).toBe('https://api.test.invalid/v1/worlds/w1');
    expect(JSON.parse(init.body as string)).toEqual({ title: 'Den' });
    expect(await screen.findByText('Den')).toBeTruthy();
    expect(screen.queryByText('Kitchen')).toBeNull();
  });

  it.each([
    ['a server error', async () => fail(500)],
    ['a network error', async () => Promise.reject(new TypeError('Network request failed'))],
  ])('keeps the modal open with the error on %s', async (_label, impl) => {
    mutate.mockImplementation(impl);
    const input = await openRename();
    await fireEvent.changeText(input, 'Den');
    await fireEvent.press(saveButton());
    expect(await screen.findByText("Couldn't rename. Check your connection and try again.")).toBeTruthy();
    expect(screen.getByText('Rename scan')).toBeTruthy();
  });

  it('Cancel closes the modal without a request', async () => {
    const input = await openRename();
    await fireEvent.changeText(input, 'Den');
    await fireEvent.press(screen.getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByText('Rename scan')).toBeNull());
    expect(mutate).not.toHaveBeenCalled();
    expect(screen.getByText('Kitchen')).toBeTruthy();
  });

  it('shows the empty error when Done is pressed on an empty field', async () => {
    const input = await openRename();
    await fireEvent.changeText(input, '  ');
    await fireEvent(input, 'submitEditing');
    expect(screen.getByText("Name can't be empty.")).toBeTruthy();
    expect(mutate).not.toHaveBeenCalled();
  });
});
