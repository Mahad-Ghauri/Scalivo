import { fetchApi } from '@/lib/api-client';
import type { Staff, Service } from '@scalivo/shared';
import { StaffManager } from '@/components/dashboard/StaffManager';

export default async function DashboardStaffPage({
  params,
}: {
  params: Promise<{ businessId: string }>;
}) {
  const { businessId } = await params;
  
  let staff: Staff[] = [];
  let services: Service[] = [];
  
  try {
    const [staffRes, servicesRes] = await Promise.all([
      fetchApi<{ staff: Staff[] }>(`/businesses/${businessId}/staff?includeInactive=true`),
      fetchApi<{ services: Service[] }>(`/businesses/${businessId}/services?includeInactive=true`)
    ]);
    staff = staffRes.staff;
    services = servicesRes.services;
  } catch (err) {
    console.error('Failed to fetch staff/services', err);
  }

  return (
    <div className="p-8">
      <StaffManager businessId={businessId} staff={staff} services={services} />
    </div>
  );
}