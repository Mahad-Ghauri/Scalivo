/**
 * MongoDB's duplicate-key error, however it is wrapped by the driver.
 *
 * Checked in two places — the booking write and the reschedule write — and both
 * depend on it being right, because a duplicate key is not an error there: it is
 * the occupancy grid's unique index doing the one job the whole design rests on,
 * and it has to be turned into "that slot just went" rather than a 500.
 *
 * The `writeErrors` branch is not defensive padding. `insertMany` reports
 * per-document failures in that array rather than on the top-level `code`, and
 * occupancy rows are always written with insertMany.
 */
export function isDuplicateKey(err: unknown): boolean {
  if (typeof err !== 'object' || err === null) return false;
  const e = err as { code?: number; writeErrors?: { code?: number }[] };
  if (e.code === 11000) return true;
  return Array.isArray(e.writeErrors) && e.writeErrors.some((w) => w.code === 11000);
}
