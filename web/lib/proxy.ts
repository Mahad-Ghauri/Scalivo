import 'server-only';
import { NextResponse } from 'next/server';
import { API_BASE } from './api-client';
import { getSessionToken } from './auth/session';

/**
 * Forwarding one dashboard call to the backend with the owner's token.
 *
 * Needed because the session JWT is an httpOnly cookie — deliberately, so page
 * scripts cannot read it — which means a browser component cannot call the
 * backend itself. Anything interactive has to go through a route handler here,
 * where the cookie is readable.
 *
 * **Narrow on purpose.** A catch-all `/api/[...path]` proxy would have been
 * fewer files and would have handed any script on the page an authenticated
 * channel to every backend route the owner can reach. Each handler names its own
 * path instead, so what the browser can reach is a list somebody has to add to.
 */
export async function forward(
  path: string,
  init: { method: 'GET' | 'POST'; body?: unknown } = { method: 'GET' },
): Promise<NextResponse> {
  const token = await getSessionToken();
  if (!token) {
    return NextResponse.json({ error: 'not signed in' }, { status: 401 });
  }

  try {
    const res = await fetch(new URL(path, API_BASE), {
      method: init.method,
      cache: 'no-store',
      signal: AbortSignal.timeout(15000),
      headers: {
        Authorization: `Bearer ${token}`,
        accept: 'application/json',
        ...(init.body ? { 'content-type': 'application/json' } : {}),
      },
      ...(init.body ? { body: JSON.stringify(init.body) } : {}),
    });

    const text = await res.text();
    // Passed through rather than reshaped: the backend's refusals are already
    // written for the person reading them, and a second layer of wording is a
    // second place for them to drift.
    return new NextResponse(text || '{}', {
      status: res.status,
      headers: { 'content-type': 'application/json' },
    });
  } catch {
    return NextResponse.json({ error: 'Could not reach the server.' }, { status: 502 });
  }
}
