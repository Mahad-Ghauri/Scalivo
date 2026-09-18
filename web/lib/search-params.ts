import type { MarketplaceFilters } from '@/lib/marketplace';

/** Next gives repeated query keys as arrays. A filter only ever means one value. */
export type RawSearchParams = Record<string, string | string[] | undefined>;

export function firstParam(value: string | string[] | undefined): string | undefined {
  const first = Array.isArray(value) ? value[0] : value;
  const trimmed = first?.trim();
  return trimmed ? trimmed : undefined;
}

/**
 * Built key by key rather than as an object literal: under
 * `exactOptionalPropertyTypes`, `{ category: undefined }` is not the same thing
 * as an absent filter, and the data layer reads absence as "no constraint".
 */
export function toFilters(category: string | undefined, city: string | undefined): MarketplaceFilters {
  const filters: MarketplaceFilters = {};
  if (category) filters.category = category;
  if (city) filters.city = city;
  return filters;
}
