'use client';

import { useEffect, useState } from 'react';
import type { WorkingHours } from '@scalivo/shared';

import { ClockIcon } from '@/components/Icons';
import { dayName, formatTime } from '@/lib/marketplace';

/** Monday first — the way the week reads here, with Sunday usually the day off. */
const WEEK = [1, 2, 3, 4, 5, 6, 0];

/**
 * "Now" in the BUSINESS's timezone. Client-only on purpose: these pages are
 * statically rendered, so a server-computed "today" would be the build day.
 * Both hooks start as null — identical on server and client — and fill in
 * after mount, so hydration never disagrees.
 */
function useBusinessNow(timezone: string) {
  const [now, setNow] = useState<{ day: number; minutes: number } | null>(null);

  useEffect(() => {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone,
      weekday: 'long',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    }).formatToParts(new Date());
    const get = (type: string) => parts.find((part) => part.type === type)?.value ?? '';
    setNow({
      day: WEEK.find((day) => dayName(day) === get('weekday')) ?? 0,
      minutes: Number(get('hour')) * 60 + Number(get('minute')),
    });
  }, [timezone]);

  return now;
}

const toMinutes = (wallClock: string) => {
  const [hours, minutes] = wallClock.split(':').map(Number);
  return (hours ?? 0) * 60 + (minutes ?? 0);
};

/** "Open until 6:00 PM" / "Closed — opens Monday 9:00 AM". */
export function OpenStatus({ hours, timezone }: { hours: WorkingHours[]; timezone: string }) {
  const now = useBusinessNow(timezone);
  if (!now || hours.length === 0) return null;

  const today = hours.find((entry) => entry.dayOfWeek === now.day);
  const inBreak = today?.breaks.some((pause) => now.minutes >= toMinutes(pause.startsAt) && now.minutes < toMinutes(pause.endsAt));

  if (today && !inBreak && now.minutes >= toMinutes(today.opensAt) && now.minutes < toMinutes(today.closesAt)) {
    return <span className="font-semibold text-open">Open until {formatTime(today.closesAt)}</span>;
  }

  for (let offset = 0; offset <= 7; offset += 1) {
    const day = (now.day + offset) % 7;
    const entry = hours.find((candidate) => candidate.dayOfWeek === day);
    if (!entry) continue;
    if (offset === 0 && now.minutes >= toMinutes(entry.opensAt)) continue;
    const when = offset === 0 ? 'today' : offset === 1 ? 'tomorrow' : dayName(day);
    return (
      <span>
        <span className="font-semibold text-muted">Closed</span> · opens {when} {formatTime(entry.opensAt)}
      </span>
    );
  }

  return null;
}

/** The weekly list: a green dot for open days, grey for closed, today in bold. */
export function OpeningHours({ hours, timezone }: { hours: WorkingHours[]; timezone: string }) {
  const now = useBusinessNow(timezone);
  const byDay = new Map(hours.map((entry) => [entry.dayOfWeek, entry]));

  return (
    <table className="w-full max-w-[420px] text-[15px]">
      <caption className="sr-only">Opening times</caption>
      <tbody>
        {WEEK.map((day) => {
          const entry = byDay.get(day);
          const isToday = now?.day === day;
          return (
            <tr key={day} className={isToday ? 'font-semibold' : ''}>
              <th scope="row" className="py-1.5 text-left font-[inherit]">
                <span className="flex items-center gap-3">
                  <span
                    aria-hidden="true"
                    className={`h-2.5 w-2.5 rounded-full ${entry ? 'bg-open' : 'bg-line'}`}
                  />
                  {dayName(day)}
                  {isToday ? <span className="sr-only">(today)</span> : null}
                </span>
              </th>
              <td className="py-1.5 text-right">
                {entry ? (
                  <>
                    {formatTime(entry.opensAt)} – {formatTime(entry.closesAt)}
                    {entry.breaks.length > 0 ? (
                      <span className="block text-[13px] font-normal text-muted">
                        Break {entry.breaks.map((pause) => `${formatTime(pause.startsAt)} – ${formatTime(pause.endsAt)}`).join(', ')}
                      </span>
                    ) : null}
                  </>
                ) : (
                  <span className="text-muted">Closed</span>
                )}
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

export function ClockLine({ hours, timezone }: { hours: WorkingHours[]; timezone: string }) {
  return (
    <p className="flex items-start gap-3 text-[15px]">
      <ClockIcon className="mt-0.5 h-5 w-5 shrink-0" />
      <OpenStatus hours={hours} timezone={timezone} />
    </p>
  );
}
