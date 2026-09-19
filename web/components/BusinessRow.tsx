import Link from 'next/link';

import { CoverPlate } from '@/components/CoverPlate';
import { FromPrice } from '@/components/FromPrice';
import { Rating } from '@/components/Rating';
import { categoryLabel, type BusinessCard } from '@/lib/marketplace';

/**
 * One line in the ledger. A tall cover plate on the left and everything a
 * person needs to decide on the right — category, place, hook, rating, price —
 * with a hairline underneath rather than a card border around it.
 */
export function BusinessRow({
  business,
  showServices = false,
}: {
  business: BusinessCard;
  showServices?: boolean;
}) {
  const place = [business.neighbourhood, business.city].filter(Boolean).join(', ');

  return (
    <article className="border-b border-line">
      <Link href={`/${business.slug}`} className="row-link grid grid-cols-[84px_1fr] gap-4 py-5 sm:grid-cols-[96px_1fr] sm:gap-5">
        <CoverPlate
          url={business.coverUrl}
          name={business.name}
          width={96}
          height={128}
          className="h-[112px] w-[84px] sm:h-[128px] sm:w-24"
        />

        <div className="min-w-0">
          <p className="label text-kashi">
            {categoryLabel(business.category)}
            {place ? <span className="text-muted"> · {place}</span> : null}
          </p>

          <h3 className="display-sm mt-1.5 font-display text-[1.25rem] font-semibold leading-tight sm:text-[1.375rem]">
            <span className="rule-draw inline-block">{business.name}</span>
          </h3>

          <p className="mt-1.5 line-clamp-2 text-[0.9375rem] leading-snug text-muted">{business.tagline}</p>

          {showServices && business.popularServices.length > 0 ? (
            <p className="label mt-2.5 text-muted">{business.popularServices.join(' · ')}</p>
          ) : null}

          <div className="mt-3 flex flex-wrap items-end justify-between gap-x-4 gap-y-2">
            <Rating rating={business.rating} reviewCount={business.reviewCount} />
            <FromPrice priceMinor={business.fromPriceMinor} />
          </div>
        </div>
      </Link>
    </article>
  );
}
