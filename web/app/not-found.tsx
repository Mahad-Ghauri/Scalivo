import { EmptyResults } from '@/components/EmptyResults';
import { SiteHeader } from '@/components/SiteHeader';

export default function NotFound() {
  return (
    <>
      <SiteHeader />
      <main className="mx-auto max-w-[1440px] px-5 pt-12 md:px-8 md:pt-20">
        <EmptyResults
          heading="Page not found"
          body="The link may be old, or the page may have moved. Everything that is listed is in the directory."
          actions={[
            { href: '/', label: 'Back to home' },
            { href: '/search', label: 'Search businesses' },
          ]}
        />
      </main>
    </>
  );
}
