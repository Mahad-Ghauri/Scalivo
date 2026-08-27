import { DateTime } from 'luxon';

/**
 * The one rule: store UTC everywhere, convert to business-local only at the
 * edges — display, and interpreting owner-entered times.
 *
 * Everything here takes an explicit IANA zone. There is deliberately no
 * "current timezone" default, because a server-local fallback is exactly how a
 * booking made at 4pm PKT ends up displayed as 11am, and how a "24h before"
 * reminder fires in the middle of the night.
 *
 * Never do date math on strings. Never use the raw Date constructor on a
 * wall-clock string.
 */

/** Interpret a local wall-clock time in a business's zone and return a UTC instant. */
export function wallClockToUtc(
  isoLocal: string,
  timezone: string,
): Date {
  const dt = DateTime.fromISO(isoLocal, { zone: timezone });
  if (!dt.isValid) {
    throw new Error(`Invalid wall-clock time "${isoLocal}" in zone "${timezone}": ${dt.invalidReason}`);
  }
  return dt.toUTC().toJSDate();
}

export function toBusinessLocal(instant: Date, timezone: string): DateTime {
  return DateTime.fromJSDate(instant, { zone: 'utc' }).setZone(timezone);
}

/** Display helper. Default is the format customers see in confirmations. */
export function formatLocal(instant: Date, timezone: string, format = 'ccc d LLL, h:mm a'): string {
  return toBusinessLocal(instant, timezone).toFormat(format);
}

/**
 * UTC bounds of a business's LOCAL day.
 *
 * "Today's bookings" for the 7am briefing, revenue by day, and no-show rates all
 * depend on this. Using the server's day boundary silently misattributes every
 * booking in the first five hours of a PKT day.
 */
export function businessDayBounds(isoDate: string, timezone: string): { start: Date; end: Date } {
  const start = DateTime.fromISO(isoDate, { zone: timezone }).startOf('day');
  if (!start.isValid) {
    throw new Error(`Invalid date "${isoDate}" in zone "${timezone}": ${start.invalidReason}`);
  }
  return { start: start.toUTC().toJSDate(), end: start.plus({ days: 1 }).toUTC().toJSDate() };
}

export function addMinutes(instant: Date, minutes: number): Date {
  return new Date(instant.getTime() + minutes * 60_000);
}

/**
 * Snap an instant down to the business's increment grid.
 *
 * Slot occupancy rows must land on exact grid points or two bookings that really
 * do overlap can produce non-colliding keys and slip past the unique index.
 */
export function alignToGrid(instant: Date, incrementMinutes: number): Date {
  const ms = incrementMinutes * 60_000;
  return new Date(Math.floor(instant.getTime() / ms) * ms);
}

/**
 * Every grid point a service occupies. A 45-min service on a 15-min grid
 * returns three instants; each becomes one slotOccupancy row.
 */
export function occupiedSlots(
  startsAt: Date,
  durationMinutes: number,
  incrementMinutes: number,
): Date[] {
  if (durationMinutes <= 0) throw new Error('durationMinutes must be positive');
  const aligned = alignToGrid(startsAt, incrementMinutes);
  const count = Math.ceil(durationMinutes / incrementMinutes);
  return Array.from({ length: count }, (_, i) => addMinutes(aligned, i * incrementMinutes));
}
