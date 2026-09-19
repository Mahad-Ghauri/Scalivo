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
