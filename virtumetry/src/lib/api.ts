import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Alert } from 'react-native';

import { API_URL } from '@/config/api';
import { pollInterval, type LibraryItem, type LocalScan } from '@/library/display-state';
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
    // JSON content type only with a body: Fastify rejects an empty JSON body (CR-01, bodiless DELETE).
    headers: {
      ...(init.body != null ? { 'content-type': 'application/json' } : {}),
      ...(init.headers as Record<string, string>),
      Cookie: await authClient.getCookie(),
    },
  });
  // A deleted account is 403 account_deleted on every call: sign out like a 401 (WR-02).
  const deleted = res.status === 403 && (await res.json().catch(() => null))?.error === 'account_deleted';
  if (res.status === 401 || deleted) {
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

// --- Scans (04-02/03 contract). Presigned R2 PUTs never go through apiFetch (T-04-26). ---

export type ScanWorld = LibraryItem;
export type PresignedPut = { path: string; url: string; method: 'PUT'; headers: Record<string, string> };
export type MissingReport = {
  world: ScanWorld;
  missingFrames: string[];
  manifestPresent: boolean;
  uploadedFrames: number;
  totalFrames: number;
};
export type Quote = {
  credits: number;
  usd: number;
  budgetRemaining: number;
  budgetWindow: 'daily' | 'monthly';
  withinBudget: boolean;
};

/** Idempotent create: Idempotency-Key = sessionId, so a retry replays the same world (T-04-29). */
export const createScan = (scan: LocalScan) =>
  apiFetch<{ world: ScanWorld }>('/v1/scans', {
    method: 'POST',
    headers: { 'Idempotency-Key': scan.sessionId },
    body: JSON.stringify({
      ...(scan.title ? { title: scan.title } : {}),
      frame_count: scan.frameCount,
      image_w: scan.imageW,
      image_h: scan.imageH,
      approved_max_credits: scan.approvedMaxCredits,
    }),
  });

export const presignUploads = (id: string, files: { path: string; bytes: number }[]) =>
  apiFetch<{ uploads: PresignedPut[] }>(`/v1/scans/${id}/uploads`, { method: 'POST', body: JSON.stringify({ files }) });

export const getMissing = (id: string) => apiFetch<MissingReport>(`/v1/scans/${id}/uploads:missing`);

/** 409 upload_incomplete comes back as { incomplete: true }; the next pass re-asks what is missing. */
export async function completeScan(id: string): Promise<{ world: ScanWorld; issues?: string[] } | { incomplete: true }> {
  try {
    return await apiFetch<{ world: ScanWorld; issues?: string[] }>(`/v1/scans/${id}:complete`, { method: 'POST' });
  } catch (e) {
    if (e instanceof ApiError && e.status === 409) return { incomplete: true };
    throw e;
  }
}

export const getQuote = (frames: number) => apiFetch<Quote>(`/v1/quote?frames=${frames}`);
