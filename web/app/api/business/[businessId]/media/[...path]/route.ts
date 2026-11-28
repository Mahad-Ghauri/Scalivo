import { NextResponse } from 'next/server';
import { API_BASE } from '@/lib/api-client';
import { getSessionToken } from '@/lib/auth/session';
import { MAX_IMAGE_BYTES } from '@/lib/media';

/**
 * Image upload/management, forwarded to the backend with the owner's session.
 *
 * Narrow on purpose, like lib/proxy.ts: only the image routes below can be
 * reached, each with its own method list and its own allowed query keys. The
 * body is streamed through untouched — not buffered here — so an 8 MB photo
 * costs this server no memory, and the backend makes every real decision
 * (format, size, ownership).
 */

const HEX24 = '[0-9a-f]{24}';
const HEX32 = '[0-9a-f]{32}';

const ROUTES: { pattern: RegExp; methods: string[]; query: string[] }[] = [
  { pattern: /^images\/(logo|cover)$/, methods: ['PUT', 'DELETE'], query: [] },
  { pattern: /^images\/gallery$/, methods: ['POST'], query: ['alt'] },
  { pattern: /^images\/gallery\/order$/, methods: ['PUT'], query: [] },
  { pattern: new RegExp(`^images/gallery/${HEX32}$`), methods: ['PATCH', 'DELETE'], query: [] },
  { pattern: new RegExp(`^services/${HEX24}/image$`), methods: ['PUT', 'DELETE'], query: [] },
  { pattern: new RegExp(`^staff/${HEX24}/photo$`), methods: ['PUT', 'DELETE'], query: ['consent'] },
];

type Ctx = { params: Promise<{ businessId: string; path: string[] }> };

async function forward(request: Request, ctx: Ctx): Promise<Response> {
  const { businessId, path } = await ctx.params;
  const route = path.join('/');
  const match = ROUTES.find((r) => r.pattern.test(route));
  if (!match || !/^[0-9a-f]{24}$/.test(businessId)) {
    return NextResponse.json({ error: 'Not found.' }, { status: 404 });
  }
  if (!match.methods.includes(request.method)) {
    return NextResponse.json({ error: 'Method not allowed.' }, { status: 405 });
  }

  const token = await getSessionToken();
  if (!token) return NextResponse.json({ error: 'not signed in' }, { status: 401 });

  // Refuse oversize uploads here, before streaming 8 MB+ to the backend.
  const declared = Number(request.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > MAX_IMAGE_BYTES) {
    return NextResponse.json({ error: 'Images must be under 8 MB.', reason: 'too_large' }, { status: 413 });
  }

  const target = new URL(`/businesses/${businessId}/${route}`, API_BASE);
  const incoming = new URL(request.url).searchParams;
  for (const key of match.query) {
    const value = incoming.get(key);
    if (value !== null) target.searchParams.set(key, value.slice(0, 300));
  }

  const hasBody = request.method !== 'DELETE' && request.body;
  try {
    const res = await fetch(target, {
      method: request.method,
      cache: 'no-store',
      signal: AbortSignal.timeout(60_000),
      headers: {
        Authorization: `Bearer ${token}`,
        accept: 'application/json',
        ...(hasBody ? { 'content-type': request.headers.get('content-type') ?? 'application/octet-stream' } : {}),
        ...(hasBody && Number.isFinite(declared) ? { 'content-length': String(declared) } : {}),
      },
      ...(hasBody ? { body: request.body, duplex: 'half' } : {}),
    } as RequestInit);
    const text = await res.text();
    return new NextResponse(text || null, {
      status: res.status,
      headers: {
        'content-type': 'application/json',
        ...(res.headers.get('retry-after') ? { 'retry-after': res.headers.get('retry-after')! } : {}),
      },
    });
  } catch {
    return NextResponse.json({ error: 'Could not reach the server.' }, { status: 502 });
  }
}

export const PUT = forward;
export const POST = forward;
export const PATCH = forward;
export const DELETE = forward;
