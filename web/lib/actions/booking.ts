'use server';

import { fetchApi, ApiError } from '../api-client';
import type { AvailableSlot, Booking, RescheduleResult, SequenceSlot } from '@scalivo/shared';

type RescheduleFailure = Exclude<RescheduleResult, { ok: true }>['reason'];

export type CreateBookingState = {
  success: boolean;
  error?: 'slot_taken' | 'hold_expired' | 'generic' | 'validation';
  validationErrors?: Record<string, string[]>;
  booking?: Booking;
};

export async function getAvailabilityAction(
  businessId: string,
  serviceId: string,
  date: string,
  staffId?: string,
  bookingId?: string,
): Promise<AvailableSlot[]> {
  try {
    const params: Record<string, string> = { serviceId, date };
    if (bookingId) params.bookingId = bookingId;
    if (staffId && staffId !== 'any') {
      params.staffId = staffId;
    }
    const res = await fetchApi<{ slots: AvailableSlot[] }>(
      `/businesses/${businessId}/availability`,
      {
        params,
      },
    );
    return res.slots;
  } catch (err) {
    console.error('getAvailabilityAction error', err);
    return [];
  }
}

export async function createBookingAction(
  businessId: string,
  data: {
    serviceId: string;
    staffId: string;
    clientId: string;
    startsAt: string;
    appointmentHolderId?: string;
    additionalServices?: { serviceId: string; staffId: string }[];
    requestId?: string;
  },
): Promise<CreateBookingState> {
  try {
    if (data.additionalServices?.length) {
      const result = await fetchApi<{ booking: Booking }>(`/businesses/${businessId}/walk-ins`, {
        method: 'POST',
        body: JSON.stringify(data),
      });
      return { success: true, booking: result.booking };
    }
    // 1. Acquire Hold
    const holdRes = await fetchApi<{ token: string; staffId: string }>(
      `/businesses/${businessId}/holds`,
      {
        method: 'POST',
        body: JSON.stringify({
          serviceId: data.serviceId,
          staffId: data.staffId, // could be 'any'
          startsAt: data.startsAt,
          source: 'owner',
        }),
      },
    );

    // 2. Create Booking
    const bookRes = await fetchApi<Booking>(`/businesses/${businessId}/bookings`, {
      method: 'POST',
      body: JSON.stringify({
        serviceId: data.serviceId,
        staffId: holdRes.staffId, // Use the resolved staffId
        clientId: data.clientId,
        appointmentHolderId: data.appointmentHolderId,
        startsAt: data.startsAt,
        holdToken: holdRes.token,
        source: 'owner',
      }),
    });

    return { success: true, booking: bookRes };
  } catch (err) {
    if (err instanceof ApiError) {
      if (err.status === 409) {
        const reason = (err.data as Record<string, unknown>)?.reason;
        if (reason === 'hold_expired' || reason === 'slot_taken') {
          return { success: false, error: reason };
        }
        return { success: false, error: 'slot_taken' }; // fallback for unknown conflicts
      }
      if (err.status === 400) {
        const fields = (err.data as Record<string, unknown>)?.fields as Record<string, string[]>;
        if (fields) {
          return { success: false, error: 'validation', validationErrors: fields };
        }
      }
    }
    console.error('createBookingAction error:', err);
    return { success: false, error: 'generic' };
  }
}

export type RescheduleBookingState = {
  success: boolean;
  error?: RescheduleFailure | 'validation' | 'generic';
  validationErrors?: Record<string, string[]>;
  booking?: Booking;
};

export async function rescheduleBookingAction(
  businessId: string,
  bookingId: string,
  data: {
    serviceId: string;
    staffId: string;
    startsAt: string;
  },
): Promise<RescheduleBookingState> {
  try {
    // The calendar's reschedule route: same occupancy transaction as a booking,
    // and it messages the customer. Owner override skips the notice period only.
    const { booking } = await fetchApi<{ booking: Booking; notified: boolean }>(
      `/businesses/${businessId}/bookings/${bookingId}/reschedule`,
      {
        method: 'POST',
        body: JSON.stringify({ staffId: data.staffId, startsAt: data.startsAt, override: true }),
      },
    );

    return { success: true, booking };
  } catch (err) {
    if (err instanceof ApiError) {
      if (err.status === 409 || err.status === 404 || err.status === 400) {
        const reason = (err.data as Record<string, unknown>)
          ?.reason as RescheduleBookingState['error'];
        if (reason) {
          return { success: false, error: reason };
        }
      }
      if (err.status === 400) {
        const fields = (err.data as Record<string, unknown>)?.fields as Record<string, string[]>;
        if (fields) {
          return { success: false, error: 'validation', validationErrors: fields };
        }
      }
    }
    console.error('rescheduleBookingAction error:', err);
    return { success: false, error: 'generic' };
  }
}

export type CancelBookingState = {
  success: boolean;
  error?: 'not_found' | 'already_terminal' | 'generic';
};

export async function cancelBookingAction(
  businessId: string,
  bookingId: string,
): Promise<CancelBookingState> {
  try {
    await fetchApi(`/businesses/${businessId}/bookings/${bookingId}/cancel`, {
      method: 'POST',
    });
    return { success: true };
  } catch (err) {
    if (err instanceof ApiError) {
      if (err.status === 409 || err.status === 404) {
        const reason = (err.data as Record<string, unknown>)?.reason as CancelBookingState['error'];
        if (reason) {
          return { success: false, error: reason };
        }
      }
    }
    console.error('cancelBookingAction error:', err);
    return { success: false, error: 'generic' };
  }
}

export type SetBookingOutcomeState = {
  success: boolean;
  error?: 'not_found' | 'already_terminal' | 'invalid_status' | 'not_yet_occurred' | 'generic';
};

export async function setBookingOutcomeAction(
  businessId: string,
  bookingId: string,
  outcome: 'completed' | 'no_show',
  earlyCompletionReason?: string,
): Promise<SetBookingOutcomeState> {
  try {
    await fetchApi(`/businesses/${businessId}/bookings/${bookingId}/outcome`, {
      method: 'POST',
      body: JSON.stringify({
        outcome,
        ...(earlyCompletionReason ? { earlyCompletionReason } : {}),
      }),
    });
    return { success: true };
  } catch (err) {
    if (err instanceof ApiError) {
      if (err.status === 409 || err.status === 404 || err.status === 400) {
        const reason = (err.data as Record<string, unknown>)
          ?.reason as SetBookingOutcomeState['error'];
        if (reason) {
          return { success: false, error: reason };
        }
      }
    }
    console.error('setBookingOutcomeAction error:', err);
    return { success: false, error: 'generic' };
  }
}

export async function approveBookingAction(
  businessId: string,
  bookingId: string,
): Promise<{ success: boolean }> {
  try {
    await fetchApi(`/businesses/${businessId}/bookings/${bookingId}/confirm`, { method: 'POST' });
    return { success: true };
  } catch {
    return { success: false };
  }
}

export async function correctBookingOutcomeAction(
  businessId: string,
  bookingId: string,
  data: {
    outcome: 'completed' | 'no_show' | 'cancelled';
    revision: number;
    reason: string;
  },
): Promise<{ success: boolean }> {
  try {
    await fetchApi(`/businesses/${businessId}/bookings/${bookingId}/correction`, {
      method: 'POST',
      body: JSON.stringify(data),
    });
    return { success: true };
  } catch {
    return { success: false };
  }
}

export async function getSequenceAvailabilityAction(
  businessId: string,
  steps: { serviceId: string; staffId: string }[],
  date: string,
): Promise<SequenceSlot[]> {
  const result = await fetchApi<{ slots: SequenceSlot[] }>(
    `/businesses/${businessId}/sequences/availability`,
    { method: 'POST', body: JSON.stringify({ steps, date }) },
  );
  return result.slots;
}
export async function getAppointmentHoldersAction(businessId: string, clientId: string) {
  return fetchApi<{ holders: { id: string; name: string; active: boolean }[] }>(
    `/businesses/${businessId}/clients/${clientId}/holders`,
  );
}
export async function saveAppointmentHolderAction(
  businessId: string,
  clientId: string,
  holderId: string | null,
  data: { name: string; active?: boolean },
) {
  return fetchApi<{ id: string; name: string; active: boolean }>(
    `/businesses/${businessId}/clients/${clientId}/holders${holderId ? `/${holderId}` : ''}`,
    { method: holderId ? 'PATCH' : 'POST', body: JSON.stringify(data) },
  );
}
export async function revokeCustomerLinkAction(businessId: string, clientId: string) {
  await fetchApi(`/businesses/${businessId}/clients/${clientId}/revoke-link`, { method: 'POST' });
}
