import { SITE_URL } from '@/lib/site';

/**
 * The two site-wide structured-data blocks — milestone 4.3.
 *
 * `LocalBusinessJsonLd` describes one business. These two describe the site
 * itself and where a page sits in it, which is a different job: they decide how
 * a result is PRESENTED rather than what it says.
 *
 * Both serialise the same way as the profile block — `<` escaped so a business
 * name can never close the script tag early.
 */
function script(data: unknown) {
  return (
    <script
      type="application/ld+json"
      dangerouslySetInnerHTML={{ __html: JSON.stringify(data).replace(/</g, '\\u003c') }}
    />
  );
}

/**
 * The trail under a search result: Scalivo › Multan › Skinare Aesthetics.
 *
 * Without it a result shows the raw URL, which on a profile page is the slug —
 * and a slug is the one part of the page written for a machine. The crumbs have
 * to match what a visitor can actually see and click, so the city crumb points
 * at the filtered search that genuinely lists that city.
 */
export function BreadcrumbJsonLd({ trail }: { trail: { name: string; path: string }[] }) {
  return script({
    '@context': 'https://schema.org',
    '@type': 'BreadcrumbList',
    itemListElement: trail.map((crumb, index) => ({
      '@type': 'ListItem',
      position: index + 1,
      name: crumb.name,
      item: `${SITE_URL}${crumb.path}`,
    })),
  });
}

/**
 * The site itself, with its search endpoint.
 *
 * This is what offers a search box directly inside the Google result for
 * "scalivo" — a brand query lands on a box that searches the marketplace rather
 * than on a page the person then has to navigate. Declared once, on the home
 * page, because it describes the site and not the page.
 *
 * `query-input` names the parameter our own /search route reads. If that
 * parameter is ever renamed, this becomes a lie that points at an empty result.
 */
export function WebSiteJsonLd() {
  return script({
    '@context': 'https://schema.org',
    '@type': 'WebSite',
    name: 'Scalivo',
    url: SITE_URL,
    potentialAction: {
      '@type': 'SearchAction',
      target: {
        '@type': 'EntryPoint',
        urlTemplate: `${SITE_URL}/search?q={search_term_string}`,
      },
      'query-input': 'required name=search_term_string',
    },
  });
}
