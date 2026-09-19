import React from 'react';
import { fetchApi } from '@/lib/api-client';
import type { Business, Service, Staff } from '@scalivo/shared';
import { AppointmentsFilters } from '@/components/dashboard/appointments/AppointmentsFilters';
import { AppointmentsTable } from '@/components/dashboard/appointments/AppointmentsTable';
import { AppointmentDetail } from '@/components/dashboard/appointments/AppointmentDetail';
import { Pagination } from '@/components/dashboard/Pagination';

export default async function DashboardAppointmentsPage({
  params,
  searchParams,
}: {
  params: { businessId: string };
  searchParams: { [key: string]: string | string[] | undefined };
}) {
  const businessId = params.businessId;
  const sp = new URLSearchParams();
  
  // Forward relevant search params to the backend API
  const allowedParams = ['status', 'staffId', 'serviceId', 'from', 'to', 'q', 'sort'];
  for (const key of allowedParams) {
    if (typeof searchParams[key] === 'string') {
      sp.set(key, searchParams[key] as string);
    }
  }

  const pageStr = typeof searchParams['page'] === 'string' ? searchParams['page'] : '1';
  const page = parseInt(pageStr, 10) || 1;
  const limitStr = typeof searchParams['limit'] === 'string' ? searchParams['limit'] : '50';
  const limit = parseInt(limitStr, 10) || 50;
  const skip = (page - 1) * limit;

  sp.set('limit', limit.toString());
  sp.set('skip', skip.toString());

  // Fetch Business timezone, Staff, Services, and the Appointments page
  const [business, staffRes, servicesRes, appointmentsRes] = await Promise.all([
    fetchApi<Business>(`/businesses/${businessId}`),
    fetchApi<{ staff: Staff[] }>(`/businesses/${businessId}/staff?includeInactive=true`),
    fetchApi<{ services: Service[] }>(`/businesses/${businessId}/services?includeInactive=true`),
    fetchApi<any>(`/businesses/${businessId}/bookings?${sp.toString()}`)
  ]);

  const { bookings, total } = appointmentsRes;
  const staff = staffRes.staff;
  const services = servicesRes.services;
  const timezone = business.timezone;

  return (
    <div className="space-y-6">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-display font-semibold text-ink capitalize">appointments</h1>
          <p className="mt-1 text-sm text-muted">Manage your business schedule and booking history.</p>
        </div>
      </div>

      <AppointmentsFilters staff={staff} services={services} />

      <AppointmentsTable bookings={bookings} timezone={timezone} />

      {total > 0 && (
        <Pagination total={total} pageSize={limit} currentPage={page} />
      )}

      {/* Detail Modal */}
      {searchParams.appointmentId && typeof searchParams.appointmentId === 'string' && (
        <AppointmentDetail 
          businessId={businessId} 
          appointmentId={searchParams.appointmentId} 
          timezone={timezone} 
        />
      )}
    </div>
  );
}