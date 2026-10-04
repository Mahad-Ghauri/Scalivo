import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { getCurrentUser } from '@/lib/auth/user';

/**
 * The dashboard never belongs in a search index — milestone 4.3.
 *
 * A crawler reaching any of these is redirected to /login, so nothing private
 * leaks either way. But a redirect still spends crawl budget on a tree that can
 * never rank, and a URL that 307s today could serve something cacheable after a
 * refactor. `noindex` states the intent once, at the root of the group, rather
 * than relying on the redirect to keep being the only protection.
 *
 * robots.ts disallows the same prefix. Both are needed: robots.txt stops the
 * fetch, this stops indexing for any crawler that fetched anyway — a URL can be
 * indexed from an inbound link without ever being crawled.
 */
export const metadata: Metadata = {
  title: 'Dashboard',
  robots: { index: false, follow: false },
};

export default async function DashboardRootLayout({ children }: { children: React.ReactNode }) {
  const session = await getCurrentUser();

  // Route group root layout guarantees all /dashboard routes are authenticated
  if (!session) {
    redirect('/login');
  }

  return <>{children}</>;
}
