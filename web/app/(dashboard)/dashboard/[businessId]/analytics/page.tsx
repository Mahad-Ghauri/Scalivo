import Link from 'next/link';
import type { AnalyticsReport, Granularity } from '@scalivo/shared';
import { fetchApi } from '@/lib/api-client';
import { formatPrice } from '@/lib/format';
import { RevenueChart } from '@/components/dashboard/RevenueChart';
import { StatusBreakdown } from '@/components/dashboard/StatusBreakdown';
import { StatCard } from '@/components/dashboard/StatCard';

/**
 * Revenue and analytics — SPEC §7.
 *
 * Every range is computed in the BUSINESS's timezone, not the browser's or the
 * server's. An owner in Karachi looking at "last 7 days" from a machine set to
 * UTC must see their seven days; anything else moves the first five hours of
 * every evening into the day before, which is where a salon's best hours are.
 * That is why the business is fetched before the report rather than alongside it.
 */

const RANGES = [
  { key: '7d', label: 'Last 7 days', days: 7, granularity: 'day' },
  { key: '30d', label: 'Last 30 days', days: 30, granularity: 'day' },
  { key: '12w', label: 'Last 12 weeks', days: 84, granularity: 'week' },
  { key: '12m', label: 'Last 12 months', days: 365, granularity: 'month' },
] as const satisfies readonly {
  key: string;
  label: string;
  days: number;
  granularity: Granularity;
}[];

/** A month is long enough to show a pattern and short enough to read per day. */
const DEFAULT_RANGE = RANGES[1];

/** Today, and `days` ago, as ISO dates in the business's own calendar. */
function localRange(timezone: string, days: number): { from: string; to: string } {
  // en-CA gives YYYY-MM-DD, which is the format the API wants and the only
  // locale shortcut here. The timeZone is the whole point: "today" in Karachi
  // is not "today" on a server set to UTC for five hours of every evening.
  const to = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());

  // From here it is calendar arithmetic on a plain date, with no timezone left
  // in it — which is what makes "30 days" mean 30 days either side of a DST
  // change rather than 29 and a bit.
  const anchor = new Date(`${to}T00:00:00Z`);
  anchor.setUTCDate(anchor.getUTCDate() - (days - 1));

  return { from: anchor.toISOString().slice(0, 10), to };
}

export default async function DashboardAnalyticsPage({
  params,
  searchParams,
}: {
  params: Promise<{ businessId: string }>;
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
}) {
  const { businessId } = await params;
  const { range: rangeParam } = await searchParams;

  const range = RANGES.find((option) => option.key === rangeParam) ?? DEFAULT_RANGE;

  let report: AnalyticsReport | null = null;
  let error = false;

  try {
    const business = await fetchApi<{ timezone: string }>(`/businesses/${businessId}`);
    const { from, to } = localRange(business.timezone, range.days);

    report = await fetchApi<AnalyticsReport>(`/businesses/${businessId}/analytics`, {
      params: { from, to, granularity: range.granularity },
    });
  } catch {
    error = true;
  }

  const basePath = `/dashboard/${businessId}/analytics`;

  return (
    // One scroll area, the shell's own <main>. The list pages nest a second
    // one so their header stays put above a long table; a page of cards has
    // nothing to pin, and nesting it would only shrink the charts.
    <div className="space-y-6 py-2">
      <div>
        <h1 className="text-2xl font-bold tracking-tight text-ink lowercase font-display">
          analytics
        </h1>
        <p className="mt-1 text-[15px] text-muted">
          Revenue counts completed appointments only. Cancellations and no-shows are counted, but
          they are not money.
        </p>

        {/* Filters in one row above the charts. */}
        <div className="mt-6 flex flex-wrap gap-2">
          {RANGES.map((option) => {
            const active = option.key === range.key;
            return (
              <Link
                key={option.key}
                href={`${basePath}?range=${option.key}`}
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

      <div>
        {error || !report ? (
          <div className="rounded-2xl border border-red-100 bg-red-50 p-12 text-center shadow-sm">
            <h2 className="text-lg font-semibold text-red-900">Failed to load analytics</h2>
            <p className="mt-2 text-sm font-medium text-red-700">
              We encountered an issue building your report. Please try refreshing.
            </p>
          </div>
        ) : (
          <div className="space-y-6">
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
              <StatCard
                title="Revenue"
                value={formatPrice(report.revenueMinor)}
                description={`${report.volume.completed} completed`}
              />
              <StatCard
                title="On the books"
                value={formatPrice(report.forecast.revenueMinor)}
                description={`${report.forecast.bookings} appointment${
                  report.forecast.bookings === 1 ? '' : 's'
                } still to come`}
              />
              <StatCard
                title="No-show rate"
                // Null is "we don't know yet", and 0% is a record. They are not
                // the same thing and a new business must not be shown the second.
                value={
                  report.noShowRate === null ? '—' : `${Math.round(report.noShowRate * 100)}%`
                }
                description={
                  report.noShowRate === null
                    ? 'No appointments have happened yet'
                    : `${report.volume.noShow} of ${report.volume.completed + report.volume.noShow} that reached their hour`
                }
              />
              <StatCard
                title="Appointments"
                value={report.volume.total}
                description="Every status, in this range"
              />
            </div>

            <div className="grid gap-6 lg:grid-cols-[2fr_1fr]">
              <RevenueChart series={report.series} granularity={report.range.granularity} />
              <StatusBreakdown volume={report.volume} />
            </div>

            <div className="grid gap-6 lg:grid-cols-2">
              <TopList
                title="Top services"
                caption="By revenue, in this range"
                empty="No completed appointments in this range."
                rows={report.topServices.map((service) => ({
                  key: service.serviceId,
                  name: service.name,
                  detail: `${service.completed} booking${service.completed === 1 ? '' : 's'}`,
                  value: formatPrice(service.revenueMinor),
                }))}
              />
              <TopList
                title="Top customers"
                caption="By what they have spent with you, ever"
                empty="No completed appointments yet."
                rows={report.topClients.map((client) => ({
                  key: client.clientId,
                  name: client.name,
                  detail: `${client.totalVisits} visit${client.totalVisits === 1 ? '' : 's'}`,
                  value: formatPrice(client.lifetimeSpendMinor),
                }))}
              />
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function TopList({
  title,
  caption,
  empty,
  rows,
}: {
  title: string;
  caption: string;
  empty: string;
  rows: { key: string; name: string; detail: string; value: string }[];
}) {
  return (
    <section className="rounded-xl border border-line bg-white p-6 shadow-sm">
      <h2 className="text-sm font-medium text-muted">{title}</h2>
      <p className="mt-0.5 text-[13px] text-muted/80">{caption}</p>

      {rows.length === 0 ? (
        <p className="mt-5 text-[15px] text-muted">{empty}</p>
      ) : (
        <ol className="mt-5 space-y-3">
          {rows.map((row) => (
            <li key={row.key} className="flex items-baseline gap-3 text-[15px]">
              <span className="truncate text-ink">{row.name}</span>
              <span className="shrink-0 text-[13px] text-muted">{row.detail}</span>
              <span className="ml-auto shrink-0 tabular-nums font-medium text-ink">
                {row.value}
              </span>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}
