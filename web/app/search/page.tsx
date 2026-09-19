import type { Metadata } from 'next';

import { EmptyResults } from '@/components/EmptyResults';
import { FilterPills } from '@/components/FilterPills';
import { SearchBar } from '@/components/SearchBar';
import { SiteHeader } from '@/components/SiteHeader';
import { VenueGrid } from '@/components/VenueCard';
import { categoryLabel, listCategories, listCities, searchBusinesses } from '@/lib/marketplace';
import { firstParam, toFilters, type RawSearchParams } from '@/lib/search-params';

export const metadata: Metadata = {
  title: 'Search',
  description: 'Search salons, clinics, gyms and studios taking bookings across Multan and Lahore.',
  alternates: { canonical: '/search' },
};

export default async function SearchPage({ searchParams }: { searchParams: Promise<RawSearchParams> }) {
  const params = await searchParams;
  const query = firstParam(params.q) ?? '';
  const category = firstParam(params.category);
  const city = firstParam(params.city);

  const [results, categories, cities] = await Promise.all([
    searchBusinesses(query, toFilters(category, city)),
    listCategories(),
    listCities(),
  ]);

  const scope = [category ? `${categoryLabel(category)}s` : null, city ? `in ${city}` : null].filter(Boolean).join(' ');

  return (
    <>
      <SiteHeader
        search={
          <SearchBar
            variant="compact"
            categories={categories}
            cities={cities}
            query={query}
            category={category}
            city={city}
          />
        }
      />
      <main className="mx-auto max-w-[1440px] px-5 pt-8 md:px-8 md:pt-10">
        <h1 className="text-[28px] font-bold tracking-[-0.02em] md:text-[36px]">
          {query ? <>Results for &ldquo;{query}&rdquo;</> : scope ? scope.charAt(0).toUpperCase() + scope.slice(1) : 'All businesses'}
        </h1>
        <p className="mt-1 text-[16px] text-muted">
          {results.length} {results.length === 1 ? 'business' : 'businesses'}
          {query && scope ? ` · ${scope}` : ''}
        </p>

        <div className="mt-6">
          <FilterPills
            basePath="/search"
            categories={categories}
            cities={cities}
            activeCategory={category}
            activeCity={city}
            query={query || undefined}
          />
        </div>

        <div className="mt-8">
          {results.length > 0 ? (
            <VenueGrid businesses={results} />
          ) : (
            <EmptyResults
              heading="No results found"
              body={
                query
                  ? `Nothing listed matches "${query}". Search looks at service names too, so a plainer word like facial, fade or laser usually works.`
                  : 'Nothing matches those filters yet. We are adding businesses city by city.'
              }
              actions={[
                { href: '/search', label: 'Clear search' },
                { href: '/', label: 'Back to home' },
              ]}
            />
          )}
        </div>
      </main>
    </>
  );
}
