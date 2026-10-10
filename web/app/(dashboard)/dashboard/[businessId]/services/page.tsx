import { fetchApi } from '@/lib/api-client';
import type { Service, Resource } from '@scalivo/shared';
import { ServiceManager } from '@/components/dashboard/ServiceManager';

export default async function DashboardServicesPage({
  params,
}: {
  params: Promise<{ businessId: string }>;
}) {
  const { businessId } = await params;

  let services: Service[] = [];
  let resources: Resource[] = [];
  let blocks: {
    id: string;
    resourceId: string;
    startsAt: string;
    endsAt: string;
    reason: string | null;
  }[] = [];
  let timezone = '';
  let failed = false;
  try {
    const [serviceResult, resourceResult, blockResult, business] = await Promise.all([
      fetchApi<{ services: Service[] }>(`/businesses/${businessId}/services?includeInactive=true`),
      fetchApi<{ resources: Resource[] }>(`/businesses/${businessId}/resources`),
      fetchApi<{ blocks: typeof blocks }>(`/businesses/${businessId}/resource-blocks`),
      fetchApi<{ timezone: string }>(`/businesses/${businessId}`),
    ]);
    services = serviceResult.services;
    resources = resourceResult.resources;
    blocks = blockResult.blocks;
    timezone = business.timezone;
  } catch (err) {
    failed = true;
    console.error('Failed to fetch service setup', err instanceof Error ? err.name : 'unknown');
  }

  return (
    <div className="p-8">
      {failed ? (
        <p role="alert">Could not load service setup. Refresh this page to try again.</p>
      ) : (
        <ServiceManager
          businessId={businessId}
          services={services}
          resources={resources}
          resourceBlocks={blocks}
          timezone={timezone}
        />
      )}
    </div>
  );
}
