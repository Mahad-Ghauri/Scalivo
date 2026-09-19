'use server';

import { fetchApi } from '@/lib/api-client';

export async function createServiceAction(businessId: string, payload: any) {
  return fetchApi(`/businesses/${businessId}/services`, {
    method: 'POST',
    body: JSON.stringify(payload),
  });
}

export async function updateServiceAction(businessId: string, serviceId: string, payload: any) {
  return fetchApi(`/businesses/${businessId}/services/${serviceId}`, {
    method: 'PATCH',
    body: JSON.stringify(payload),
  });
}
