import { type CalendarEntry } from '@scalivo/shared';
import { AppointmentRow } from './AppointmentRow';

interface Props {
  entries: CalendarEntry[];
  timezone: string;
  emptyMessage: string;
}

export function AppointmentList({ entries, timezone, emptyMessage }: Props) {
  if (entries.length === 0) {
    return (
      <div className="rounded-lg border border-line bg-white p-8 text-center">
        <p className="text-sm text-muted">{emptyMessage}</p>
      </div>
    );
  }

  return (
    <div className="rounded-lg border border-line bg-white px-6">
      <div className="divide-y divide-line">
        {entries.map((entry) => (
          <AppointmentRow key={entry.id} entry={entry} timezone={timezone} />
        ))}
      </div>
    </div>
  );
}
