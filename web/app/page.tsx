import type { Metadata } from 'next';
import Link from 'next/link';

import { Carousel, Slide } from '@/components/Carousel';
import { EmptyResults } from '@/components/EmptyResults';
import { FilterPills, Pill } from '@/components/FilterPills';
import { ArrowRight, ChatIcon, CheckIcon } from '@/components/Icons';
import { WebSiteJsonLd } from '@/components/JsonLd';
import { SearchBar } from '@/components/SearchBar';
import { SiteHeader } from '@/components/SiteHeader';
import { TestimonialGlobe } from '@/components/ui/testimonial-globe';
import { VenueCard, VenueGrid } from '@/components/VenueCard';
import {
  categoryLabel,
  listBusinesses,
  listCategories,
  listCities,
  listFeaturedReviews,
  type BusinessCard,
} from '@/lib/marketplace';
import { toGlobeTestimonials } from '@/lib/review-globe';
import { firstParam, toFilters, type RawSearchParams } from '@/lib/search-params';

export const metadata: Metadata = {
  alternates: { canonical: '/' },
};

const container = 'mx-auto max-w-[1440px] px-5 md:px-8';

export default async function HomePage({ searchParams }: { searchParams: Promise<RawSearchParams> }) {
  const params = await searchParams;
  const category = firstParam(params.category);
  const city = firstParam(params.city);
  const filtered = Boolean(category || city);

  const [everything, results, categories, cities, reviews] = await Promise.all([
    listBusinesses(),
    filtered ? listBusinesses(toFilters(category, city)) : Promise.resolve([]),
    listCategories(),
    listCities(),
    listFeaturedReviews(8),
  ]);

  // Every figure on this page is counted from the directory itself. No
  // marketing numbers: a stat the data cannot back up is a claim, not a stat.
  const totalReviews = everything.reduce((sum, business) => sum + business.reviewCount, 0);
  const byReviews = [...everything].sort((a, b) => b.reviewCount - a.reviewCount);
  const browseCity = city ?? cities[0]?.value;
  const inBrowseCity = everything.filter((business) => business.city === browseCity);

  // The globe pins a sample of reviews, but its header counts all of them.
  const globeReviews = toGlobeTestimonials(reviews, everything);
  const rated = everything.filter((business) => business.rating !== null && business.reviewCount > 0);
  const ratedCount = rated.reduce((sum, business) => sum + business.reviewCount, 0);
  const averageRating =
    ratedCount > 0
      ? rated.reduce((sum, business) => sum + (business.rating ?? 0) * business.reviewCount, 0) / ratedCount
      : null;
  const reviewedCities = new Set(rated.map((business) => business.city).filter(Boolean)).size;

  return (
    <main>
      <WebSiteJsonLd />
      {/* Hero */}
      <div className="hero-wash">
        <SiteHeader transparent />
        <section aria-labelledby="hero-heading" className={`${container} pb-20 pt-16 text-center md:pb-28 md:pt-28`}>
          <h1
            id="hero-heading"
            className="mx-auto max-w-[16ch] text-[40px] font-bold leading-[1.05] tracking-[-0.035em] md:max-w-none md:text-[64px]"
          >
            Book local selfcare services
          </h1>
          <p className="mx-auto mt-3 max-w-[60ch] text-[17px] md:text-[22px]">
            Discover top-rated salons, clinics, gyms and studios across Multan and Lahore
          </p>

          <div className="mx-auto mt-10 max-w-[1140px] text-left md:mt-16">
            <SearchBar variant="hero" categories={categories} cities={cities} />
          </div>

          <p className="mt-10 text-[18px] md:text-[20px]">
            <strong className="font-bold">{totalReviews.toLocaleString('en-US')}</strong> reviews from real customers
          </p>

          <Link
            href="#how-it-works"
            className="mt-6 inline-flex h-12 items-center gap-2 rounded-full border border-line bg-white px-5 text-[16px] font-semibold hover:bg-surface"
          >
            Book on WhatsApp
            <ChatIcon />
          </Link>
        </section>
      </div>

      {/* Filtered results — only when a filter link was followed. */}
      {filtered ? (
        <section id="results" aria-labelledby="results-heading" className={`${container} scroll-mt-4 pt-4`}>
          <h2 id="results-heading" className="text-[28px] font-semibold tracking-[-0.02em]">
            {[category ? `${categoryLabel(category)}s` : 'Businesses', city ? `in ${city}` : null]
              .filter(Boolean)
              .join(' ')}
          </h2>
          <div className="mt-5">
            <FilterPills
              basePath="/"
              categories={categories}
              cities={cities}
              activeCategory={category}
              activeCity={city}
            />
          </div>
          <div className="mt-8">
            {results.length > 0 ? (
              <VenueGrid businesses={results} />
            ) : (
              <EmptyResults
                heading="No businesses found"
                body="Nothing matches that combination yet. We're adding businesses city by city. Try widening the search."
                actions={[
                  { href: '/', label: 'Clear filters' },
                  { href: '/search', label: 'See all businesses' },
                ]}
              />
            )}
          </div>
        </section>
      ) : null}

      <VenueRow title="Recommended" businesses={everything} />
      <VenueRow title="Trending" businesses={byReviews} />
      {browseCity ? <VenueRow title={`Popular in ${browseCity}`} businesses={inBrowseCity} /> : null}

      {/* How it works — the product's one difference, told the way the app section is on the reference. */}
      <section id="how-it-works" aria-labelledby="how-heading" className={`${container} scroll-mt-4 pt-24 md:pt-32`}>
        <div className="grid items-center gap-12 md:grid-cols-2 md:gap-16 md:px-12">
          <div>
            <p className="text-[14px] font-semibold">Works on WhatsApp</p>
            <h2 id="how-heading" className="mt-3 text-[40px] font-bold leading-[1.05] tracking-[-0.035em] md:text-[56px]">
              Book in the chat you already use
            </h2>
            <p className="mt-5 max-w-[40ch] text-[17px] md:text-[18px]">
              No app to install and no account to create. Message the business, pick a time, and your booking is
              confirmed right in the thread.
            </p>
            <ul className="mt-8 space-y-3">
              {['Live slots: only times that are actually free', 'Confirmation in seconds', 'A reminder the day before'].map(
                (line) => (
                  <li key={line} className="flex items-center gap-3 text-[16px]">
                    <span className="flex h-7 w-7 items-center justify-center rounded-full bg-[#eeebff] text-brand">
                      <CheckIcon className="h-4 w-4" />
                    </span>
                    {line}
                  </li>
                ),
              )}
            </ul>
          </div>

          {/* A phone-shaped frame around a real conversation, instead of an app screenshot. */}
          <div className="mx-auto w-full max-w-[340px] rounded-[40px] border border-line bg-white p-3 shadow-[0_30px_60px_-30px_rgba(0,0,0,0.25)]">
            <div className="rounded-[30px] bg-[#f7f5f2] px-4 pb-6 pt-5">
              <div className="flex items-center gap-3 border-b border-line pb-4">
                <span className="flex h-10 w-10 items-center justify-center rounded-full bg-ink text-[14px] font-bold text-white">
                  SA
                </span>
                <span>
                  <span className="block text-[15px] font-semibold">Skinare Aesthetics</span>
                  <span className="block text-[12px] text-open">online</span>
                </span>
              </div>
              <div className="mt-4 space-y-2.5 text-[14px]">
                <Bubble side="out">Hydrafacial on Saturday?</Bubble>
                <Bubble side="in">Saturday 4:00 PM with Dr. Ayesha is free. Reply 1 to confirm.</Bubble>
                <Bubble side="out">1</Bubble>
                <Bubble side="in">
                  <span className="inline-flex items-center gap-1.5 font-semibold text-open">
                    <CheckIcon className="h-4 w-4" /> Booked
                  </span>{' '}
                  See you Saturday at 4.
                </Bubble>
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* Reviews */}
      {globeReviews.length > 0 ? (
        <div className="pt-16 md:pt-24">
          <TestimonialGlobe
            items={globeReviews}
            totals={{ reviews: totalReviews, average: averageRating, cities: reviewedCities }}
            eyebrow="Reviews"
            heading="Rated by real customers, after every visit"
            caption="Each review comes from someone who booked and showed up. Scalivo asks them on WhatsApp once the appointment is done."
            autoplay
            interval={4500}
            action={
              // Keyed: React 18 dev flags a server-made element rendered as a client child otherwise.
              <Link key="find" href="/search" className="text-sm font-semibold text-brand hover:underline">
                Find a place
              </Link>
            }
          />
        </div>
      ) : null}

      {/* Stats */}
      <section aria-labelledby="stats-heading" className={`${container} pt-24 text-center md:pt-32`}>
        <h2 id="stats-heading" className="text-[28px] font-semibold tracking-[-0.02em] md:text-[36px]">
          The easiest way to book in Multan &amp; Lahore
        </h2>
        <p className="mt-2 text-[17px] md:text-[20px]">Real prices, real hours, real reviews, before you go.</p>
        <p className="gradient-number mt-10 text-[64px] font-bold leading-none tracking-[-0.04em] md:text-[104px]">
          {totalReviews.toLocaleString('en-US')}+
        </p>
        <p className="mt-3 text-[17px] md:text-[20px]">customer reviews on Scalivo</p>
        <dl className="mx-auto mt-14 grid max-w-[900px] grid-cols-1 gap-10 sm:grid-cols-3">
          <Stat value={everything.length} label="businesses listed" />
          <Stat value={categories.length} label="kinds of service" />
          <Stat value={cities.length} label={cities.length === 1 ? 'city' : 'cities'} />
        </dl>
      </section>

      {/* For business */}
      <section id="for-business" aria-labelledby="business-heading" className="mt-24 overflow-hidden md:mt-32">
        <div className={`${container} grid items-center gap-12 md:grid-cols-2`}>
          <div>
            <h2 id="business-heading" className="text-[40px] font-bold leading-[1.05] tracking-[-0.035em] md:text-[56px]">
              Scalivo for business
            </h2>
            <p className="mt-5 max-w-[42ch] text-[17px] md:text-[20px]">
              Take bookings on the WhatsApp number your customers already have. Scalivo offers the slots you really
              have, fills your calendar, and sends reminders for you.
            </p>
            <a
              href="mailto:hello@scalivo.app?subject=Listing%20my%20business"
              className="mt-8 inline-flex h-12 items-center gap-2 rounded-full bg-ink px-6 text-[16px] font-semibold text-white hover:bg-black/80"
            >
              Find out more
              <ArrowRight />
            </a>
          </div>

          <div className="lime-wash relative py-10 md:py-16">
            {everything[0]?.coverUrl ? (
              <img
                src={everything[0].coverUrl}
                alt=""
                loading="lazy"
                className="aspect-[4/3] w-full rounded-2xl object-cover shadow-[0_30px_60px_-30px_rgba(0,0,0,0.35)]"
              />
            ) : null}
          </div>
        </div>
      </section>

      {/* Browse by city */}
      <section id="browse" aria-labelledby="browse-heading" className={`${container} scroll-mt-4 pt-24 md:pt-32`}>
        <h2 id="browse-heading" className="text-[28px] font-semibold tracking-[-0.02em]">
          Browse by city
        </h2>
        <nav aria-label="Cities" className="no-scrollbar -mx-5 mt-6 overflow-x-auto px-5 md:mx-0 md:px-0">
          <ul className="flex w-max gap-2">
            {cities.map((option) => (
              <Pill key={option.value} href={`/?city=${encodeURIComponent(option.value)}#browse`} active={option.value === browseCity}>
                {option.label}
              </Pill>
            ))}
          </ul>
        </nav>

        <div className="mt-8 grid grid-cols-2 gap-x-6 gap-y-8 sm:grid-cols-3 lg:grid-cols-5">
          {categories.map((option) => {
            const inCategory = inBrowseCity.filter((business) => business.category === option.value);
            return (
              <div key={option.value}>
                <h3 className="text-[16px] font-semibold">
                  {categoryLabel(option.value)}s in {browseCity}
                </h3>
                <ul className="mt-3 space-y-2">
                  {inCategory.length > 0 ? (
                    inCategory.map((business) => (
                      <li key={business.id}>
                        <Link href={`/${business.slug}`} className="text-[15px] text-muted hover:text-ink hover:underline">
                          {business.name}
                        </Link>
                      </li>
                    ))
                  ) : (
                    <li className="text-[15px] text-muted">None listed yet</li>
                  )}
                </ul>
              </div>
            );
          })}
        </div>

        <ul className="mt-12 flex flex-wrap gap-2">
          {categories.map((option) => (
            <Pill key={option.value} href={`/?category=${option.value}#results`} active={false}>
              {categoryLabel(option.value)}s
            </Pill>
          ))}
        </ul>
      </section>
    </main>
  );
}

function VenueRow({ title, businesses }: { title: string; businesses: BusinessCard[] }) {
  if (businesses.length === 0) return null;
  const id = title.toLowerCase().replace(/[^a-z]+/g, '-');

  return (
    <section aria-labelledby={id} className={`${container} pt-12 md:pt-16`}>
      <h2 id={id} className="text-[28px] font-semibold tracking-[-0.02em]">
        {title}
      </h2>
      <div className="mt-6">
        <Carousel label={title}>
          {businesses.map((business) => (
            <Slide key={business.id}>
              <VenueCard business={business} />
            </Slide>
          ))}
        </Carousel>
      </div>
    </section>
  );
}

function Stat({ value, label }: { value: number; label: string }) {
  return (
    <div>
      <dt className="sr-only">{label}</dt>
      <dd>
        <span className="block text-[36px] font-semibold tracking-[-0.02em]">{value}</span>
        <span className="text-[18px]">{label}</span>
      </dd>
    </div>
  );
}

function Bubble({ side, children }: { side: 'in' | 'out'; children: React.ReactNode }) {
  return (
    <p
      className={`w-fit max-w-[85%] rounded-2xl px-3.5 py-2 leading-snug ${
        side === 'out' ? 'ml-auto rounded-br-md bg-[#dcf8c6]' : 'rounded-bl-md bg-white'
      }`}
    >
      {children}
    </p>
  );
}
