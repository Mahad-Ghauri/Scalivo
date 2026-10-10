'use server';

import { ApiError, fetchApi } from '@/lib/api-client';

export type CatalogResult = { ok: true } | { ok: false; error: string };

async function saveCatalog(
  path: string,
  method: 'POST' | 'PATCH',
  payload: unknown,
): Promise<CatalogResult> {
  try {
    await fetchApi(path, { method, body: JSON.stringify(payload) });
    return { ok: true };
  } catch (error) {
    // Expected API errors must be returned: Next strips thrown action messages
    // in production, including useful resource-configuration validation.
    if (error instanceof ApiError && error.status < 500) return { ok: false, error: error.message };
    console.error('Catalog save failed', {
      method,
      status: error instanceof ApiError ? error.status : null,
    });
    return { ok: false, error: 'Could not save. Please try again.' };
  }
}

export async function createServiceAction(businessId: string, payload: unknown) {
  return saveCatalog(`/businesses/${businessId}/services`, 'POST', payload);
}

export async function updateServiceAction(businessId: string, serviceId: string, payload: unknown) {
  return saveCatalog(`/businesses/${businessId}/services/${serviceId}`, 'PATCH', payload);
}

export async function saveResourceAction(businessId: string, id: string | null, payload: unknown) {
  return saveCatalog(
    `/businesses/${businessId}/resources${id ? `/${id}` : ''}`,
    id ? 'PATCH' : 'POST',
    payload,
  );
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
