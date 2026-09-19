import 'server-only';
import { cache } from 'react';
import { fetchApi } from '../api-client';

export interface AuthenticatedUser {
  id: string;
  name: string;
  email: string;
  role: string;
}

export interface AuthenticatedBusiness {
  id: string;
  name: string;
  category: string;
  timezone: string;
  whatsapp: {
    status: string | null;
    intent: string | null;
    lastStatusChange: string | null;
  };
}

export interface AuthSessionData {
  user: AuthenticatedUser;
  businesses: AuthenticatedBusiness[];
}

/**
 * Reads the current session and fetches the user's details and authorized businesses.
 * Wrapped in React `cache` to prevent duplicate API requests during a single render pass.
 */
export const getCurrentUser = cache(async (): Promise<AuthSessionData | null> => {
  try {
    const data = await fetchApi<AuthSessionData>('/auth/me');
    return data;
  } catch {
    // Treat API errors (like 401 Unauthorized) as unauthenticated.
    return null;
  }
});
