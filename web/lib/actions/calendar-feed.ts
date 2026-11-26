'use server';

import { fetchApi } from '../api-client';

export type FeedStatus = { enabled: boolean; createdAt: string | null };

export async function getFeedStatusAction(businessId: string): Promise<FeedStatus> {
  return fetchApi<FeedStatus>(`/businesses/${businessId}/calendar-feed`, { cache: 'no-store' });
}

/** Creates or rotates. The URL is only ever returned here — copy it now. */
export async function issueFeedAction(
  businessId: string,
): Promise<{ ok: true; url: string } | { ok: false }> {
  try {
    const res = await fetchApi<{ url: string }>(`/businesses/${businessId}/calendar-feed`, {
      method: 'POST',
    });
    return { ok: true, url: res.url };
  } catch {
    return { ok: false };
  }
}

export async function revokeFeedAction(businessId: string): Promise<{ ok: boolean }> {
  try {
    await fetchApi(`/businesses/${businessId}/calendar-feed`, { method: 'DELETE' });
    return { ok: true };
  } catch {
    return { ok: false };
  }
}
