'use server';

import { fetchApi } from '@/lib/api-client';

export async function getAppointmentsAction(businessId: string, searchParams: URLSearchParams) {
  const query = searchParams.toString();
  return fetchApi(`/businesses/${businessId}/bookings?${query}`, {
    cache: 'no-store'
  });
}

export async function getAppointmentAction(businessId: string, bookingId: string) {
  return fetchApi(`/businesses/${businessId}/bookings/${bookingId}`, {
    cache: 'no-store'
  });
}

export async function cancelAppointmentAction(businessId: string, bookingId: string) {
  return fetchApi(`/businesses/${businessId}/bookings/${bookingId}/cancel`, {
    method: 'PATCH'
  });
}

export async function setAppointmentOutcomeAction(businessId: string, bookingId: string, outcome: string) {
  return fetchApi(`/businesses/${businessId}/bookings/${bookingId}/outcome`, {
    method: 'POST',
    body: JSON.stringify({ outcome })
  });
}
