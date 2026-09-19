import type { Metadata } from 'next';
import Link from 'next/link';

import { BookingThread } from '@/components/BookingThread';
import { BusinessLedger } from '@/components/BusinessLedger';
import { EmptyResults } from '@/components/EmptyResults';
import { FilterBar } from '@/components/FilterBar';
import { ArrowEast } from '@/components/Icons';
import { Reveal } from '@/components/Reveal';
import { SearchField } from '@/components/SearchField';
import { categoryLabel, listBusinesses, listCategories, listCities } from '@/lib/marketplace';
import { firstParam, toFilters, type RawSearchParams } from '@/lib/search-params';

export const metadata: Metadata = {
  alternates: { canonical: '/' },
};

const OWNER_STEPS = [
  {
    number: '01',
    title: 'Connect the number you already give out',
    detail: 'One scan. Nothing changes for the people who message you — they just get answered faster.',
  },
  {
    number: '02',
    title: 'Write down services, hours and who does what',
    detail: 'That list becomes your public page, so prices are settled before anyone walks in.',
  },
  {
    number: '03',
    title: 'Answer the messages that need a person',
    detail: 'The ordinary ones — Saturday at four, the usual cut — confirm themselves.',
  },
];

export default async function DirectoryPage({ searchParams }: { searchParams: Promise<RawSearchParams> }) {
  const params = await searchParams;
  const category = firstParam(params.category);
  const city = firstParam(params.city);

  const [businesses, everything, categories, cities] = await Promise.all([
    listBusinesses(toFilters(category, city)),
    listBusinesses(),
    listCategories(),
    listCities(),
  ]);

  const filterSummary = [category ? categoryLabel(category) : null, city].filter(Boolean).join(' · ');

  return (
    <main>
      {/* Hero */}
      <section aria-labelledby="hero-heading" className="mx-auto max-w-[1200px] px-5 pb-16 pt-10 md:px-10 md:pb-24 md:pt-16">
        <div className="grid grid-cols-1 gap-x-10 gap-y-12 md:grid-cols-12">
          <div className="md:col-span-7">
            <p className="label flex items-center gap-2 text-clay-deep">
              <span className="inline-block h-px w-6 bg-clay" aria-hidden="true" />
              <span className="num">{everything.length}</span> businesses · Multan &amp; Lahore
            </p>

            <h1
              id="hero-heading"
              className="display-xl mt-5 font-display text-[clamp(2.6rem,8.4vw,5rem)] font-semibold leading-[0.96] tracking-[-0.025em]"
            >
              Every place worth booking, and what it actually costs.
            </h1>

            <p className="mt-6 max-w-[52ch] text-[1.0625rem] leading-relaxed text-ink/90 md:text-[1.125rem]">
              Salons, clinics, gyms and studios across Multan and Lahore that take bookings in a message. Read the
              prices, the hours and who does the work — then send one line.
            </p>

            <div className="mt-10 max-w-[580px]">
              <SearchField />
            </div>
          </div>

          <div className="md:col-span-5 md:pt-14">
            <BookingThread />
          </div>
        </div>
      </section>

      {/* Directory */}
      <section aria-labelledby="directory-heading" className="mx-auto max-w-[1200px] px-5 md:px-10">
        <div className="flex flex-wrap items-baseline justify-between gap-x-6 gap-y-2 border-t border-rule pt-7">
          <h2 id="directory-heading" className="display-md font-display text-[1.75rem] font-semibold md:text-[2.125rem]">
            The directory
          </h2>
          <p className="label text-muted">
            <span className="num">{businesses.length}</span> {businesses.length === 1 ? 'business' : 'businesses'}
            {filterSummary ? ` · ${filterSummary}` : ''}
          </p>
        </div>

        <div className="mt-6">
          <FilterBar
            basePath="/"
            categories={categories}
            cities={cities}
            activeCategory={category}
            activeCity={city}
          />
        </div>

        <div className="mt-10 md:mt-16">
          <BusinessLedger
            businesses={businesses}
            empty={
              <EmptyResults
                heading="Nothing in the directory matches that pair yet."
                body="We are onboarding businesses city by city, so some combinations are genuinely empty rather than hidden. Widening one of the two filters usually finds something close by."
                actions={[
                  { href: '/', label: 'Clear the filters' },
                  { href: '/?city=Multan', label: 'Everything in Multan' },
                ]}
              />
            }
          />
        </div>
      </section>

      {/* For owners */}
      <section
        id="for-owners"
        aria-labelledby="owners-heading"
        className="mx-auto mt-24 max-w-[1200px] px-5 md:mt-36 md:px-10"
      >
        <Reveal>
          <div className="grid grid-cols-1 gap-x-10 gap-y-8 border-t-2 border-ink pt-8 md:grid-cols-12 md:pt-12">
            <div className="md:col-span-5">
              <p className="label text-kashi">For owners</p>
              <h2
                id="owners-heading"
                className="display-md mt-4 font-display text-[2rem] font-semibold leading-[1.02] md:text-[2.75rem]"
              >
                Your customers already message you. Let the calendar answer.
              </h2>
            </div>

            <div className="md:col-span-6 md:col-start-7">
              <p className="max-w-[60ch] text-[1.0625rem] leading-relaxed text-ink/90">
                Scalivo sits on the number you already hand out. Someone asks for Saturday; it offers the slots you
                actually have, writes the booking into the day, and reminds them the night before. You keep the
                conversation. You stop keeping the diary.
              </p>

              <ol className="mt-8 border-t border-rule">
                {OWNER_STEPS.map((step) => (
                  <li key={step.number} className="grid grid-cols-[2.5rem_1fr] gap-4 border-b border-rule py-5">
                    <span className="num pt-0.5 text-[0.875rem] text-clay-deep">{step.number}</span>
                    <div>
                      <h3 className="display-sm font-display text-[1.125rem] font-semibold leading-snug">
                        {step.title}
                      </h3>
                      <p className="mt-1.5 text-[0.9375rem] leading-relaxed text-muted">{step.detail}</p>
                    </div>
                  </li>
                ))}
              </ol>

              <p className="mt-6 text-[0.9375rem] leading-relaxed text-muted">
                Setting a business up still takes a person at our end — about ninety minutes, once.
              </p>

              <Link
                href="mailto:hello@scalivo.app?subject=Listing%20my%20business"
                className="label-lg rule-draw mt-3 inline-flex items-center gap-2 text-signal-deep"
              >
                Start that conversation
                <ArrowEast />
              </Link>
            </div>
          </div>
        </Reveal>
      </section>
    </main>
  );
}
