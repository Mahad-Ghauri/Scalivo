/** Formatting safe to import from client components — no data, no fixtures. */

/**
 * Paisa → "Rs 8,000" (en-PK's own currency symbol). Minor units all the way to the edge: a price is never a
 * float anywhere in this codebase, and this is the only place it becomes text.
 */
export function formatPrice(priceMinor: number): string {
  return new Intl.NumberFormat('en-PK', {
    style: 'currency',
    currency: 'PKR',
    maximumFractionDigits: 0,
  }).format(priceMinor / 100);
}

/** 45 → "45 min", 90 → "1 hr 30 min". */
export function formatDuration(minutes: number): string {
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest === 0 ? `${hours} hr` : `${hours} hr ${rest} min`;
}

/**
 * An instant in the BUSINESS's zone — never the reader's.
 *
 * A customer checking their appointment from abroad must still see the time the
 * salon will be expecting them, and a phone whose clock is in another country is
 * the case that makes a naive `toLocaleString()` say 11 AM for a 4 PM booking.
 * Every time the customer's page prints goes through here.
 *
 * 12-hour throughout: "3:31" on its own reads as the afternoon at night.
 */
export function formatWhen(iso: string, timezone: string): string {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: timezone,
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  }).format(new Date(iso));
}

/** Just the clock part, for a list where the day is already the heading. */
export function formatClock(iso: string, timezone: string): string {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: timezone,
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  }).format(new Date(iso));
}

/** "3 October 2026" — a past visit, where the hour is noise. */
export function formatDay(iso: string, timezone: string): string {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: timezone,
    day: 'numeric',
    month: 'long',
    year: 'numeric',
  }).format(new Date(iso));
}
