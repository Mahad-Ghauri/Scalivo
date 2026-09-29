'use client';

import { usePathname } from 'next/navigation';
import type { ReactNode } from 'react';

/**
 * The site's marketing chrome — everywhere except a customer's own page.
 *
 * The footer lives in the root layout, and a nested layout cannot remove what a
 * parent renders, so the decision has to be taken at render time. A client
 * component is the cheapest way to do that without moving every existing route
 * into a group.
 *
 * Two reasons /me is the exception, and the second is the load-bearing one:
 *
 * 1. It is a private page, not a shopfront. Somebody checking what time their
 *    appointment is has not asked to be sold "List your business".
 * 2. **The installed app has a scope.** The manifest confines the standalone
 *    window to `/me/`, and every link in that footer leaves it — so from a home
 *    screen icon they each dump the customer into an in-app browser. The one
 *    outbound link the page keeps is to their own business, where leaving is
 *    exactly what they meant to do.
 */
export function SiteChrome({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  if (pathname?.startsWith('/me/')) return null;
  return <>{children}</>;
}
