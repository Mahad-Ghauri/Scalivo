import Link from 'next/link';
import type { OwnerReview, ReviewSummary } from '@scalivo/shared';
import { fetchApi } from '@/lib/api-client';
import { ReviewList } from '@/components/dashboard/ReviewList';
import { StatCard } from '@/components/dashboard/StatCard';

/**
 * Reviews, including the ones the public never sees.
 *
 * The flagged filter is the working view: a customer who rated 3 or less is
 * someone to ring today, and the whole point of collecting ratings over
 * WhatsApp instead of sending people to a public listing is that the owner
 * hears it first. There is deliberately no publish or delete control — see
 * backend/src/reviews/routes.ts.
 */

const FILTERS = [
  { key: 'all', label: 'All' },
  { key: 'flagged', label: 'Needs attention' },
  { key: 'published', label: 'On your profile' },
] as const;

type Filter = (typeof FILTERS)[number]['key'];

interface ReviewsResponse {
  reviews: OwnerReview[];
  total: number;
}

export default async function DashboardReviewsPage({
  params,
  searchParams,
}: {
  params: Promise<{ businessId: string }>;
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
}) {
  const { businessId } = await params;
  const { filter: filterParam } = await searchParams;

  const filter: Filter = FILTERS.some((f) => f.key === filterParam)
    ? (filterParam as Filter)
    : 'all';

  let data: ReviewsResponse = { reviews: [], total: 0 };
  let summary: ReviewSummary | null = null;
  let timezone = 'UTC';
  let error = false;

  try {
    const [reviewsRes, summaryRes, business] = await Promise.all([
      fetchApi<ReviewsResponse>(`/businesses/${businessId}/reviews`, { params: { filter } }),
      fetchApi<ReviewSummary>(`/businesses/${businessId}/reviews/summary`),
      fetchApi<{ timezone: string }>(`/businesses/${businessId}`),
    ]);
    data = reviewsRes;
    summary = summaryRes;
    timezone = business.timezone;
  } catch {
    error = true;
  }

  const basePath = `/dashboard/${businessId}/reviews`;

  return (
    <div className="flex h-full flex-col">
      <div className="flex-none px-8 py-6">
        <h1 className="text-2xl font-bold tracking-tight text-ink lowercase font-display">
          reviews
        </h1>
        <p className="mt-1 text-[15px] text-muted">
          Customers are asked on WhatsApp a couple of hours after their appointment. Four and five
          stars go on your profile; anything lower comes here instead.
        </p>

        {summary && (
          <div className="mt-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <StatCard
              title="Average rating"
              value={summary.averageRating === null ? '—' : summary.averageRating.toFixed(1)}
              description="Across every rating, published or not"
            />
            <StatCard
              title="Needs attention"
              value={summary.flagged}
              description="Rated 3 or below — not published"
            />
            <StatCard
              title="Reply rate"
              value={`${Math.round(summary.captureRate * 100)}%`}
              description={`${summary.answered} of ${summary.requested} asked`}
            />
            <StatCard title="Reviews collected" value={summary.answered} />
          </div>
        )}

        <div className="mt-6 flex gap-2">
          {FILTERS.map((option) => {
            const active = option.key === filter;
            return (
              <Link
                key={option.key}
                href={option.key === 'all' ? basePath : `${basePath}?filter=${option.key}`}
                aria-current={active ? 'page' : undefined}
                className={`rounded-full border px-3.5 py-1.5 text-[14px] font-medium ${
                  active
                    ? 'border-ink bg-ink text-white'
                    : 'border-line bg-white text-muted hover:text-ink'
                }`}
              >
                {option.label}
              </Link>
            );
          })}
        </div>
      </div>

      <div className="flex-1 min-h-0 overflow-y-auto px-8 pb-8">
        {error ? (
          <div className="rounded-2xl border border-red-100 bg-red-50 p-12 text-center shadow-sm">
            <h2 className="text-lg font-semibold text-red-900">Failed to load reviews</h2>
            <p className="mt-2 text-sm font-medium text-red-700">
              We encountered an issue fetching your reviews. Please try refreshing.
            </p>
          </div>
        ) : data.reviews.length === 0 ? (
          <div className="rounded-2xl border border-line bg-white p-16 text-center shadow-sm">
            <h2 className="text-lg font-semibold text-ink">
              {filter === 'flagged' ? 'Nothing needs attention' : 'No reviews yet'}
            </h2>
            <p className="mt-2 text-[15px] font-medium text-muted">
              {filter === 'flagged'
                ? 'Low ratings show up here so you hear about them before anyone else does.'
                : 'Mark an appointment complete and we will ask that customer how it went.'}
            </p>
          </div>
        ) : (
          <ReviewList reviews={data.reviews} timezone={timezone} />
        )}
      </div>
    </div>
  );
}
