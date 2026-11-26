import type { MetadataRoute } from 'next';

import { SITE_URL } from '@/lib/site';

export default function robots(): MetadataRoute.Robots {
  return {
    rules: {
      userAgent: '*',
      allow: '/',
      /**
       * The personal token pages, `/me/` (3.3) and `/pay/`, are deliberately NOT
       * disallowed. They are kept out of search by `noindex`, in the page and as
       * an X-Robots-Tag header (next.config.mjs). A crawler blocked here never
       * fetches the page, so never sees that `noindex` — and Google then indexes
       * the bare URL, token and all, if someone posts the link publicly.
       *
       * Either way robots.txt is a request, not access control: the credential
       * is the token's entropy.
       */
      disallow: [
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
