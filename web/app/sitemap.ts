import type { MetadataRoute } from 'next';

import { listBusinessSlugs } from '@/lib/marketplace';
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
  const businesses = await listBusinessSlugs();

  return [
    { url: SITE_URL, changeFrequency: 'daily', priority: 1 },
    { url: `${SITE_URL}/search`, changeFrequency: 'weekly', priority: 0.5 },
    ...businesses.map((business) => ({
      url: `${SITE_URL}/${business.slug}`,
      lastModified: new Date(business.updatedAt),
      changeFrequency: 'weekly' as const,
      priority: 0.8,
    })),
  ];
}
