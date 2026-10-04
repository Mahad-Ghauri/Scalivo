import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import type { ReactNode } from 'react';

import { BookingFlow } from '@/components/BookingFlow';
import { Carousel, Slide } from '@/components/Carousel';
import { CheckIcon, ChatIcon, PinIcon, Star, Stars } from '@/components/Icons';
import { FunnelBeacon } from '@/components/FunnelBeacon';
import { BreadcrumbJsonLd } from '@/components/JsonLd';
import { LocalBusinessJsonLd } from '@/components/LocalBusinessJsonLd';
import { ClockLine, OpeningHours, OpenStatus } from '@/components/OpeningHours';
import { HideWhileBooking } from '@/components/HideWhileBooking';
import { Initials } from '@/components/ReviewCard';
import { SearchBar } from '@/components/SearchBar';
import { SiteHeader } from '@/components/SiteHeader';
import { VenueCard } from '@/components/VenueCard';
import {
  categoryLabel,
  formatDuration,
  formatPrice,
  getBusinessBySlug,
  listBusinessSlugs,
  listBusinesses,
  listCategories,
  listCities,
  LIVE_BOOKING,
} from '@/lib/marketplace';

type Params = Promise<{ business: string }>;

export async function generateStaticParams() {
  return (await listBusinessSlugs()).map(({ slug }) => ({ business: slug }));
}

export async function generateMetadata({ params }: { params: Params }): Promise<Metadata> {
  const business = await getBusinessBySlug((await params).business);
  if (!business) return { title: 'Not found' };

  const place = [business.neighbourhood, business.city].filter(Boolean).join(', ');
  const title = `${business.name} — ${categoryLabel(business.category)}${place ? ` in ${place}` : ''}`;
  const description = `${business.tagline} Prices, hours and staff for ${business.name}. ${LIVE_BOOKING ? 'Book online or' : 'Book'} over WhatsApp.`;
  const url = `/${business.slug}`;

  return {
    title,
    description,
    alternates: { canonical: url },
    openGraph: {
      type: 'website',
      siteName: 'Scalivo',
      url,
      title,
      description,
      ...(business.coverUrl ? { images: [{ url: business.coverUrl, alt: `${business.name}` }] } : {}),
    },
    twitter: { card: 'summary_large_image', title, description },
  };
}

const bookNow =
  'inline-flex h-12 items-center justify-center rounded-full bg-ink px-6 text-[16px] font-semibold text-white transition-colors hover:bg-black/80';

export default async function BusinessPage({ params }: { params: Params }) {
  const business = await getBusinessBySlug((await params).business);
  if (!business) notFound();

  const [categories, cities, nearbyAll] = await Promise.all([
    listCategories(),
    listCities(),
    business.city ? listBusinesses({ city: business.city }) : Promise.resolve([]),
  ]);
  const nearby = nearbyAll.filter((other) => other.slug !== business.slug);

  const services = [...business.services].sort((a, b) => a.displayOrder - b.displayOrder);
  const fromPriceMinor = services.length > 0 ? Math.min(...services.map((service) => service.priceMinor)) : null;
  const place = [business.neighbourhood, business.city].filter(Boolean).join(', ');
  const directions = business.addressLine
    ? `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(`${business.addressLine}, Pakistan`)}`
    : null;
  const photos = [business.coverUrl, ...business.gallery.map((image) => image.url)].filter(
    (url): url is string => Boolean(url),
  );
  const photoAlt = (url: string) =>
    business.gallery.find((image) => image.url === url)?.alt ?? `${business.name}`;

  // Facts the data can back, in place of the reference page's amenity list.
  const facts = [
    'Instant confirmation over WhatsApp',
    'No account needed to book',
    services.some((service) => service.depositRequired) ? 'Deposit held for some services' : null,
    services.some((service) => service.priceMinor === 0) ? 'Free first session available' : null,
  ].filter((fact): fact is string => Boolean(fact));

  return (
    <>
      <SiteHeader search={<SearchBar variant="compact" categories={categories} cities={cities} />} />

      {/* Clears the pinned mobile bar so it never covers the footer. */}
      <main className="mx-auto max-w-[1440px] px-5 pb-28 md:px-8 md:pb-0">
        <LocalBusinessJsonLd business={business} />
        <BreadcrumbJsonLd
          trail={[
            { name: 'Scalivo', path: '/' },
            // The city crumb only appears when there is a real filtered page
            // behind it. A crumb that leads nowhere is worse than a shorter trail.
            ...(business.city
              ? [{ name: business.city, path: `/search?city=${encodeURIComponent(business.city)}` }]
              : []),
            { name: business.name, path: `/${business.slug}` },
          ]}
        />
        {/* Only against the real API — fixture slugs exist nowhere to count against. */}
        {LIVE_BOOKING ? <FunnelBeacon slug={business.slug} /> : null}

        {/* Title block */}
        <div className="pt-6 md:pt-8">
          <h1 className="text-[32px] font-bold leading-tight tracking-[-0.03em] md:text-[40px]">{business.name}</h1>
          <p className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1 text-[15px]">
            {business.rating !== null ? (
              <a href="#reviews" className="inline-flex items-center gap-1.5">
                <span className="font-semibold">{business.rating.toFixed(1)}</span>
                <Stars rating={business.rating} />
                <span className="text-brand">({business.reviewCount.toLocaleString('en-US')})</span>
              </a>
            ) : (
              <span className="text-muted">No reviews yet</span>
            )}
            <Dot />
            <OpenStatus hours={business.hours} timezone={business.timezone} />
            {place ? (
              <>
                <Dot />
                <span className="text-muted">{place}</span>
              </>
            ) : null}
            {directions ? (
              <a href={directions} target="_blank" rel="noopener noreferrer" className="font-semibold text-brand hover:underline">
                Get directions
              </a>
            ) : null}
          </p>
        </div>

        {/* Photo grid: one large, two stacked */}
        {photos.length > 0 ? (
          <div className="mt-6 grid gap-2 md:grid-cols-3 md:grid-rows-2">
            {/* The LCP on this page, and the only image above the fold on a
                phone. Marked high so the browser fetches it ahead of the
                stylesheet-discovered images below — it loads eagerly either way,
                but priority is what decides the order under a slow connection,
                which is the connection this page is written for. */}
            <img
              src={photos[0]}
              alt={photoAlt(photos[0]!)}
              fetchPriority="high"
              className="aspect-[4/3] h-full w-full rounded-lg object-cover md:col-span-2 md:row-span-2 md:aspect-auto md:max-h-[480px]"
            />
            {photos.slice(1, 3).map((url, index) => (
              <div key={url} className="relative hidden md:block">
                <img src={url} alt={photoAlt(url)} loading="lazy" className="h-full max-h-[236px] w-full rounded-lg object-cover" />
                {index === 1 && photos.length > 3 ? (
                  <a
                    href="#portfolio"
                    className="absolute bottom-3 right-3 rounded-full bg-white px-4 py-2 text-[14px] font-semibold shadow-sm hover:bg-surface"
                  >
                    See all images
                  </a>
                ) : null}
              </div>
            ))}
          </div>
        ) : null}

        <div className="mt-10 grid gap-x-16 md:grid-cols-[1fr_380px]">
          <div className="min-w-0">
            {/* Services */}
            <Section id="services" title="Services">
              <ul className="space-y-3">
                {services.map((service) => (
                  <li
                    key={service.id}
                    className="flex items-center justify-between gap-4 rounded-lg border border-line px-5 py-4 transition-colors hover:bg-surface/60"
                  >
                    <div className="min-w-0">
                      <h3 className="text-[16px] font-semibold">{service.name}</h3>
                      <p className="text-[14px] text-muted">{formatDuration(service.durationMinutes)}</p>
                      {service.description ? <p className="mt-1 text-[14px] text-muted">{service.description}</p> : null}
                      <p className="mt-2 text-[15px] font-semibold">
                        {service.priceMinor === 0 ? 'Free' : formatPrice(service.priceMinor)}
                        {service.depositRequired && service.depositAmountMinor !== null ? (
                          <span className="ml-2 text-[14px] font-medium text-open">
                            {formatPrice(service.depositAmountMinor)} deposit
                          </span>
                        ) : null}
                      </p>
                    </div>
                    <a
                      href={LIVE_BOOKING ? `#book=${service.id}` : '#book'}
                      className="shrink-0 rounded-full border border-line px-4 py-1.5 text-[14px] font-semibold hover:bg-surface"
                    >
                      Book<span className="sr-only"> {service.name}</span>
                    </a>
                  </li>
                ))}
              </ul>
            </Section>

            {/* Team */}
            {business.staff.length > 0 ? (
              <Section id="team" title="Team">
                <ul className="grid grid-cols-2 gap-6 sm:grid-cols-4">
                  {business.staff.map((member) => (
                    <li key={member.id} className="text-center">
                      {member.avatarUrl ? (
                        <img
                          src={member.avatarUrl}
                          alt=""
                          loading="lazy"
                          className="mx-auto h-24 w-24 rounded-full object-cover"
                        />
                      ) : (
                        <Initials name={member.name} className="mx-auto h-24 w-24 text-[26px]" />
                      )}
                      <p className="mt-3 text-[15px] font-semibold">{member.name}</p>
                      {member.role ? <p className="text-[13px] text-muted">{member.role}</p> : null}
                    </li>
                  ))}
                </ul>
              </Section>
            ) : null}

            {/* Reviews */}
            <Section
              id="reviews"
              title="Reviews"
              count={business.reviewCount > 0 ? business.reviewCount.toLocaleString('en-US') : undefined}
            >
              {business.rating !== null ? (
                <p className="flex items-center gap-2 text-[40px] font-bold leading-none tracking-[-0.02em]">
                  {business.rating.toFixed(1)}
                  <Star className="h-8 w-8" />
                </p>
              ) : null}
              {business.reviews.length > 0 ? (
                <ul className="mt-8 grid gap-x-10 gap-y-8 sm:grid-cols-2">
                  {business.reviews.map((review) => (
                    <li key={review.id}>
                      <div className="flex items-center gap-3">
                        <Initials name={review.authorName} />
                        <div>
                          <p className="text-[15px] font-semibold">{review.authorName}</p>
                          <Stars rating={review.rating} className="h-3.5 w-3.5" />
                        </div>
                      </div>
                      <p className="mt-3 text-[15px] leading-relaxed">{review.comment}</p>
                      <p className="mt-2 text-[13px] text-muted">
                        <time dateTime={review.createdAt}>
                          {new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }).format(
                            new Date(review.createdAt),
                          )}
                        </time>
                        {review.serviceName ? ` · ${review.serviceName}` : ''}
                      </p>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="text-muted">No reviews yet. Customers are asked for one after each visit.</p>
              )}
            </Section>

            {/* Portfolio */}
            {business.gallery.length > 0 ? (
              <Section id="portfolio" title="Portfolio" count={String(business.gallery.length)}>
                <ul className="grid grid-cols-2 gap-2 md:grid-cols-3">
                  {business.gallery.map((image, index) => (
                    <li key={image.url} className={index === 0 ? 'col-span-2 row-span-2 md:col-span-2' : ''}>
                      <img src={image.url} alt={image.alt} loading="lazy" className="aspect-square h-full w-full rounded-lg object-cover" />
                    </li>
                  ))}
                </ul>
              </Section>
            ) : null}

            {/* About */}
            <Section id="about" title="About">
              <p className="max-w-[70ch] text-[16px] leading-relaxed">{business.about}</p>
              {business.addressLine ? (
                <p className="mt-5 flex items-start gap-2 text-[15px]">
                  <PinIcon className="mt-0.5 h-5 w-5 shrink-0" />
                  <span>
                    {business.addressLine}{' '}
                    {directions ? (
                      <a href={directions} target="_blank" rel="noopener noreferrer" className="font-semibold text-brand hover:underline">
                        Get directions
                      </a>
                    ) : null}
                  </span>
                </p>
              ) : null}
            </Section>

            {/* Hours + additional information */}
            <div className="grid gap-10 border-t border-line py-10 sm:grid-cols-2">
              <div>
                <h2 className="text-[24px] font-bold tracking-[-0.02em]">Opening times</h2>
                <div className="mt-5">
                  <OpeningHours hours={business.hours} timezone={business.timezone} />
                </div>
              </div>
              <div>
                <h2 className="text-[24px] font-bold tracking-[-0.02em]">Additional information</h2>
                <ul className="mt-5 space-y-2.5">
                  {facts.map((fact) => (
                    <li key={fact} className="flex items-center gap-3 text-[15px]">
                      <CheckIcon className="h-5 w-5 shrink-0" />
                      {fact}
                    </li>
                  ))}
                </ul>
              </div>
            </div>

            {/* The Book Now target. */}
            <section id="book" aria-labelledby="book-heading" className="scroll-mt-6 border-t border-line py-10">
              <h2 id="book-heading" className="mb-6 text-[24px] font-bold tracking-[-0.02em]">
                Book with {business.name}
              </h2>
              {LIVE_BOOKING ? (
                <BookingFlow
                  slug={business.slug}
                  businessName={business.name}
                  timezone={business.timezone}
                  bookingHorizonDays={business.bookingHorizonDays}
                  services={services}
                  staff={business.staff}
                />
              ) : (
                <div className="rounded-2xl bg-surface p-6 md:p-8">
                  <p className="max-w-[60ch] text-[15px] text-muted">
                    Online booking needs the live Scalivo service, which this preview is not connected to. Send{' '}
                    {business.name} a message to book.
                  </p>
                  <p className="mt-4 inline-flex items-center gap-2 text-[15px] font-semibold">
                    <ChatIcon /> Booked and confirmed over WhatsApp
                  </p>
                </div>
              )}
            </section>
          </div>

          {/* Sticky booking card */}
          <aside aria-label={`Book ${business.name}`} className="hidden md:block">
            <div className="sticky top-6 rounded-lg border border-line p-6">
              <p className="text-[24px] font-bold tracking-[-0.02em]">{business.name}</p>
              {business.rating !== null ? (
                <p className="mt-1 flex items-center gap-1.5 text-[15px]">
                  <span className="font-semibold">{business.rating.toFixed(1)}</span>
                  <Stars rating={business.rating} />
                  <span className="text-brand">({business.reviewCount.toLocaleString('en-US')})</span>
                </p>
              ) : null}
              <a href="#book" className={`${bookNow} mt-5 w-full`}>
                Book now
              </a>
              <div className="mt-6 space-y-4 border-t border-line pt-6">
                <ClockLine hours={business.hours} timezone={business.timezone} />
                {business.addressLine ? (
                  <p className="flex items-start gap-3 text-[15px]">
                    <PinIcon className="mt-0.5 h-5 w-5 shrink-0" />
                    <span>
                      {business.addressLine}
                      {directions ? (
                        <>
                          {' '}
                          <a href={directions} target="_blank" rel="noopener noreferrer" className="font-semibold text-brand hover:underline">
                            Get directions
                          </a>
                        </>
                      ) : null}
                    </span>
                  </p>
                ) : null}
              </div>
            </div>
          </aside>
        </div>

        {/* Venues nearby */}
        {nearby.length > 0 ? (
          <section aria-labelledby="nearby-heading" className="border-t border-line pt-10">
            <h2 id="nearby-heading" className="text-[24px] font-bold tracking-[-0.02em]">
              Venues nearby
            </h2>
            <div className="mt-6">
              <Carousel label="Venues nearby">
                {nearby.map((other) => (
                  <Slide key={other.id}>
                    <VenueCard business={other} />
                  </Slide>
                ))}
              </Carousel>
            </div>
          </section>
        ) : null}
      </main>

      {/* Phone: price and Book now pinned to the bottom of the screen. */}
      <HideWhileBooking className="fixed inset-x-0 bottom-0 z-40 flex items-center justify-between gap-4 border-t border-line bg-white px-5 py-3 md:hidden">
        <p className="text-[14px]">
          {fromPriceMinor === null ? (
            <span className="text-muted">{services.length} services</span>
          ) : (
            <>
              <span className="block text-muted">{services.length} services available</span>
              <span className="font-semibold">
                {fromPriceMinor === 0 ? 'From Free' : `From ${formatPrice(fromPriceMinor)}`}
              </span>
            </>
          )}
        </p>
        <a href="#book" className={bookNow}>
          Book now
        </a>
      </HideWhileBooking>
    </>
  );
}

function Section({ id, title, count, children }: { id: string; title: string; count?: string | undefined; children: ReactNode }) {
  return (
    <section id={id} aria-labelledby={`${id}-heading`} className="scroll-mt-6 pb-12">
      <h2 id={`${id}-heading`} className="mb-5 flex items-baseline gap-2 text-[24px] font-bold tracking-[-0.02em]">
        {title}
        {count ? <span className="text-[14px] font-medium text-muted">{count}</span> : null}
      </h2>
      {children}
    </section>
  );
}

function Dot() {
  return (
    <span aria-hidden="true" className="text-muted">
      ·
    </span>
  );
}
