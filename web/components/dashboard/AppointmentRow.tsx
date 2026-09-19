import { type CalendarEntry, BOOKING_STATUS } from '@scalivo/shared';

interface Props {
  entry: CalendarEntry;
  timezone: string;
}

export function AppointmentRow({ entry, timezone }: Props) {
  // The API returns startsAt as an ISO string in JSON
  const dateObj = new Date(entry.startsAt);
  
  const timeFormatter = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    hour: 'numeric',
    minute: '2-digit',
  });
  
  const timeString = timeFormatter.format(dateObj);

  return (
    <div className="flex items-center justify-between py-4 border-b border-line last:border-0">
      <div className="flex flex-col gap-1">
        <p className="text-sm font-medium text-ink">
          {timeString} — {entry.clientName ?? 'Walk-in'}
        </p>
        <p className="text-xs text-muted">
          {entry.serviceName} with {entry.staffName}
        </p>
      </div>
      <div>
        <StatusBadge status={entry.status} />
      </div>
    </div>
  );
}

function StatusBadge({ status }: { status: string }) {
  let bg = 'bg-surface text-muted';
  let label = 'Unknown';

  switch (status) {
    case BOOKING_STATUS.PENDING:
      bg = 'bg-brand/10 text-brand';
      label = 'Pending';
      break;
    case BOOKING_STATUS.AWAITING_DEPOSIT:
      bg = 'bg-star/20 text-amber-900';
      label = 'Awaiting Deposit';
      break;
    case BOOKING_STATUS.CONFIRMED:
      bg = 'bg-brand/10 text-brand';
      label = 'Confirmed';
      break;
    case BOOKING_STATUS.COMPLETED:
      bg = 'bg-open/10 text-open';
      label = 'Completed';
      break;
    case BOOKING_STATUS.NO_SHOW:
      bg = 'bg-surface text-muted line-through';
      label = 'No Show';
      break;
    case BOOKING_STATUS.CANCELLED:
      bg = 'bg-surface text-muted line-through';
      label = 'Cancelled';
      break;
  }

  return (
    <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${bg}`}>
      {label}
    </span>
  );
}
