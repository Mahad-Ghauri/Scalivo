import Link from 'next/link';

import { Star } from '@/components/Icons';
import { categoryLabel, type BusinessCard } from '@/lib/marketplace';

/**
 * The badge is derived, never stored: a label an owner could set themselves
 * would say "Highly recommended" on every card within a week.
 */
function badgeFor(business: BusinessCard): string | null {
  if (business.reviewCount > 0 && business.reviewCount < 20) return 'New';
  if (business.rating !== null && business.rating >= 4.8) return 'Highly Recommended';
  if (business.fromPriceMinor === 0) return 'Free first visit';
  return null;
}

export function VenueCard({ business }: { business: BusinessCard }) {
  const badge = badgeFor(business);
  const place = [business.neighbourhood, business.city].filter(Boolean).join(', ');

  return (
    <article className="group relative">
      <div className="relative aspect-[3/2] overflow-hidden rounded-lg bg-surface">
        {business.coverUrl ? (
          <img
            src={business.coverUrl}
            alt=""
            loading="lazy"
            decoding="async"
            className="h-full w-full object-cover transition-transform duration-300 group-hover:scale-[1.03]"
          />
        ) : null}
        {badge ? (
          <span className="absolute left-3 top-3 inline-flex items-center gap-1 rounded-full bg-white/90 px-2.5 py-1 text-[13px] font-semibold backdrop-blur-sm">
            {badge === 'Highly Recommended' ? <Star className="h-3.5 w-3.5" /> : null}
            {badge}
          </span>
        ) : null}
      </div>

      <div className="mt-2.5 flex items-start justify-between gap-3">
        <h3 className="text-[16px] font-semibold leading-snug">
          {/* The whole card is the link, via the stretched ::after. */}
          <Link href={`/${business.slug}`} className="after:absolute after:inset-0 after:content-['']">
            {business.name}
          </Link>
        </h3>
        {business.rating !== null ? (
          <span className="flex shrink-0 items-center gap-1 text-[14px] font-semibold">
            <Star className="h-3.5 w-3.5" />
            {business.rating.toFixed(1)}
          </span>
        ) : null}
      </div>
      {place ? <p className="text-[14px] text-muted">{place}</p> : null}
      <p className="text-[14px] text-muted">
        {categoryLabel(business.category)}
        {business.reviewCount > 0 ? (
          <>
            <span aria-hidden="true"> · </span>
            {business.reviewCount.toLocaleString('en-US')} reviews
          </>
        ) : null}
      </p>
    </article>
  );
}

export function VenueGrid({ businesses }: { businesses: BusinessCard[] }) {
  return (
    <ul className="grid grid-cols-1 gap-x-7 gap-y-10 sm:grid-cols-2 lg:grid-cols-4">
      {businesses.map((business) => (
        <li key={business.id}>
          <VenueCard business={business} />
        </li>
      ))}
    </ul>
  );
}
