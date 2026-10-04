import type { Metadata } from 'next';
import type { ReactNode } from 'react';

/**
 * Sign-in and sign-up are kept out of the index — milestone 4.3.
 *
 * They are not marketplace pages. Indexed, they compete with the pages that
 * should rank for the business's own name, and a search result that drops a
 * customer on a staff login is a dead end for them and a wasted crawl for us.
 *
 * It lives in the layout because both pages are client components, and
 * `export const metadata` is a server-only export. Putting it on the group
 * rather than on each route also means the next auth page added — a password
 * reset, an invite accept — inherits the rule instead of having to remember it.
 *
 * `follow: true` is deliberate: nothing here should rank, but the footer links
 * out to pages that should, and there is no reason to strand that link equity.
 */
export const metadata: Metadata = {
  title: 'Sign in',
  robots: { index: false, follow: true },
};

export default function AuthLayout({ children }: { children: ReactNode }) {
  return <>{children}</>;
}
