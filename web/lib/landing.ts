import type { FacetOption } from '@scalivo/shared';

/**
 * City and category landing pages — "Clinics in Multan" — for SEO (4.3).
 *
 * They are the search page with only `category` and/or `city` set. Before
 * this, every /search URL declared `/search` as its canonical, so no city or
 * category could ever rank, and the business-page breadcrumb pointed Google at
 * a URL the site itself called non-canonical.
 *
 * One function builds the canonical path, and the search page, the sitemap and
 * the breadcrumb all use it, so the three can never disagree on spelling or
 * parameter order.
 */

/** `/search`, `/search?category=clinic`, `/search?city=Multan`, or both — category first. */
export function landingPath(category?: string | null, city?: string | null): string {
  const params = new URLSearchParams();
  if (category) params.set('category', category);
  if (city) params.set('city', city);
  const qs = params.toString();
  return qs ? `/search?${qs}` : '/search';
}

/** A facet value as the data layer spells it, or null if it is not one. */
export function knownFacet(options: FacetOption[], raw: string | undefined): FacetOption | null {
  if (!raw) return null;
  return options.find((o) => o.value.toLowerCase() === raw.toLowerCase()) ?? null;
}

export function landingTitle(categoryLabel: string | null, city: string | null): string {
  const what = categoryLabel ? `${categoryLabel}s` : 'Salons, clinics, gyms and studios';
  return city ? `${what} in ${city}` : what;
}
