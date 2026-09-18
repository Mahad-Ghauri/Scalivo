import Link from 'next/link';

import { Stars } from '@/components/Icons';
import type { FeaturedReview } from '@/lib/marketplace';

export function Initials({ name, className = 'h-12 w-12 text-[16px]' }: { name: string; className?: string }) {
  const letters = name
    .replace(/^Dr\.\s*/, '')
    .split(/\s+/)
    .map((part) => part.charAt(0))
    .join('')
    .slice(0, 2)
    .toUpperCase();

  return (
    <span
      aria-hidden="true"
      className={`flex shrink-0 items-center justify-center rounded-full bg-[#eeebff] font-semibold text-brand ${className}`}
    >
      {letters}
    </span>
  );
}

/** A grey review tile for the home page carousel. */
export function ReviewCard({ review }: { review: FeaturedReview }) {
  return (
    <figure className="flex h-full min-h-[360px] flex-col rounded-2xl bg-surface p-7 md:p-8">
      <Stars rating={review.rating} className="h-6 w-6" />
      <h3 className="mt-4 text-[19px] font-semibold leading-snug">{review.serviceName ?? review.businessName}</h3>
      <blockquote className="mt-3 line-clamp-6 text-[16px] leading-relaxed">{review.comment}</blockquote>
      <figcaption className="mt-auto flex items-center gap-3 pt-6">
        <Initials name={review.authorName} className="h-14 w-14 text-[17px]" />
        <span>
          <span className="block text-[16px] font-semibold">{review.authorName}</span>
          <Link href={`/${review.businessSlug}`} className="text-[15px] text-muted hover:text-ink hover:underline">
            {review.businessName}
          </Link>
        </span>
      </figcaption>
    </figure>
  );
}
