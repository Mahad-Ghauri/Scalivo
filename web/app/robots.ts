import type { MetadataRoute } from 'next';

import { SITE_URL } from '@/lib/site';

export default function robots(): MetadataRoute.Robots {
  return {
    rules: {
      userAgent: '*',
      allow: '/',
      /**
       * Personal pages reached by an unguessable token: a customer's own
       * appointments (3.3) and a deposit payment. Belt and braces — both send
       * `noindex` themselves, and neither is linked from anywhere a crawler can
       * reach — but a token pasted into a public forum would otherwise be a page
       * a crawler is free to fetch and keep.
       *
       * Note what this does NOT do: robots.txt is a request, not access control.
       * The credential is the token's entropy, never this line.
       */
      disallow: [
        '/me/',
        '/pay/',
        /**
         * The owner's side of the product. None of it can rank — the dashboard
         * redirects a signed-out visitor, and sign-in pages are noindex — so
         * every fetch here is crawl budget spent on nothing. On a site whose
         * value is its profile pages being found, that matters.
         */
        '/dashboard/',
        '/login',
        '/register',
        /** Proxy routes to the backend. JSON, never a landing page. */
        '/api/',
      ],
    },
    sitemap: `${SITE_URL}/sitemap.xml`,
  };
}
