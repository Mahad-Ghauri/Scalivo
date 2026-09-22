'use server';

import { revalidatePath } from 'next/cache';
import { ApiError, fetchApi } from '@/lib/api-client';

export type BoostResult = { ok: true } | { ok: false; error: string };

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
