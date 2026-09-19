import Link from 'next/link';
import type { CalendarView } from '@scalivo/shared';
import { getGridBounds, computeOverlaps } from '@/lib/calendar-utils';
import { CalendarEntryCard, CalendarBlockCard } from './CalendarEvent';

interface CalendarGridProps {
  businessId: string;
  viewData: CalendarView;
  selectedEventId?: string | undefined;
  view: 'day' | 'week';
}

const MINUTE_HEIGHT = 1.5; // pixels per minute

export function CalendarGrid({ businessId, viewData, selectedEventId, view }: CalendarGridProps) {
  const { minHour, maxHour } = getGridBounds(viewData.days, viewData.timezone);
  const totalHours = maxHour - minHour + 1;
  const gridHeight = totalHours * 60 * MINUTE_HEIGHT;

  const hours = Array.from({ length: totalHours }, (_, i) => minHour + i);

  return (
    <div className="flex flex-col h-full bg-white border border-line rounded-2xl shadow-sm overflow-hidden">
      {/* Header Row */}
      <div className="flex border-b border-line bg-surface">
        <div className="w-16 flex-none border-r border-line" />
        <div className="flex flex-auto">
          {viewData.days.map((day) => {
            const date = new Date(day.date); // Native Date handles YYYY-MM-DD as UTC which is perfect for display
            const dayName = new Intl.DateTimeFormat('en-US', { weekday: 'short' }).format(date);
            const dayNumber = new Intl.DateTimeFormat('en-US', { day: 'numeric' }).format(date);
            const isToday = new Date().toISOString().split('T')[0] === day.date; // Approximation for highlight

            return (
              <div key={day.date} className="flex-1 flex flex-col items-center py-3 border-r border-line last:border-r-0">
                <span className="text-xs font-medium text-muted uppercase tracking-wider">{dayName}</span>
                <span className={`mt-1 flex h-8 w-8 items-center justify-center rounded-full text-sm font-semibold ${isToday ? 'bg-ink text-white' : 'text-ink'}`}>
                  {dayNumber}
                </span>
              </div>
            );
          })}
        </div>
      </div>

      {/* Grid Body */}
      <div className="flex flex-1 min-h-0 overflow-y-auto">
        {/* Time Axis */}
        <div className="w-16 flex-none border-r border-line bg-white">
          <div className="relative mt-4" style={{ height: gridHeight }}>
            {hours.map((hour) => (
              <div
                key={hour}
                className="absolute w-full flex justify-center -mt-2.5"
                style={{ top: (hour - minHour) * 60 * MINUTE_HEIGHT }}
              >
                <span className="text-xs font-medium text-muted">
                  {hour === 0 ? '12 AM' : hour < 12 ? `${hour} AM` : hour === 12 ? '12 PM' : `${hour - 12} PM`}
                </span>
              </div>
            ))}
          </div>
        </div>

        {/* Days Columns */}
        <div className="flex flex-auto bg-white">
          {viewData.days.map((day) => {
            // Overlap assignment
            const overlapBookings = computeOverlaps(day.entries, viewData.timezone);
            const overlapBlocks = computeOverlaps(day.blocks, viewData.timezone);
            
            const isEmpty = day.entries.length === 0 && day.blocks.length === 0;

            return (
              <div key={day.date} className="flex-1 relative border-r border-line last:border-r-0 min-w-[120px]">
                <div className="absolute inset-0 mt-4" style={{ height: gridHeight }}>
                  {/* Grid lines */}
                  {hours.map((hour) => (
                    <div
                      key={hour}
                      className="absolute w-full border-t border-line/50"
                      style={{ top: (hour - minHour) * 60 * MINUTE_HEIGHT }}
                    />
                  ))}
                  
                  {/* Empty state overlay (optional, maybe too noisy per column) */}
                  {isEmpty && view === 'day' && (
                    <div className="absolute inset-0 flex items-center justify-center">
                      <span className="text-sm text-muted">No appointments</span>
                    </div>
                  )}

                  {/* Render Blocks */}
                  {overlapBlocks.map(({ item, topMinutes, durationMinutes, col, maxCols }) => {
                    const top = (topMinutes - minHour * 60) * MINUTE_HEIGHT;
                    const height = durationMinutes * MINUTE_HEIGHT;
                    const width = `${100 / maxCols}%`;
                    const left = `${(100 / maxCols) * col}%`;

                    return (
                      <CalendarBlockCard
                        key={item.id}
                        block={item}
                        style={{ top, height, left, width }}
                      />
                    );
                  })}

                  {/* Render Bookings */}
                  {overlapBookings.map(({ item, topMinutes, durationMinutes, col, maxCols }) => {
                    const top = (topMinutes - minHour * 60) * MINUTE_HEIGHT;
                    const height = durationMinutes * MINUTE_HEIGHT;
                    const width = `${100 / maxCols}%`;
                    const left = `${(100 / maxCols) * col}%`;

                    return (
                      <Link
                        key={item.id}
                        href={`/dashboard/${businessId}/calendar?date=${day.date}&view=${view}&eventId=${item.id}`}
                        scroll={false}
                      >
                        <CalendarEntryCard
                          businessId={businessId}
                          entry={item}
                          isSelected={selectedEventId === item.id}
                          style={{ top, height, left, width }}
                        />
                      </Link>
                    );
                  })}
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
