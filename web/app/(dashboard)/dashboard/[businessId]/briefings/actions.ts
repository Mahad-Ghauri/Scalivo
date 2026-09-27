'use server';

import { revalidatePath } from 'next/cache';
import { ApiError, fetchApi } from '@/lib/api-client';

export type AgentResult = { ok: true } | { ok: false; error: string };

/** Returned, not thrown — a thrown server-action error reaches the browser with its message stripped. */
export async function markBriefingReadAction(
  businessId: string,
  briefingId: string,
): Promise<AgentResult> {
  try {
    await fetchApi(`/businesses/${businessId}/agent/briefings/${briefingId}/read`, {
      method: 'POST',
    });
  } catch (err) {
    if (err instanceof ApiError && err.status < 500) return { ok: false, error: err.message };
    return { ok: false, error: 'Could not mark that as read.' };
  }
  revalidatePath(`/dashboard/${businessId}/briefings`);
  revalidatePath(`/dashboard/${businessId}`);
  return { ok: true };
}

export async function setAgentSettingsAction(
  businessId: string,
  settings: { enabled?: boolean; hour?: number },
): Promise<AgentResult> {
  try {
    await fetchApi(`/businesses/${businessId}/agent/settings`, {
      method: 'PATCH',
      // Stringified because fetchApi only sets the JSON content-type for a string body.
      body: JSON.stringify(settings),
    });
  } catch (err) {
    if (err instanceof ApiError && err.status < 500) return { ok: false, error: err.message };
    return { ok: false, error: 'Could not change that setting. Please try again.' };
  }
  revalidatePath(`/dashboard/${businessId}/briefings`);
  return { ok: true };
}
