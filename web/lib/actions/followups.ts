'use server';

import { fetchApi, ApiError } from '../api-client';
import type { FollowUpSummary } from '@scalivo/shared';

export type FollowUpActionState =
  | { success: true; followUp: FollowUpSummary | null }
  | { success: false; error: string };

const MESSAGES: Record<string, string> = {
  invalid_status: 'A cancelled or no-show visit cannot have a follow-up.',
  already_closed: 'The customer has already been contacted about this follow-up.',
  invalid_service: 'That service is not available.',
  invalid_staff: "That professional doesn't offer the follow-up service.",
  not_found: 'Appointment not found.',
};

function failure(err: unknown): FollowUpActionState {
  if (err instanceof ApiError) {
    const data = err.data as { reason?: string; fields?: Record<string, string> } | undefined;
    if (data?.fields) return { success: false, error: Object.values(data.fields)[0] ?? 'Invalid input.' };
    if (data?.reason && MESSAGES[data.reason]) return { success: false, error: MESSAGES[data.reason]! };
  }
  return { success: false, error: 'Could not save the follow-up. Try again.' };
}

export async function setFollowUpAction(
  businessId: string,
  bookingId: string,
  data: { afterDays: number; note?: string | null; serviceId?: string | null; staffId?: string | null },
): Promise<FollowUpActionState> {
  try {
    const res = await fetchApi<{ followUp: FollowUpSummary }>(
      `/businesses/${businessId}/bookings/${bookingId}/follow-up`,
      { method: 'PUT', body: JSON.stringify(data) },
    );
    return { success: true, followUp: res.followUp };
  } catch (err) {
    return failure(err);
  }
}

export async function clearFollowUpAction(
  businessId: string,
  bookingId: string,
): Promise<FollowUpActionState> {
  try {
    await fetchApi(`/businesses/${businessId}/bookings/${bookingId}/follow-up`, {
      method: 'DELETE',
    });
    return { success: true, followUp: null };
  } catch (err) {
    return failure(err);
  }
}
