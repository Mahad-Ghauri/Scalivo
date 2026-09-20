import type { OwnerReview } from '@scalivo/shared';

/**
 * The owner's view of their reviews, flagged ones included.
 *
 * The flagged rows are the reason this page exists, so they are styled as
 * something to act on rather than as a row in a list — a 2-star that reads like
 * every other entry is a 2-star nobody follows up.
 */

function Stars({ rating }: { rating: number }) {
  return (
    <span
      className="text-[15px] tracking-[0.15em] text-ink"
      aria-label={`${rating} out of 5`}
      role="img"
    >
      <span aria-hidden="true">{'★'.repeat(rating)}</span>
      <span aria-hidden="true" className="text-line">
        {'★'.repeat(5 - rating)}
      </span>
    </span>
  );
}

function when(iso: string, timezone: string): string {
  return new Date(iso).toLocaleDateString('en-GB', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    timeZone: timezone,
  });
}

export function ReviewList({
  reviews,
  timezone,
}: {
  reviews: OwnerReview[];
  timezone: string;
}) {
  return (
    <ul className="space-y-3">
      {reviews.map((review) => (
        <li
          key={review.id}
          className={`rounded-xl border bg-white p-5 shadow-sm ${
            review.flagged ? 'border-amber-300 bg-amber-50/40' : 'border-line'
          }`}
        >
          <div className="flex flex-wrap items-center gap-3">
            <Stars rating={review.rating} />
            <span className="text-[15px] font-semibold text-ink">{review.authorName}</span>
            {review.serviceName && (
              <span className="text-[14px] text-muted">{review.serviceName}</span>
            )}
            <span className="ml-auto text-[13px] text-muted">
              {when(review.createdAt, timezone)}
            </span>
          </div>

          {review.comment && (
            <p className="mt-3 text-[15px] leading-relaxed text-ink">{review.comment}</p>
          )}

          <p className="mt-3 text-[13px] font-medium">
            {review.flagged ? (
              <span className="text-amber-800">
                Not published — only you can see this. Worth a call.
              </span>
            ) : (
              <span className="text-muted">Published on your public profile.</span>
            )}
          </p>
        </li>
      ))}
    </ul>
  );
}
