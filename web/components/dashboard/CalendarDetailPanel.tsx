import Link from 'next/link';
import type { CalendarEntry, Service, Staff } from '@scalivo/shared';
import { formatPrice } from '@/lib/marketplace';
import { CalendarDetailActions } from './CalendarDetailActions';

interface CalendarDetailPanelProps {
  businessId: string;
  entry: CalendarEntry;
  dateStr: string;
  view: 'day' | 'week';
  timezone: string;
  services: Service[];
  staff: Staff[];
}

export function CalendarDetailPanel({
  businessId,
  entry,
  dateStr,
  view,
  timezone,
  services,
  staff,
}: CalendarDetailPanelProps) {
  // Format the time range nicely using Intl.DateTimeFormat
  const dStart = new Date(entry.startsAt);
  const dEnd = new Date(entry.endsAt);

  const timeFormatter = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    hour: 'numeric',
    minute: 'numeric',
  });
  const timeRange = `${timeFormatter.format(dStart)} - ${timeFormatter.format(dEnd)}`;

  const dateFormatter = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    weekday: 'long',
    month: 'short',
    day: 'numeric',
  });
  const displayDate = dateFormatter.format(dStart);

  return (
    <div className="w-80 flex-none bg-white border border-line rounded-lg shadow-sm flex flex-col overflow-hidden">
      <div className="flex items-center justify-between px-4 py-3 border-b border-line bg-surface">
        <h2 className="font-display font-semibold text-ink">Appointment Details</h2>
        <Link
          href={`/dashboard/${businessId}/calendar?date=${dateStr}&view=${view}`}
          className="p-1 rounded hover:bg-surface text-muted hover:text-ink transition-colors"
          aria-label="Close details"
          scroll={false}
        >
          <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={2}
              d="M6 18L18 6M6 6l12 12"
            />
          </svg>
        </Link>
      </div>

      <div className="p-4 flex flex-col gap-6 overflow-y-auto">
        <div>
          <p className="text-xs font-semibold uppercase tracking-wider text-muted mb-1">Customer</p>
          <p className="text-[16px] font-semibold text-ink">{entry.clientName || 'Walk-in'}</p>
          {entry.clientPhone && (
            <p className="text-[14px] text-muted mt-0.5">{entry.clientPhone}</p>
          )}
        </div>

        <div>
          <p className="text-xs font-semibold uppercase tracking-wider text-muted mb-1">
            Service & Time
          </p>
          <p className="text-[16px] font-semibold text-ink">{entry.serviceName}</p>
          <p className="text-[14px] text-muted mt-0.5">{displayDate}</p>
          <p className="text-[14px] text-muted">
            {timeRange} ({entry.durationMinutes} min)
          </p>
        </div>

        <div className="flex gap-4">
          <div className="flex-1">
            <p className="text-xs font-semibold uppercase tracking-wider text-muted mb-1">Staff</p>
            <p className="text-[14px] font-semibold text-ink">{entry.staffName}</p>
          </div>
          <div className="flex-1">
            <p className="text-xs font-semibold uppercase tracking-wider text-muted mb-1">Price</p>
            <p className="text-[14px] font-semibold text-ink">{formatPrice(entry.priceMinor)}</p>
          </div>
        </div>

        <div>
          <p className="text-xs font-semibold uppercase tracking-wider text-muted mb-1">Status</p>
          <div className="inline-flex items-center px-2.5 py-1 rounded-full text-xs font-semibold capitalize bg-surface text-ink">
            {entry.status.replace('_', ' ')}
          </div>
        </div>

        {/* Action placeholders for Phase 3b/3c - explicitly inert */}
        <CalendarDetailActions
          businessId={businessId}
          timezone={timezone}
          entry={entry}
          services={services}
          staff={staff}
        />
      </div>
    </div>
  );
}
