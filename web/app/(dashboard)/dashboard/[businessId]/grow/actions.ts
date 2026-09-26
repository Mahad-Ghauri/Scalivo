'use server';

import { revalidatePath } from 'next/cache';
import type { CampaignAudience } from '@scalivo/shared';
import { ApiError, fetchApi } from '@/lib/api-client';

export type BoostResult = { ok: true } | { ok: false; error: string };
export type BroadcastResult = { ok: true; recipients: number } | { ok: false; error: string };

/** Returned, not thrown — a thrown server-action error reaches the browser with its message stripped. */
export async function setBoostAction(businessId: string, on: boolean): Promise<BoostResult> {
  try {
    await fetchApi(`/businesses/${businessId}/grow/boost`, { method: on ? 'POST' : 'DELETE' });
  } catch (err) {
    if (err instanceof ApiError && err.status < 500) return { ok: false, error: err.message };
    return { ok: false, error: 'Could not update the boost. Please try again.' };
  }
  revalidatePath(`/dashboard/${businessId}/grow`);
  return { ok: true };
}

/**
 * Send a win-back broadcast (SPEC §6.2).
 *
 * The backend creates the campaign and drains what today's caps and the throttle
 * allow; the rest goes out over the following passes. So this returns, and the
 * page it revalidates shows a campaign that is still sending — which is the truth
 * and is also the only honest thing to show, since a few hundred spaced-out
 * messages take hours by design.
 */
export async function sendBroadcastAction(
  businessId: string,
  audience: CampaignAudience,
  message: string,
): Promise<BroadcastResult> {
  try {
    const created = await fetchApi<{ campaignId: string; recipients: number; sent: number }>(
      `/businesses/${businessId}/retention/campaigns`,
      { method: 'POST', body: JSON.stringify({ audience, message }) },
    );
    revalidatePath(`/dashboard/${businessId}/grow/broadcast`);
    return { ok: true, recipients: created.recipients };
  } catch (err) {
    if (err instanceof ApiError && err.status < 500) return { ok: false, error: err.message };
    return { ok: false, error: 'Could not send the broadcast. Please try again.' };
  }
}

export async function cancelBroadcastAction(
  businessId: string,
  campaignId: string,
): Promise<BoostResult> {
  try {
    await fetchApi(`/businesses/${businessId}/retention/campaigns/${campaignId}/cancel`, {
      method: 'POST',
    });
  } catch (err) {
    if (err instanceof ApiError && err.status < 500) return { ok: false, error: err.message };
    return { ok: false, error: 'Could not stop the broadcast. Please try again.' };
  }
  revalidatePath(`/dashboard/${businessId}/grow/broadcast`);
  return { ok: true };
}

/** The automatic nudges, on or off. */
export async function setNudgesAction(businessId: string, on: boolean): Promise<BoostResult> {
  try {
    await fetchApi(`/businesses/${businessId}/retention/nudges`, {
      method: 'PATCH',
      body: JSON.stringify({ nudges: on }),
    });
  } catch (err) {
    if (err instanceof ApiError && err.status < 500) return { ok: false, error: err.message };
    return { ok: false, error: 'Could not change that setting. Please try again.' };
  }
  revalidatePath(`/dashboard/${businessId}/grow/broadcast`);
  revalidatePath(`/dashboard/${businessId}/grow`);
  return { ok: true };
}
