import type { Metadata } from 'next';

import { BusinessLedger } from '@/components/BusinessLedger';
import { EmptyResults } from '@/components/EmptyResults';
import { FilterBar } from '@/components/FilterBar';
import { SearchField } from '@/components/SearchField';
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

  const filterSummary = [category ? categoryLabel(category) : null, city].filter(Boolean).join(' · ');

  return (
    <main className="mx-auto max-w-[1200px] px-5 pb-16 pt-10 md:px-10 md:pt-14">
      <div className="max-w-[720px]">
        <SearchField defaultValue={query} category={category} city={city} tone="compact" />
      </div>

      <div className="mt-12 flex flex-wrap items-baseline justify-between gap-x-6 gap-y-2 border-t border-rule pt-7">
        <h1 className="label-lg text-ink">
          <span className="num text-clay-deep">{results.length}</span> {results.length === 1 ? 'result' : 'results'}
          {query ? (
            <>
              {' for '}
              <span className="text-kashi">&ldquo;{query}&rdquo;</span>
            </>
          ) : (
            ' · everything listed'
          )}
        </h1>
        {filterSummary ? <p className="label text-muted">Filtered to {filterSummary}</p> : null}
      </div>

      <div className="mt-6">
        <FilterBar
          basePath="/search"
          categories={categories}
          cities={cities}
          activeCategory={category}
          activeCity={city}
          query={query || undefined}
        />
      </div>

      <div className="mt-10 md:mt-16">
        <BusinessLedger
          businesses={results}
          empty={
            <EmptyResults
              heading="Nothing matched that."
              body={
                query
                  ? `No listed business mentions "${query}" in its name, services or staff. Search matches service names too, so a plainer word — facial, fade, laser — usually lands.`
                  : 'Those filters have nothing behind them yet. We are onboarding city by city, so some combinations are genuinely empty rather than hidden.'
              }
              actions={[
                { href: '/search', label: 'Clear everything' },
                { href: '/', label: 'Browse the directory' },
              ]}
            />
          }
        />
      </div>
    </main>
  );
}
