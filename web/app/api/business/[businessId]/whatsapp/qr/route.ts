import { forward } from '@/lib/proxy';

/** The QR the session is offering right now. Polled while a scan is outstanding. */
export async function GET(_request: Request, { params }: { params: Promise<{ businessId: string }> }) {
  const { businessId } = await params;
  return forward(`/businesses/${encodeURIComponent(businessId)}/whatsapp/qr`);
}
