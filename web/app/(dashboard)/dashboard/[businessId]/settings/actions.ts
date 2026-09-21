'use server';

import { revalidatePath } from 'next/cache';
import { ApiError, fetchApi } from '@/lib/api-client';

export type SettingsResult =
  | { ok: true }
  | { ok: false; error: string; fields: Record<string, string>; blockers: string[] };

/**
 * Returns the refusal rather than throwing it. A thrown error from a server
 * action reaches the browser with its message stripped in production, and the
 * whole value of the backend's validation is the field-by-field reason.
 */
export async function updateSettingsAction(
  businessId: string,
  payload: unknown,
): Promise<SettingsResult> {
  try {
    await fetchApi(`/businesses/${businessId}`, {
      method: 'PATCH',
      body: JSON.stringify(payload),
    });
  } catch (err) {
    if (err instanceof ApiError && err.status < 500) {
      const data = (err.data ?? {}) as { fields?: Record<string, string>; blockers?: string[] };
      return { ok: false, error: err.message, fields: data.fields ?? {}, blockers: data.blockers ?? [] };
    }
    return { ok: false, error: 'Could not save. Please try again.', fields: {}, blockers: [] };
  }

  // The name and timezone show up across the whole dashboard, not just here.
  revalidatePath(`/dashboard/${businessId}`, 'layout');
  return { ok: true };
}
