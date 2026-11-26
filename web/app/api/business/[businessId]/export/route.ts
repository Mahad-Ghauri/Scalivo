import { NextResponse } from 'next/server';
import { API_BASE } from '@/lib/api-client';
import { getSessionToken } from '@/lib/auth/session';

/**
 * The appointments CSV, downloaded with the owner's session.
 *
 * Its own handler rather than `forward()`: that one is JSON-only, and this has
 * to pass the file through with its filename. Only the four known query keys
 * are forwarded, so this can't be used to reach anything but the export.
 */
const KEYS = ['from', 'to', 'staffId', 'includeCancelled'] as const;

export async function GET(
  request: Request,
  { params }: { params: Promise<{ businessId: string }> },
) {
  const token = await getSessionToken();
  if (!token) return NextResponse.json({ error: 'not signed in' }, { status: 401 });

  const { businessId } = await params;
  const incoming = new URL(request.url).searchParams;
  const target = new URL(
    `/businesses/${encodeURIComponent(businessId)}/export/appointments.csv`,
    API_BASE,
  );
  for (const key of KEYS) {
    const value = incoming.get(key);
    if (value) target.searchParams.set(key, value);
  }

  try {
    const res = await fetch(target, {
      cache: 'no-store',
      signal: AbortSignal.timeout(30000),
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) {
      return new NextResponse(await res.text(), {
        status: res.status,
        headers: { 'content-type': res.headers.get('content-type') ?? 'application/json' },
      });
    }
    return new NextResponse(res.body, {
      status: 200,
      headers: {
        'content-type': 'text/csv; charset=utf-8',
        'content-disposition':
          res.headers.get('content-disposition') ?? 'attachment; filename="appointments.csv"',
        'cache-control': 'no-store',
      },
    });
  } catch {
    return NextResponse.json({ error: 'Could not reach the server.' }, { status: 502 });
  }
}
