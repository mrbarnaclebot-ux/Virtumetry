import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { ApiError, apiFetch } from '@/lib/api';

/** Owner view of a share link (05-04 serializeShare). */
export type Share = {
  id: string;
  slug: string;
  url: string;
  has_password: boolean;
  open_count: number;
  created_at: string;
  revoked_at: string | null;
};
type SharesPage = { shares: Share[] };

const base = (worldId: string) => `/v1/worlds/${encodeURIComponent(worldId)}/shares`;

export const listShares = (worldId: string) => apiFetch<SharesPage>(base(worldId));

export const createShare = (worldId: string, password?: string) =>
  apiFetch<Share>(base(worldId), {
    method: 'POST',
    body: JSON.stringify(password === undefined ? {} : { password }),
  });

export const revokeShare = (worldId: string, shareId: string) =>
  apiFetch<void>(`${base(worldId)}/${encodeURIComponent(shareId)}`, { method: 'DELETE' });

export const openCountLabel = (n: number) =>
  n === 0 ? 'Not opened yet' : n === 1 ? 'Opened 1 time' : `Opened ${n} times`;

/** SHARE-05: fresh counts every time the sheet opens; no polling. */
export function useShares(worldId: string) {
  return useQuery({
    queryKey: ['shares', worldId],
    queryFn: () => listShares(worldId),
    refetchOnMount: 'always',
    select: (d) => d.shares.filter((s) => !s.revoked_at),
  });
}

/**
 * Not optimistic. gcTime 0 + reset() after success drop the mutation (and its password
 * variable) from the react-query cache at once (T-05-26).
 */
export function useCreateShare(worldId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (password?: string) => createShare(worldId, password),
    gcTime: 0,
    onSuccess: (share) => {
      qc.setQueryData<SharesPage>(['shares', worldId], (old) => ({ shares: [share, ...(old?.shares ?? [])] }));
      qc.invalidateQueries({ queryKey: ['shares', worldId] });
    },
  });
}

/** Optimistic: the row goes at once and comes back on error; the caller shows the error (T-05-28). */
export function useRevokeShare(worldId: string) {
  const qc = useQueryClient();
  const key = ['shares', worldId];
  return useMutation({
    // Already gone (404 share_not_found) counts as revoked.
    mutationFn: (shareId: string) =>
      revokeShare(worldId, shareId).catch((e) => {
        if (e instanceof ApiError && e.code === 'share_not_found') return;
        throw e;
      }),
    onMutate: async (shareId: string) => {
      await qc.cancelQueries({ queryKey: key });
      const snapshot = qc.getQueryData<SharesPage>(key);
      qc.setQueryData<SharesPage>(key, (old) => old && { shares: old.shares.filter((s) => s.id !== shareId) });
      return { snapshot };
    },
    onError: (_e, _id, ctx) => {
      if (ctx?.snapshot) qc.setQueryData(key, ctx.snapshot);
    },
    onSettled: () => qc.invalidateQueries({ queryKey: key }),
  });
}
