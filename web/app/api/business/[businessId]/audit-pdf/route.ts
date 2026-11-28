import { NextResponse } from 'next/server';
import { API_BASE } from '@/lib/api-client';
import { getSessionToken } from '@/lib/auth/session';

/**
 * The audit report PDF, downloaded with the owner's session. Same shape as the
 * CSV export: only the known query keys are forwarded.
 */
const KEYS = ['from', 'to', 'category', 'search'] as const;

export async function GET(
  request: Request,
  { params }: { params: Promise<{ businessId: string }> },
) {
  const token = await getSessionToken();
  if (!token) return NextResponse.json({ error: 'not signed in' }, { status: 401 });

  const { businessId } = await params;
  const incoming = new URL(request.url).searchParams;
  const target = new URL(
    `/businesses/${encodeURIComponent(businessId)}/audit/report.pdf`,
    API_BASE,
  );
  for (const key of KEYS) {
    const value = incoming.get(key);
    if (value) target.searchParams.set(key, value);
  }

  try {
    const res = await fetch(target, {
      cache: 'no-store',
      signal: AbortSignal.timeout(60000),
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
        'content-type': 'application/pdf',
        'content-disposition':
          res.headers.get('content-disposition') ?? 'attachment; filename="audit-report.pdf"',
        'cache-control': 'no-store',
      },
    });
  } catch {
    return NextResponse.json({ error: 'Could not reach the server.' }, { status: 502 });
  }
}
