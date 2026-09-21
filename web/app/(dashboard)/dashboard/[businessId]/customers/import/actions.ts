'use server';

import { revalidatePath } from 'next/cache';
import type { ClientImportResult, ClientImportRow } from '@scalivo/shared';
import { ApiError, fetchApi } from '@/lib/api-client';

export async function importClientsAction(
  businessId: string,
  rows: ClientImportRow[],
  dryRun: boolean,
): Promise<{ ok: true; result: ClientImportResult } | { ok: false; error: string }> {
  try {
    const result = await fetchApi<ClientImportResult>(`/businesses/${businessId}/clients/import`, {
      method: 'POST',
      params: { dryRun: dryRun ? 'true' : undefined },
      body: JSON.stringify({ rows }),
    });
    if (!dryRun) revalidatePath(`/dashboard/${businessId}/customers`);
    return { ok: true, result };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof ApiError && err.status < 500 ? err.message : 'Could not reach the server.',
    };
  }
}
