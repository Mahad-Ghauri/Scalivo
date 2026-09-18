import { EmptyResults } from '@/components/EmptyResults';
import { SiteHeader } from '@/components/SiteHeader';

/**
 * Also what an unpublished business shows. Deliberately the same page as a
 * slug that never existed — a "not ready yet" message would confirm to anyone
 * guessing URLs that the name is registered.
 */
export default function BusinessNotFound() {
  return (
    <>
      <SiteHeader />
      <main className="mx-auto max-w-[1440px] px-5 pt-12 md:px-8 md:pt-20">
        <EmptyResults
          heading="We can't find that business"
          body="It may not be listed yet, or the link may have a typo. Searching by the service you want usually finds somewhere close."
          actions={[
            { href: '/search', label: 'Search businesses' },
            { href: '/', label: 'Back to home' },
          ]}
        />
      </main>
    </>
  );
}
