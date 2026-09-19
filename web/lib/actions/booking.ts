'use server';

import { fetchApi, ApiError } from '../api-client';
import type { AvailableSlot, Booking } from '@scalivo/shared';

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
  staffId?: string
): Promise<AvailableSlot[]> {
  try {
    const params: Record<string, string> = { serviceId, date };
    if (staffId && staffId !== 'any') {
      params.staffId = staffId;
    }
    const res = await fetchApi<{ slots: AvailableSlot[] }>(`/businesses/${businessId}/availability`, {
      params
    });
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
  }
): Promise<CreateBookingState> {
  try {
    // 1. Acquire Hold
    const holdRes = await fetchApi<{ token: string; staffId: string }>(`/businesses/${businessId}/holds`, {
      method: 'POST',
      body: JSON.stringify({
        serviceId: data.serviceId,
        staffId: data.staffId, // could be 'any'
        startsAt: data.startsAt,
        source: 'owner',
      }),
    });

    // 2. Create Booking
    const bookRes = await fetchApi<Booking>(`/businesses/${businessId}/bookings`, {
      method: 'POST',
      body: JSON.stringify({
        serviceId: data.serviceId,
        staffId: holdRes.staffId, // Use the resolved staffId
        clientId: data.clientId,
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
  error?: 'not_found' | 'already_terminal' | 'invalid_slot' | 'beyond_horizon' | 'too_soon' | 'hold_expired' | 'outside_hours' | 'slot_taken' | 'validation' | 'generic';
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
  }
): Promise<RescheduleBookingState> {
  try {
    // 1. Acquire Hold (must be owner source to skip notice period, just like create)
    const holdRes = await fetchApi<{ token: string; staffId: string }>(`/businesses/${businessId}/holds`, {
      method: 'POST',
      body: JSON.stringify({
        serviceId: data.serviceId,
        staffId: data.staffId,
        startsAt: data.startsAt,
        source: 'owner',
      }),
    });

    // 2. Reschedule Booking
    const bookRes = await fetchApi<Booking>(`/businesses/${businessId}/bookings/${bookingId}/reschedule`, {
      method: 'PATCH',
      body: JSON.stringify({
        staffId: holdRes.staffId,
        startsAt: data.startsAt,
        holdToken: holdRes.token,
      }),
    });

    return { success: true, booking: bookRes };
  } catch (err) {
    if (err instanceof ApiError) {
      if (err.status === 409 || err.status === 404 || err.status === 400) {
        const reason = (err.data as Record<string, unknown>)?.reason as RescheduleBookingState['error'];
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
  bookingId: string
): Promise<CancelBookingState> {
  try {
    await fetchApi(`/businesses/${businessId}/bookings/${bookingId}/cancel`, {
      method: 'PATCH',
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
  outcome: 'completed' | 'no_show'
): Promise<SetBookingOutcomeState> {
  try {
    await fetchApi(`/businesses/${businessId}/bookings/${bookingId}/outcome`, {
      method: 'POST',
      body: JSON.stringify({ outcome })
    });
    return { success: true };
  } catch (err) {
    if (err instanceof ApiError) {
      if (err.status === 409 || err.status === 404 || err.status === 400) {
        const reason = (err.data as Record<string, unknown>)?.reason as SetBookingOutcomeState['error'];
        if (reason) {
          return { success: false, error: reason };
        }
      }
    }
    console.error('setBookingOutcomeAction error:', err);
    return { success: false, error: 'generic' };
  }
}
