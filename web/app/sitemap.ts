import type { MetadataRoute } from 'next';

import { listBusinessSlugs } from '@/lib/marketplace';
import { SITE_URL } from '@/lib/site';

/** Published businesses only — listBusinessSlugs() applies the same gate as every page. */
export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  const slugs = await listBusinessSlugs();

  return [
    { url: SITE_URL, changeFrequency: 'daily', priority: 1 },
    { url: `${SITE_URL}/search`, changeFrequency: 'weekly', priority: 0.5 },
    ...slugs.map((slug) => ({
      url: `${SITE_URL}/${slug}`,
      changeFrequency: 'weekly' as const,
      priority: 0.8,
    })),
  ];
}
