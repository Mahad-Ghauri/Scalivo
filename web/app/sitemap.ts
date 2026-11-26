import type { MetadataRoute } from 'next';

import { listBusinessSlugs, listBusinesses } from '@/lib/marketplace';
import { landingPath } from '@/lib/landing';
import { SITE_URL } from '@/lib/site';

/**
 * Published businesses only — listBusinessSlugs() applies the same gate as every page.
 *
 * `lastModified` on the profile rows is the real thing (4.3): the newest write
 * across the business, its services, its staff and its published reviews. See
 * listSlugs() in the backend for why it is computed rather than read off one
 * field. The home and search rows deliberately carry no date — they change when
 * any business does, and a date that is "now" on every fetch is noise.
 */
export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  const [businesses, cards] = await Promise.all([listBusinessSlugs(), listBusinesses()]);

  // Every category, city, and category-in-city that has at least one business —
  // the same set the search page marks indexable.
  const landings = new Set<string>();
  for (const card of cards) {
    landings.add(landingPath(card.category, null));
    if (card.city) {
      landings.add(landingPath(null, card.city));
      landings.add(landingPath(card.category, card.city));
    }
  }

  return [
    { url: SITE_URL, changeFrequency: 'daily', priority: 1 },
    { url: `${SITE_URL}/search`, changeFrequency: 'weekly', priority: 0.5 },
    ...[...landings].sort().map((path) => ({
      url: `${SITE_URL}${path}`,
      changeFrequency: 'weekly' as const,
      priority: 0.6,
    })),
    ...businesses.map((business) => ({
      url: `${SITE_URL}/${business.slug}`,
      lastModified: new Date(business.updatedAt),
      changeFrequency: 'weekly' as const,
      priority: 0.8,
    })),
  ];
}
