import type { ReminderState } from '@scalivo/shared';

const BADGE: Record<NonNullable<ReminderState>, { icon: string; label: string; cls: string }> = {
  confirmed: { icon: '✅', label: 'Customer confirmed', cls: 'bg-open/10 text-open' },
  awaiting: { icon: '❓', label: 'Awaiting reply', cls: 'bg-star/20 text-amber-900' },
  undelivered: { icon: '⚠️', label: 'Reminder not delivered', cls: 'bg-red-100 text-red-800' },
};

/**
 * The customer's side of a booking's reminders. Renders nothing before a
 * reminder has gone out, so an ordinary booking stays uncluttered.
 * `compact` is the calendar-card form: the icon alone, label as a tooltip.
 */
export function ReminderBadge({
  state,
  compact = false,
}: {
  state: ReminderState | undefined;
  compact?: boolean;
}) {
  if (!state) return null;
  const b = BADGE[state];
  if (compact) {
    return (
      <span title={b.label} aria-label={b.label} className="text-[10px] leading-none">
        {b.icon}
      </span>
    );
  }
  return (
    <span
      title={b.label}
      className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium ${b.cls}`}
    >
      <span aria-hidden>{b.icon}</span>
      {b.label}
    </span>
  );
}
