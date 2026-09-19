'use server';

import { fetchApi } from '@/lib/api-client';

export async function createStaffAction(businessId: string, payload: unknown) {
  return fetchApi(`/businesses/${businessId}/staff`, {
    method: 'POST',
    body: JSON.stringify(payload),
  });
}

export async function updateStaffAction(businessId: string, staffId: string, payload: unknown) {
  return fetchApi(`/businesses/${businessId}/staff/${staffId}`, {
    method: 'PATCH',
    body: JSON.stringify(payload),
  });
}
