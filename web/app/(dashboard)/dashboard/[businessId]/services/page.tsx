import { fetchApi } from '@/lib/api-client';
import type { Service } from '@scalivo/shared';
import { ServiceManager } from '@/components/dashboard/ServiceManager';

export default async function DashboardServicesPage({
  params,
}: {
  params: Promise<{ businessId: string }>;
}) {
  const { businessId } = await params;
  
  let services: Service[] = [];
  try {
    const res = await fetchApi<{ services: Service[] }>(
      `/businesses/${businessId}/services?includeInactive=true`
    );
    services = res.services;
  } catch (err) {
    console.error('Failed to fetch services', err);
  }

  return (
    <div className="p-8">
      <ServiceManager businessId={businessId} services={services} />
    </div>
  );
}