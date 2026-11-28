import { fetchApi } from '@/lib/api-client';
import { formatPrice } from '@/lib/format';
import { StatCard } from '@/components/dashboard/StatCard';

/**
 * The audit log: everything that happened in the business over a period, with
 * who did it, plus a summary and a PDF download. The backend builds the report;
 * the app shows the same one.
 */

type Tone = 'ok' | 'warning' | 'problem';
interface AuditEvent {
  at: string;
  category: string;
  title: string;
  detail: string;
  actor: string;
  tone: Tone;
}
interface AuditReport {
  business: { name: string; timezone: string };
  range: { from: string; to: string };
  summary: {
    bookings: number;
    bySource: { whatsapp: number; web: number; owner: number };
    completed: number;
    cancelled: number;
    noShows: number;
    revenueMinor: number;
    messagesSent: number;
    messagesDelivered: number;
    messagesFailed: number;
    deliveryRate: number | null;
    whatsappDisconnects: number;
    reviews: number;
    averageRating: number | null;
    staffActions: number;
  };
  events: AuditEvent[];
  truncated: boolean;
}

const CATEGORIES = [
  ['', 'Everything'],
  ['booking', 'Bookings'],
  ['message', 'Messages'],
  ['payment', 'Payments'],
  ['whatsapp', 'WhatsApp'],
  ['review', 'Reviews'],
  ['marketing', 'Marketing'],
  ['services', 'Services'],
  ['staff', 'Staff'],
  ['customers', 'Customers'],
  ['calendar', 'Calendar'],
  ['settings', 'Settings'],
] as const;
const LABEL = Object.fromEntries(CATEGORIES) as Record<string, string>;
const DOT: Record<Tone, string> = { ok: 'bg-open', warning: 'bg-star', problem: 'bg-red-500' };

const iso = (timezone: string, date: Date) =>
  new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(date);
const isDate = (v: unknown): v is string => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v);

export default async function AuditPage({
  params,
  searchParams,
}: {
  params: Promise<{ businessId: string }>;
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
}) {
  const { businessId } = await params;
  const query = await searchParams;

  let report: AuditReport | null = null;
  let from = '';
  let to = '';
  const category = typeof query.category === 'string' && query.category in LABEL ? query.category : '';
  const search = typeof query.search === 'string' ? query.search.slice(0, 100) : '';

  try {
    const business = await fetchApi<{ timezone: string }>(`/businesses/${businessId}`);
    to = isDate(query.to) ? query.to : iso(business.timezone, new Date());
    from = isDate(query.from) ? query.from : iso(business.timezone, new Date(Date.now() - 29 * 86_400_000));
    report = await fetchApi<AuditReport>(`/businesses/${businessId}/audit`, {
      params: { from, to, category: category || undefined, search: search || undefined },
    });
  } catch {
    report = null;
  }

  const pdfHref =
    `/api/business/${encodeURIComponent(businessId)}/audit-pdf?` +
    new URLSearchParams({ from, to, ...(category ? { category } : {}), ...(search ? { search } : {}) });
  const time = (at: string) =>
    new Intl.DateTimeFormat('en-GB', {
      timeZone: report?.business.timezone,
      day: 'numeric',
      month: 'short',
      year: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
    }).format(new Date(at));

  return (
    <div className="space-y-6 py-2">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-ink lowercase font-display">audit log</h1>
          <p className="mt-1 text-[15px] text-muted">
            Every booking, message, payment and change in your business, and who did it.
          </p>
        </div>
        {report && (
          <a
            href={pdfHref}
            className="rounded-full bg-ink px-4 py-2 text-[14px] font-semibold text-white hover:bg-ink/90"
          >
            Download PDF
          </a>
        )}
      </div>

      <form method="get" className="flex flex-wrap items-end gap-3 rounded-2xl border border-line bg-white p-4">
        <label className="text-[13px] font-medium text-muted">
          From
          <input type="date" name="from" defaultValue={from} className="mt-1 block rounded-lg border border-line px-3 py-1.5 text-[14px] text-ink" />
        </label>
        <label className="text-[13px] font-medium text-muted">
          To
          <input type="date" name="to" defaultValue={to} className="mt-1 block rounded-lg border border-line px-3 py-1.5 text-[14px] text-ink" />
        </label>
        <label className="text-[13px] font-medium text-muted">
          Type
          <select name="category" defaultValue={category} className="mt-1 block rounded-lg border border-line px-3 py-1.5 text-[14px] text-ink">
            {CATEGORIES.map(([value, label]) => (
              <option key={value} value={value}>{label}</option>
            ))}
          </select>
        </label>
        <label className="min-w-[200px] flex-1 text-[13px] font-medium text-muted">
          Search
          <input
            type="search"
            name="search"
            defaultValue={search}
            placeholder="Customer, staff or service"
            className="mt-1 block w-full rounded-lg border border-line px-3 py-1.5 text-[14px] text-ink"
          />
        </label>
        <button type="submit" className="cursor-pointer rounded-full border border-ink px-4 py-1.5 text-[14px] font-semibold text-ink hover:bg-ink hover:text-white">
          Apply
        </button>
      </form>

      {!report ? (
        <div className="rounded-2xl border border-red-100 bg-red-50 p-12 text-center">
          <h2 className="text-lg font-semibold text-red-900">Could not load the audit log</h2>
          <p className="mt-2 text-sm text-red-700">Check the dates and try again.</p>
        </div>
      ) : (
        <>
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <StatCard
              title="Bookings"
              value={String(report.summary.bookings)}
              description={`WhatsApp ${report.summary.bySource.whatsapp} · website ${report.summary.bySource.web} · you ${report.summary.bySource.owner}`}
            />
            <StatCard
              title="Revenue (completed)"
              value={formatPrice(report.summary.revenueMinor)}
              description={`${report.summary.completed} completed · ${report.summary.cancelled} cancelled · ${report.summary.noShows} no-shows`}
            />
            <StatCard
              title="Messages delivered"
              value={report.summary.deliveryRate === null ? 'n/a' : `${report.summary.deliveryRate}%`}
              description={`${report.summary.messagesSent} sent · ${report.summary.messagesFailed} failed · WhatsApp dropped ${report.summary.whatsappDisconnects}×`}
            />
            <StatCard
              title="Reviews"
              value={report.summary.averageRating === null ? 'n/a' : `${report.summary.averageRating} / 5`}
              description={`${report.summary.reviews} received · ${report.summary.staffActions} staff actions`}
            />
          </div>

          <div className="overflow-hidden rounded-2xl border border-line bg-white">
            <div className="border-b border-line px-4 py-3 text-[14px] font-semibold text-ink">
              {report.events.length} entr{report.events.length === 1 ? 'y' : 'ies'}
              {report.truncated && <span className="font-normal text-muted"> (showing the newest 5,000)</span>}
            </div>
            {report.events.length === 0 ? (
              <p className="p-8 text-center text-[14px] text-muted">Nothing matches these filters.</p>
            ) : (
              <ul className="divide-y divide-line">
                {report.events.map((e, i) => (
                  <li key={`${e.at}-${i}`} className="grid gap-1 px-4 py-3 sm:grid-cols-[170px_110px_1fr_160px] sm:gap-4">
                    <span className="text-[13px] text-muted">{time(e.at)}</span>
                    <span className="flex items-center gap-2 text-[13px] text-ink">
                      <span className={`h-2 w-2 shrink-0 rounded-full ${DOT[e.tone]}`} aria-hidden />
                      {LABEL[e.category] ?? e.category}
                    </span>
                    <span className="min-w-0">
                      <span className="block text-[14px] font-medium text-ink">{e.title}</span>
                      {e.detail && <span className="block text-[13px] text-muted">{e.detail}</span>}
                    </span>
                    <span className="text-[13px] text-muted sm:text-right">{e.actor || '-'}</span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </>
      )}
    </div>
  );
}
