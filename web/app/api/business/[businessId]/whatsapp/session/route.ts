import { forward } from '@/lib/proxy';

/**
 * Provision a session and get a linking QR.
 *
 * `force` is passed through, never defaulted here: replacing a working session
 * logs the owner's phone out of it, and that decision belongs to the person who
 * clicked, not to a proxy.
 */
export async function POST(request: Request, { params }: { params: Promise<{ businessId: string }> }) {
  const { businessId } = await params;
  const force = new URL(request.url).searchParams.get('force') === 'true';
  return forward(
    `/businesses/${encodeURIComponent(businessId)}/whatsapp/session${force ? '?force=true' : ''}`,
    { method: 'POST' },
  );
}
