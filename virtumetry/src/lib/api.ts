import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Alert } from 'react-native';

import { API_URL } from '@/config/api';
import { pollInterval, type LibraryItem } from '@/library/display-state';
import { authClient } from '@/lib/auth-client';
import { endSession } from '@/lib/session';

export class ApiError extends Error {
  constructor(public status: number) {
    super(`API error ${status}`);
  }
}

export class UnauthorizedError extends ApiError {
  constructor() {
    super(401);
  }
}

/** Every /v1 call: explicit session cookie only, never ambient credentials (AUTH-05, T-03-30). */
export async function apiFetch<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(`${API_URL}${path}`, {
    ...init,
    credentials: 'omit',
    headers: { ...(init.headers as Record<string, string>), Cookie: await authClient.getCookie(), 'content-type': 'application/json' },
  });
  if (res.status === 401) {
    await endSession({ notice: true });
    throw new UnauthorizedError();
  }
  if (!res.ok) throw new ApiError(res.status);
  if (res.status === 204) return undefined as T;
  return res.json();
}

export type WorldsPage = { worlds: LibraryItem[]; has_more: boolean; next_offset: number | null };

// ponytail: first 100 only; page with next_offset when an owner has more scans.
export const listWorlds = () => apiFetch<WorldsPage>('/v1/worlds?limit=100');

/** Library query: polls every 5 s only while something is in flight (D-20). */
export function useWorlds() {
  return useQuery({
    queryKey: ['worlds'],
    queryFn: listWorlds,
    refetchInterval: (q) => pollInterval(q.state.data?.worlds),
  });
}

export const renameWorld = (id: string, title: string) =>
  apiFetch<LibraryItem>(`/v1/worlds/${id}`, { method: 'PATCH', body: JSON.stringify({ title }) });

/** Rename is not optimistic: the row shows the server's title once it answers (UI-SPEC Interaction Timing). */
export function useRenameWorld() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, title }: { id: string; title: string }) => renameWorld(id, title),
    onSuccess: (world) => {
      qc.setQueryData<WorldsPage>(['worlds'], (old) =>
        old && { ...old, worlds: old.worlds.map((x) => (x.id === world.id ? { ...x, ...world } : x)) },
      );
      qc.invalidateQueries({ queryKey: ['worlds'] });
    },
  });
}

export const deleteWorld = (id: string) => apiFetch<{ ok: true; job_id: string }>(`/v1/worlds/${id}`, { method: 'DELETE' });

/** Delete is optimistic: the row goes at once and comes back in place on any error (D-21, T-03-35). */
export function useDeleteWorld() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: deleteWorld,
    onMutate: async (id: string) => {
      await qc.cancelQueries({ queryKey: ['worlds'] });
      const snapshot = qc.getQueryData<WorldsPage>(['worlds']);
      qc.setQueryData<WorldsPage>(['worlds'], (old) => old && { ...old, worlds: old.worlds.filter((x) => x.id !== id) });
      return { snapshot };
    },
    onError: (_err, _id, ctx) => {
      if (ctx?.snapshot) qc.setQueryData(['worlds'], ctx.snapshot);
      Alert.alert("Couldn't delete", 'The scan is back in your library. Check your connection and try again.', [
        { text: 'Back to Library' },
      ]);
    },
    onSettled: () => qc.invalidateQueries({ queryKey: ['worlds'] }),
  });
}
