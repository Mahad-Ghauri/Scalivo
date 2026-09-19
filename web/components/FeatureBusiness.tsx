import Link from 'next/link';

import { CoverPlate } from '@/components/CoverPlate';
import { FromPrice } from '@/components/FromPrice';
import { ArrowEast } from '@/components/Icons';
import { Rating } from '@/components/Rating';
import { categoryLabel, type BusinessCard } from '@/lib/marketplace';

/**
 * The best-rated business, given a plate the size of its reputation. The
 * directory is sorted by rating, so this is always the top of the list rather
 * than an editorially "featured" slot someone has to maintain.
 */
export function FeatureBusiness({ business }: { business: BusinessCard }) {
  const place = [business.neighbourhood, business.city].filter(Boolean).join(', ');

  return (
    <article className="border-b border-rule pb-8 md:border-b-0 md:pb-0">
      <Link href={`/${business.slug}`} className="row-link block">
        <p className="label flex items-center gap-2 text-clay-deep">
          <span className="inline-block h-px w-6 bg-clay" aria-hidden="true" />
          Highest rated right now
        </p>

        <CoverPlate
          url={business.coverUrl}
          name={business.name}
          width={1200}
          height={720}
          className="mt-4 aspect-[16/10] w-full"
        />

        <p className="label mt-5 text-kashi">
          {categoryLabel(business.category)}
          {place ? <span className="text-muted"> · {place}</span> : null}
        </p>

        <h3 className="display-md mt-2 font-display text-[2rem] font-semibold leading-[1.02] sm:text-[2.5rem] lg:text-[3rem]">
          <span className="rule-draw inline-block">{business.name}</span>
        </h3>

        <p className="mt-3 max-w-[52ch] text-[1.0625rem] leading-relaxed text-ink/90">{business.tagline}</p>

        {business.popularServices.length > 0 ? (
          <ul className="mt-5 flex flex-wrap gap-x-4 gap-y-2 border-t border-rule pt-4">
            {business.popularServices.map((service) => (
              <li key={service} className="label text-muted">
                {service}
              </li>
            ))}
          </ul>
        ) : null}

        <div className="mt-4 flex flex-wrap items-end justify-between gap-4 border-t border-rule pt-4">
          <Rating rating={business.rating} reviewCount={business.reviewCount} />
          <div className="flex items-end gap-6">
            <FromPrice priceMinor={business.fromPriceMinor} />
            <span className="label-lg flex items-center gap-2 pb-0.5 text-kashi">
              Profile
              <ArrowEast />
            </span>
          </div>
        </div>
      </Link>
    </article>
  );
}
