import { fetchApi } from '@/lib/api-client';
import { SettingsForm, type EditableBusiness } from '@/components/dashboard/SettingsForm';
import { ExportPanel } from '@/components/dashboard/ExportPanel';
import type { FeedStatus } from '@/lib/actions/calendar-feed';

/**
 * Business settings and the public profile.
 *
 * Staff hours are not here: they belong to each person, and live on the Staff
 * page next to the services they can perform.
 */
export default async function DashboardSettingsPage({
  params,
}: {
  params: Promise<{ businessId: string }>;
}) {
  const { businessId } = await params;

  let business: EditableBusiness | null = null;
  let feed: FeedStatus = { enabled: false, createdAt: null };
  let staff: { id: string; name: string }[] = [];
  try {
    business = await fetchApi<EditableBusiness>(`/businesses/${businessId}`);
  } catch {
    business = null;
  }
  // Secondary: settings still render if these fail.
  await Promise.all([
    fetchApi<FeedStatus>(`/businesses/${businessId}/calendar-feed`, { cache: 'no-store' })
      .then((f) => (feed = f))
      .catch(() => undefined),
    fetchApi<{ staff: { id: string; name: string }[] }>(`/businesses/${businessId}/staff`)
      .then((r) => (staff = r.staff.map(({ id, name }) => ({ id, name }))))
      .catch(() => undefined),
  ]);

  return (
    <div className="space-y-6 py-2">
      <div>
        <h1 className="text-2xl font-bold tracking-tight text-ink lowercase font-display">settings</h1>
        <p className="mt-1 text-[15px] text-muted">
          How customers find you, when they can book, and when they are reminded.
        </p>
      </div>

      {business ? (
        <>
          <SettingsForm businessId={businessId} business={business} />
          <ExportPanel
            businessId={businessId}
            timezone={business.timezone}
            feed={feed}
            staff={staff}
          />
        </>
      ) : (
        <div className="rounded-2xl border border-red-100 bg-red-50 p-12 text-center shadow-sm">
          <h2 className="text-lg font-semibold text-red-900">Failed to load settings</h2>
          <p className="mt-2 text-sm font-medium text-red-700">Please try refreshing.</p>
        </div>
      )}
    </div>
  );
}
