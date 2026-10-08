import 'server-only';
import { getSessionToken } from './auth/session';

export const API_BASE = process.env.NEXT_PUBLIC_API_BASE ?? 'http://localhost:3000';

export class ApiError extends Error {
  constructor(public status: number, public data: unknown) {
    super(
      typeof data === 'object' && data !== null && 'error' in data && typeof data.error === 'string'
        ? data.error
        : `API Error ${status}`
    );
    this.name = 'ApiError';
  }
}

/**
 * A centralized, typed server-side API client wrapper.
 * Automatically attaches the authenticated user's session token.
 */
export async function fetchApi<T>(
  path: string,
  options?: RequestInit & { params?: Record<string, string | undefined> }
): Promise<T> {
  const url = new URL(path, API_BASE);
  
  if (options?.params) {
    for (const [key, value] of Object.entries(options.params)) {
      if (value) url.searchParams.set(key, value);
    }
  }

  const headers = new Headers(options?.headers);
  headers.set('Accept', 'application/json');

  if (!headers.has('Content-Type') && options?.body && typeof options.body === 'string') {
    headers.set('Content-Type', 'application/json');
  }

  // Attach session token securely from cookies
  const token = await getSessionToken();
  if (token) {
    headers.set('Authorization', `Bearer ${token}`);
  }

  const response = await fetch(url, {
    ...options,
    signal: options?.signal
      ? AbortSignal.any([options.signal, AbortSignal.timeout(15000)])
      : AbortSignal.timeout(15000),
    headers,
  });

  if (!response.ok) {
    const isJson = response.headers.get('content-type')?.includes('application/json');
    const errorData = isJson ? await response.json().catch(() => null) : null;
    throw new ApiError(response.status, errorData);
  }

  // Returns empty object if 204 No Content
  if (response.status === 204) {
    return {} as T;
  }

  return (await response.json()) as T;
}
