import { API_URL } from '@/config/api';
import { ApiError, type WorldAssets } from '@/lib/api';
import type { FloorplanMeta } from '@/viewer/types';

export type PublicShare = { title: string | null; needs_password: boolean };
export type OpenedShare = { title: string | null; floorplan_meta: FloorplanMeta | null; assets: WorldAssets };

/** Visitor calls: plain fetch, never apiFetch. No cookie, and a 401 here means password, not sign-out (T-05-30). */
async function publicFetch<T>(path: string, body?: object): Promise<T> {
  const res = await fetch(`${API_URL}/v1/public/shares/${path}`, {
    method: body ? 'POST' : 'GET',
    credentials: 'omit',
    ...(body ? { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) } : {}),
  });
  if (!res.ok) {
    const code = (await res.json().catch(() => null))?.error;
    throw new ApiError(res.status, typeof code === 'string' ? code : undefined);
  }
  return res.json();
}

export const getPublicShare = (slug: string) => publicFetch<PublicShare>(encodeURIComponent(slug));

/** Password only when the visitor typed one; never stored beyond the page's state (T-05-31). */
export const openPublicShare = (slug: string, password?: string) =>
  publicFetch<OpenedShare>(`${encodeURIComponent(slug)}/open`, password === undefined ? {} : { password });
