import { forward } from '@/lib/proxy';

/** Restart an existing session — the Session Health recovery path. */
export async function POST(_request: Request, { params }: { params: Promise<{ businessId: string }> }) {
  const { businessId } = await params;
  return forward(`/businesses/${encodeURIComponent(businessId)}/whatsapp/link`, { method: 'POST' });
}
