import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import { Directory, Paths } from 'expo-file-system';
import { router } from 'expo-router';
import { Alert, type AlertButton } from 'react-native';

import LibraryScreen from '@/app/(tabs)/index';
import { __setLocalScansForTest, getLocalScans } from '@/capture/store';
import { __resetToastsForTest, toast } from '@/components/ui/toast';
import type { LibraryItem, LocalScan } from '@/library/display-state';

jest.mock('@/config/api', () => ({ API_URL: 'https://api.test.invalid', APP_ENV: 'test' }));
jest.mock('@/lib/auth-client', () => ({
  authClient: { getCookie: jest.fn(async () => 'better-auth.session_token=abc') },
}));
jest.mock('@/lib/session', () => ({ endSession: jest.fn(async () => {}) }));
jest.mock('expo-router', () => ({ router: { push: jest.fn() } }));

const CREATED = '2026-11-20T10:00:00.000Z';

const local = (id: string, title: string): LocalScan => ({
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
});

function w(id: string, title: string, over: Partial<LibraryItem> = {}): LibraryItem {
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
    ...over,
  };
}

const ok = (body: unknown) => ({ ok: true, status: 200, json: async () => body }) as Response;
const fail = (status: number) => ({ ok: false, status, json: async () => ({}) }) as Response;

// Fake server: GET lists `server`; PATCH/DELETE go through `mutate` so each test controls them.
let server: LibraryItem[];
let mutate: jest.Mock;
let fetchMock: jest.Mock;
let alertSpy: jest.SpyInstance;
let toastSuccess: jest.SpyInstance;
let toastError: jest.SpyInstance;

beforeEach(() => {
  server = [w('w1', 'Kitchen'), w('w2', 'Bedroom'), w('w3', 'Garage')];
  mutate = jest.fn();
  fetchMock = jest.fn(async (url: string, init: RequestInit = {}) => {
    if (!init.method || init.method === 'GET') return ok({ worlds: server, has_more: false, next_offset: null });
    return mutate(url, init);
  });
  globalThis.fetch = fetchMock as unknown as typeof fetch;
  alertSpy = jest.spyOn(Alert, 'alert').mockImplementation(() => {});
  __resetToastsForTest();
  toastSuccess = jest.spyOn(toast, 'success').mockImplementation(() => {});
  toastError = jest.spyOn(toast, 'error').mockImplementation(() => {});
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

describe('failed rows and Retry… (D-11)', () => {
  const failed = (retryable: boolean | undefined) =>
    w('w1', 'Kitchen', {
      status: 'failed',
      charged: false,
      failure_stage: 'provider',
      failure_code: 'WORLD_GENERATION_FAILED',
      ...(retryable === undefined ? {} : { retryable }),
    });
  const RETRY = { pathname: '/world/[id]/retry', params: { id: 'w1' } };
  const row = () => screen.getByRole('button', { name: /^Kitchen, Failed/ });
  const more = () => screen.getByRole('button', { name: 'More actions for Kitchen' });
  beforeEach(() => (router.push as jest.Mock).mockClear());

  it('a retryable failed row opens the retry sheet and the menu starts with Retry…', async () => {
    server = [failed(true)];
    await renderLibrary();
    expect(row().props.accessibilityHint).toBe('Shows the cost to try again');
    await fireEvent.press(row());
    expect(router.push).toHaveBeenLastCalledWith(RETRY);

    expect(more().props.accessibilityHint).toBe('Retry, rename or delete');
    await openMenu('Kitchen');
    expect(lastButtons().map((b) => [b.text, b.style])).toEqual([
      ['Retry…', undefined],
      ['Rename', undefined],
      ['Delete', 'destructive'],
      ['Cancel', 'cancel'],
    ]);
    (router.push as jest.Mock).mockClear();
    await press('Retry…');
    expect(router.push).toHaveBeenLastCalledWith(RETRY);
  });

  it.each([false, undefined])('a failed row with retryable=%s opens the sheet but has no Retry…', async (retryable) => {
    server = [failed(retryable)];
    await renderLibrary();
    expect(row().props.accessibilityHint).toBe('Shows what happened');
    await fireEvent.press(row());
    expect(router.push).toHaveBeenLastCalledWith(RETRY);

    expect(more().props.accessibilityHint).toBe('Rename or delete');
    await openMenu('Kitchen');
    expect(lastButtons().map((b) => b.text)).toEqual(['Rename', 'Delete', 'Cancel']);
  });

  it('a ready row has no Retry… and still opens the room', async () => {
    await renderLibrary();
    expect(more().props.accessibilityHint).toBe('Rename or delete');
    await fireEvent.press(screen.getByRole('button', { name: /^Kitchen, Ready/ }));
    expect(router.push).toHaveBeenLastCalledWith({ pathname: '/world/[id]', params: { id: 'w1' } });
    await openMenu('Kitchen');
    expect(lastButtons().map((b) => b.text)).not.toContain('Retry…');
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
  const saveButton = () => screen.getByRole('button', { name: 'Save name' });

  it('prefills the title with a counter and disables Save for empty or unchanged names', async () => {
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
    expect(toastSuccess).toHaveBeenCalledWith('Name saved');
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
    expect(toastSuccess).not.toHaveBeenCalled();
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

describe('delete', () => {
  const titles = () =>
    screen.getAllByText(/^(Hallway|Kitchen|Bedroom|Garage)$/).map((n) => n.props.children as string);

  async function confirmDeleteOf(title: string) {
    await openMenu(title);
    await press('Delete');
  }

  it('asks for confirmation naming the scan', async () => {
    await renderLibrary();
    await confirmDeleteOf('Bedroom');
    expect(alertSpy).toHaveBeenLastCalledWith(
      'Delete "Bedroom"?',
      "This removes it from your phone and our servers, including processed files. You can't undo this.",

      expect.any(Array),
    );
    expect(lastButtons().map((b) => [b.text, b.style])).toEqual([
      ['Cancel', 'cancel'],
      ['Delete', 'destructive'],
    ]);
  });

  it('removes the row before the DELETE resolves and keeps it gone on success', async () => {
    let resolve!: (r: Response) => void;
    mutate.mockReturnValue(new Promise<Response>((r) => (resolve = r)));
    await renderLibrary();
    await confirmDeleteOf('Bedroom');
    await press('Delete');

    // DELETE is still pending here; onMutate awaits cancelQueries before removing the row.
    await waitFor(() => expect(screen.queryByText('Bedroom')).toBeNull());
    const calls = mutateCalls('DELETE');
    expect(calls).toHaveLength(1);
    expect(calls[0][0]).toBe('https://api.test.invalid/v1/worlds/w2');
    // CR-01: a bodiless DELETE must carry no JSON content type (Fastify 400s an empty JSON body).
    // backend/test/integration/ownership.pg.test.ts injects exactly these headers.
    expect(calls[0][1].headers).toEqual({ Cookie: 'better-auth.session_token=abc' });

    server = server.filter((x) => x.id !== 'w2');
    await act(async () => resolve(ok({ ok: true, job_id: 'j1' })));
    await waitFor(() => expect(fetchMock.mock.calls.filter(([, i]) => !i?.method).length).toBeGreaterThan(1));
    expect(screen.queryByText('Bedroom')).toBeNull();
    expect(titles()).toEqual(['Kitchen', 'Garage']);
    expect(toastSuccess).toHaveBeenCalledWith('Scan deleted');
  });

  it.each([
    ['a server error', async () => fail(500)],
    ['a network error', async () => Promise.reject(new TypeError('Network request failed'))],
  ])('restores the row in place and says so on %s', async (_label, impl) => {
    mutate.mockImplementation(impl);
    await renderLibrary();
    await confirmDeleteOf('Bedroom');
    await press('Delete');

    await waitFor(() => expect(toastError).toHaveBeenCalledWith("Couldn't delete. Check your connection and try again."));
    // Only the confirmation Alerts; the failure is a toast, not a third Alert (06.1 §9.3 row 5).
    expect(alertSpy).not.toHaveBeenCalledWith("Couldn't delete", expect.anything(), expect.anything());
    expect(toastSuccess).not.toHaveBeenCalled();
    expect(titles()).toEqual(['Kitchen', 'Bedroom', 'Garage']);
  });

  it('discards a saved-on-phone scan locally without a request', async () => {
    __setLocalScansForTest([local('l1', 'Hallway')]);
    await renderLibrary();
    await openMenu('Hallway');
    expect(lastButtons().map((b) => b.text)).toEqual(['Discard', 'Cancel']);
    await press('Discard');
    expect(alertSpy).toHaveBeenLastCalledWith(
      'Discard this scan?',
      "This deletes its 30 photos from your phone. You can't undo this.",
      [expect.objectContaining({ text: 'Cancel', style: 'cancel' }), expect.objectContaining({ text: 'Discard', style: 'destructive' })],
    );
    await press('Discard');
    await waitFor(() => expect(screen.queryByText('Hallway')).toBeNull());
    expect(mutate).not.toHaveBeenCalled();
    expect(toastSuccess).toHaveBeenCalledWith('Scan discarded');
  });

  it('a failed discard keeps the row and says so in a toast, not a second Alert (06.1 §9.3 row 4)', async () => {
    __setLocalScansForTest([local('l1', 'Hallway')]);
    new Directory(Paths.document, 'sessions', 'l1').create({ intermediates: true, idempotent: true });
    jest.spyOn(Directory.prototype, 'delete').mockImplementation(() => {
      throw new Error('disk');
    });
    await renderLibrary();
    await openMenu('Hallway');
    await press('Discard');
    const confirms = alertSpy.mock.calls.length;
    await press('Discard');
    expect(toastError).toHaveBeenCalledWith("Couldn't discard. Try again.");
    expect(toastSuccess).not.toHaveBeenCalled();
    expect(alertSpy).toHaveBeenCalledTimes(confirms);
    expect(screen.getByText('Hallway')).toBeTruthy();
    expect(getLocalScans()).toHaveLength(1);
  });

  it('an uploading local scan offers Delete (not Discard); success drops the local copy too (CR-03)', async () => {
    __setLocalScansForTest([{ ...local('l1', 'Hallway'), uploadState: 'uploading', serverWorldId: 'w9' }]);
    mutate.mockResolvedValue(ok({ ok: true, job_id: 'j1' }));
    await renderLibrary();
    await openMenu('Hallway');
    expect(lastButtons().map((b) => b.text)).toEqual(['Delete', 'Cancel']);
    await press('Delete');
    await press('Delete');
    await waitFor(() => expect(screen.queryByText('Hallway')).toBeNull());
    expect(mutateCalls('DELETE')[0][0]).toBe('https://api.test.invalid/v1/worlds/w9');
    expect(getLocalScans()).toEqual([]);
  });

  it('a failed local scan that has a server world offers Delete, never a local-only Discard (iter-2 WR-02)', async () => {
    __setLocalScansForTest([{ ...local('l1', 'Hallway'), uploadState: 'failed', serverWorldId: 'w9' }]);
    await renderLibrary();
    await openMenu('Hallway');
    expect(lastButtons().map((b) => b.text)).toEqual(['Delete', 'Cancel']);
  });

  it('a refused create (failed, no server id) offers Discard', async () => {
    __setLocalScansForTest([{ ...local('l1', 'Hallway'), uploadState: 'failed', failureCode: 'SCAN_QUOTA_EXCEEDED' }]);
    await renderLibrary();
    await openMenu('Hallway');
    expect(lastButtons().map((b) => b.text)).toEqual(['Discard', 'Cancel']);
  });

  it.each(['approved', 'uploading', 'paused'] as const)(
    'a %s local scan without a server id has no More button (no empty menu)',
    async (uploadState) => {
      __setLocalScansForTest([{ ...local('l1', 'Hallway'), uploadState }]);
      await renderLibrary();
      expect(screen.getByRole('button', { name: /^Hallway/ })).toBeTruthy();
      expect(screen.queryByRole('button', { name: 'More actions for Hallway' })).toBeNull();
    },
  );

  it('local More hints name only the offered action', async () => {
    __setLocalScansForTest([local('l1', 'Hallway'), { ...local('l2', 'Attic'), uploadState: 'uploading', serverWorldId: 'w9' }]);
    await renderLibrary();
    expect(screen.getByRole('button', { name: 'More actions for Hallway' }).props.accessibilityHint).toBe('Discard');
    expect(screen.getByRole('button', { name: 'More actions for Attic' }).props.accessibilityHint).toBe('Delete');
  });

  it('Cancel in the confirmation keeps the row and sends nothing', async () => {
    await renderLibrary();
    await confirmDeleteOf('Bedroom');
    await press('Cancel');
    expect(screen.getByText('Bedroom')).toBeTruthy();
    expect(mutate).not.toHaveBeenCalled();
  });
});
