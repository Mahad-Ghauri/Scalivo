'use server';

import { fetchApi } from '@/lib/api-client';

export async function createServiceAction(businessId: string, payload: unknown) {
  return fetchApi(`/businesses/${businessId}/services`, {
    method: 'POST',
    body: JSON.stringify(payload),
  });
}

export async function updateServiceAction(businessId: string, serviceId: string, payload: unknown) {
  return fetchApi(`/businesses/${businessId}/services/${serviceId}`, {
    method: 'PATCH',
    body: JSON.stringify(payload),
  });
}

export async function saveResourceAction(businessId: string, id: string | null, payload: unknown) {
  return fetchApi(`/businesses/${businessId}/resources${id ? `/${id}` : ''}`, {
    method: id ? 'PATCH' : 'POST',
    body: JSON.stringify(payload),
  });
}

export async function blockResourceAction(
  businessId: string,
  input: { resourceId: string; startsAt: string; endsAt: string; reason: string },
) {
  return fetchApi<{ affectedBookings: { id: string }[] }>(
    `/businesses/${businessId}/blocked-time`,
    { method: 'POST', body: JSON.stringify(input) },
  );
}
export async function removeResourceBlockAction(businessId: string, id: string) {
  await fetchApi(`/businesses/${businessId}/blocked-time/${id}`, { method: 'DELETE' });
}
