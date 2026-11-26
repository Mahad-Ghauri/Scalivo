import type { CalendarEntry, CalendarBlock } from '@scalivo/shared';
import { BOOKING_STATUS } from '@scalivo/shared';
import { ReminderBadge } from './ReminderBadge';

interface CalendarEntryCardProps {
  businessId: string;
  entry: CalendarEntry;
  style?: React.CSSProperties;
  isSelected?: boolean;
}

export function CalendarEntryCard({ entry, style, isSelected }: CalendarEntryCardProps) {
  // Styling based on status
  let bg = 'bg-brand/10 hover:bg-brand/20';
  let border = 'border-brand/20';
  let text = 'text-brand';

  switch (entry.status) {
    case BOOKING_STATUS.CANCELLED:
    case BOOKING_STATUS.NO_SHOW:
      bg = 'bg-surface hover:bg-line/50';
      border = 'border-line';
      text = 'text-muted line-through';
      break;
    case BOOKING_STATUS.COMPLETED:
      bg = 'bg-open/10 hover:bg-open/20';
      border = 'border-open/20';
      text = 'text-open';
      break;
    case BOOKING_STATUS.AWAITING_DEPOSIT:
      bg = 'bg-star/20 hover:bg-star/30';
      border = 'border-star/40';
      text = 'text-amber-900';
      break;
    case BOOKING_STATUS.CONFIRMED:
    case BOOKING_STATUS.PENDING:
    default:
      bg = 'bg-brand/10 hover:bg-brand/20';
      border = 'border-brand/20';
      text = 'text-brand';
      break;
  }

  if (isSelected) {
    border = 'border-ink ring-1 ring-ink z-10 shadow-md';
  }

  // The link preserves existing search params if needed, but for now we just 
  // append the eventId to whatever the current URL is. We will use Next.js 
  // Link with search parameter merging in the parent, but here we can just
  // assume the parent passes the exact href or we use a client component 
  // to push the router state. Actually, it's easier to just rely on the 
  // fact that clicking it could open a modal if the parent handles it.
  // Wait, the plan said "?eventId=..." in the URL. Since this is a server component,
  // we can't easily read current searchParams to preserve 'date' and 'view' without passing them down.
  // Let's pass the base URL with search params down.
  
  return (
    <div
      style={style}
      className={`absolute inset-x-0 mx-0.5 overflow-hidden rounded-md border px-1.5 py-1 leading-tight transition-colors ${bg} ${border} ${text}`}
    >
      <div className="flex items-center gap-1 font-semibold truncate text-xs">
        <span className="truncate">{entry.clientName || 'Walk-in'}</span>
        <ReminderBadge state={entry.reminderState} compact />
      </div>
      <div className="truncate text-xs">{entry.serviceName}</div>
      <div className="truncate text-[10px] font-medium mt-0.5">
        {entry.staffName}
      </div>
    </div>
  );
}

interface CalendarBlockCardProps {
  block: CalendarBlock;
  style?: React.CSSProperties;
}

export function CalendarBlockCard({ block, style }: CalendarBlockCardProps) {
  return (
    <div
      className="absolute mx-0.5 overflow-hidden rounded-md border border-line bg-surface px-1.5 py-1 text-xs leading-tight text-muted opacity-80"
      style={{
        ...style,
        backgroundImage: 'repeating-linear-gradient(45deg, transparent, transparent 10px, var(--color-line) 10px, var(--color-line) 20px)'
      }}
    >
      <div className="font-medium truncate">{block.reason || 'Blocked'}</div>
    </div>
  );
}
