import { StarRating } from '@/components/Icons';

/** `rating` is null until a business has published reviews. That is a state, not a zero. */
export function Rating({ rating, reviewCount }: { rating: number | null; reviewCount: number }) {
  if (rating === null) {
    return <p className="label text-muted">No reviews yet</p>;
  }

  return (
    <p className="flex items-center gap-2">
      <StarRating rating={rating} label={`Rated ${rating.toFixed(1)} out of 5`} />
      <span className="num text-[0.8125rem] font-medium text-ink">{rating.toFixed(1)}</span>
      <span className="num text-[0.75rem] text-muted">({reviewCount})</span>
    </p>
  );
}
