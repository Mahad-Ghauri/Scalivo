'use client';

import React from 'react';
import Link from 'next/link';
import { usePathname, useSearchParams } from 'next/navigation';
import { BOOKING_STATUS, type BookingStatus } from '@scalivo/shared';
import { formatPrice } from '@/lib/format';

/** One row of GET /businesses/:id/bookings, and the body of GET .../bookings/:bookingId. */
export interface AppointmentDTO {
  id: string;
  startsAt: string;
  durationMinutes: number;
  status: BookingStatus;
  priceMinor: number;
  source: string;
  client: { id: string; name: string | null; phone: string | null } | null;
  service: { id: string; name: string } | null;
  staff: { id: string; name: string } | null;
}

export function AppointmentsTable({ bookings, timezone }: { bookings: AppointmentDTO[], timezone: string }) {
  const pathname = usePathname();
  const searchParams = useSearchParams();

  const getDetailUrl = (appointmentId: string) => {
    const sp = new URLSearchParams(searchParams.toString());
    sp.set('appointmentId', appointmentId);
    return `${pathname}?${sp.toString()}`;
  };

  const statusColors: Record<string, string> = {
    [BOOKING_STATUS.PENDING]: 'bg-yellow-100 text-yellow-800',
    [BOOKING_STATUS.CONFIRMED]: 'bg-blue-100 text-blue-800',
    [BOOKING_STATUS.COMPLETED]: 'bg-green-100 text-green-800',
    [BOOKING_STATUS.NO_SHOW]: 'bg-red-100 text-red-800',
    [BOOKING_STATUS.CANCELLED]: 'bg-neutral-200 text-neutral-800',
  };

  if (!bookings || bookings.length === 0) {
    return (
      <div className="bg-white rounded-xl border border-line p-12 text-center">
        <p className="text-muted text-sm">No appointments found matching these filters.</p>
      </div>
    );
  }

  return (
    <div className="bg-white rounded-xl border border-line overflow-hidden shadow-sm">
      <div className="overflow-x-auto">
        <table className="w-full text-left border-collapse">
          <thead>
            <tr className="border-b border-line bg-surface/50 text-[11px] font-semibold text-muted tracking-wider uppercase">
              <th className="px-6 py-4">Date & Time</th>
              <th className="px-6 py-4">Customer</th>
              <th className="px-6 py-4">Service</th>
              <th className="px-6 py-4">Staff</th>
              <th className="px-6 py-4">Status</th>
              <th className="px-6 py-4">Amount</th>
              <th className="px-6 py-4 text-right">Action</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-line">
            {bookings.map((b) => {
              const d = new Date(b.startsAt);
              const dateFormatted = new Intl.DateTimeFormat('en-US', {
                timeZone: timezone,
                month: 'short',
                day: 'numeric',
                year: 'numeric'
              }).format(d);
              
              const timeFormatted = new Intl.DateTimeFormat('en-US', {
                timeZone: timezone,
                hour: 'numeric',
                minute: '2-digit'
              }).format(d);

              return (
                <tr key={b.id} className="hover:bg-surface/30 transition-colors">
                  <td className="px-6 py-4 whitespace-nowrap">
                    <div className="text-sm font-medium text-ink">{dateFormatted}</div>
                    <div className="text-xs text-muted">{timeFormatted} ({b.durationMinutes}m)</div>
                  </td>
                  <td className="px-6 py-4">
                    <div className="text-sm font-medium text-ink">{b.client?.name || 'Unknown'}</div>
                    <div className="text-xs text-muted">{b.client?.phone || 'No phone'}</div>
                  </td>
                  <td className="px-6 py-4">
                    <div className="text-sm text-ink">{b.service?.name || 'Unknown Service'}</div>
                  </td>
                  <td className="px-6 py-4">
                    <div className="text-sm text-ink">{b.staff?.name || 'Unknown Staff'}</div>
                  </td>
                  <td className="px-6 py-4 whitespace-nowrap">
                    <span className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium ${statusColors[b.status] || statusColors[BOOKING_STATUS.PENDING]}`}>
                      {b.status}
                    </span>
                  </td>
                  <td className="px-6 py-4 whitespace-nowrap">
                    <div className="text-sm font-medium text-ink">{formatPrice(b.priceMinor)}</div>
                  </td>
                  <td className="px-6 py-4 whitespace-nowrap text-right">
                    <Link href={getDetailUrl(b.id)} className="text-sm font-medium text-brand hover:text-brand/80 transition-colors">
                      View
                    </Link>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
