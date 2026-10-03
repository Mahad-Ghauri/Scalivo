import type { SessionStatus } from '@scalivo/shared';
import { fetchApi } from '@/lib/api-client';
import { WhatsAppConnect } from '@/components/dashboard/WhatsAppConnect';

/** Never cached: this page IS the current connection state. */
export const dynamic = 'force-dynamic';

interface Whatsapp {
  sessionId: string | null;
  status: SessionStatus | null;
  intent: string | null;
}

export default async function WhatsAppPage({
  params,
}: {
  params: Promise<{ businessId: string }>;
}) {
  const { businessId } = await params;

  let initial: Whatsapp = { sessionId: null, status: null, intent: null };
  try {
    initial = await fetchApi<Whatsapp>(`/businesses/${businessId}/whatsapp`);
  } catch (err) {
    // An unreachable backend must still render the screen — the owner coming
    // here is usually here BECAUSE something is wrong.
    console.error('Failed to read WhatsApp status', err);
  }

  return (
    <div className="p-8">
      <WhatsAppConnect businessId={businessId} initial={initial} />
    </div>
  );
}
