import Link from 'next/link';
import type { FollowUpItem } from '@scalivo/shared';
import { fetchApi } from '@/lib/api-client';

/**
 * Follow-ups the owner set, and the ones that need a human.
 *
 * "Needs a call" is the working view: the customer didn't reply to two
 * WhatsApp messages, has opted out, or has no WhatsApp at all. Everything else
 * is the system doing its job and is listed so the owner can see it is.
 */

const FILTERS = [
  { key: 'open', label: 'Open' },
  { key: 'lapsed', label: 'Needs a call' },
  { key: 'all', label: 'All' },
] as const;
type Filter = (typeof FILTERS)[number]['key'];

const STATUS: Record<string, { text: string; cls: string }> = {
  scheduled: { text: 'Scheduled', cls: 'bg-brand/10 text-brand' },
  offered: { text: 'Messaged', cls: 'bg-star/20 text-amber-900' },
  nudged: { text: 'Reminded once', cls: 'bg-star/20 text-amber-900' },
  booked: { text: 'Booked', cls: 'bg-open/10 text-open' },
  declined: { text: 'Not now', cls: 'bg-surface text-muted' },
  lapsed: { text: 'Needs a call', cls: 'bg-red-100 text-red-800' },
  cancelled: { text: 'Removed', cls: 'bg-surface text-muted' },
};

const REASON: Record<string, string> = {
  no_reply: 'No reply to 2 messages',
  opted_out: 'Opted out of WhatsApp',
  unreachable: 'No WhatsApp on file',
  service_retired: 'Service no longer offered',
  visit_not_marked_complete: 'Visit never marked complete',
};

export default async function FollowUpsPage({
  params,
  searchParams,
}: {
  params: Promise<{ businessId: string }>;
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
}) {
  const { businessId } = await params;
  const { status: raw } = await searchParams;
  const filter: Filter = FILTERS.some((f) => f.key === raw) ? (raw as Filter) : 'open';

  let items: FollowUpItem[] = [];
  let timezone = 'UTC';
  let error = false;
  try {
    const [list, business] = await Promise.all([
      fetchApi<{ followUps: FollowUpItem[] }>(`/businesses/${businessId}/follow-ups`, {
        params: { status: filter },
        cache: 'no-store',
      }),
      fetchApi<{ timezone: string }>(`/businesses/${businessId}`),
    ]);
    items = list.followUps;
    timezone = business.timezone;
  } catch {
    error = true;
  }

  const day = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    weekday: 'short',
    month: 'short',
    day: 'numeric',
  });
  const basePath = `/dashboard/${businessId}/follow-ups`;

  return (
    <div className="flex h-full flex-col">
      <div className="flex-none px-4 py-6 sm:px-8">
        <h1 className="font-display text-2xl font-bold lowercase tracking-tight text-ink">
          follow-ups
        </h1>
        <p className="mt-1 text-[15px] text-muted">
          Customers are messaged on WhatsApp 3 days before a follow-up is due, with a time they can
          book in one reply. The ones who don&apos;t answer land here.
        </p>
        <div className="mt-6 flex flex-wrap gap-2">
          {FILTERS.map((option) => {
            const active = option.key === filter;
            return (
              <Link
                key={option.key}
                href={option.key === 'open' ? basePath : `${basePath}?status=${option.key}`}
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

      <div className="min-h-0 flex-1 overflow-y-auto px-4 pb-8 sm:px-8">
        {error ? (
          <div className="rounded-2xl border border-red-100 bg-red-50 p-12 text-center">
            <h2 className="text-lg font-semibold text-red-900">Failed to load follow-ups</h2>
            <p className="mt-2 text-sm text-red-700">Please try refreshing.</p>
          </div>
        ) : items.length === 0 ? (
          <div className="rounded-2xl border border-line bg-white p-16 text-center">
            <h2 className="text-lg font-semibold text-ink">
              {filter === 'lapsed' ? 'Nobody to call' : 'No follow-ups yet'}
            </h2>
            <p className="mt-2 text-[15px] text-muted">
              Add one from any appointment, or set a default on a service so it&apos;s filled in
              for you.
            </p>
          </div>
        ) : (
          <ul className="divide-y divide-line rounded-2xl border border-line bg-white">
            {items.map((f) => {
              const s = STATUS[f.status] ?? STATUS.scheduled!;
              const phone = f.clientPhone?.replace(/\D/g, '');
              return (
                <li
                  key={f.bookingId}
                  className="flex flex-col gap-3 p-4 sm:flex-row sm:items-center sm:justify-between"
                >
                  <div className="min-w-0">
                    <p className="font-medium text-ink">
                      {f.clientName ?? 'Customer'}{' '}
                      <span className={`ml-1 rounded-full px-2 py-0.5 text-xs font-medium ${s.cls}`}>
                        {s.text}
                      </span>
                    </p>
                    <p className="mt-0.5 text-sm text-muted">
                      {f.serviceName}
                      {f.staffName ? ` with ${f.staffName}` : ''} · due {day.format(new Date(f.dueAt))}
                      {' · '}last visit {day.format(new Date(f.visitAt))}
                    </p>
                    {f.note && <p className="mt-0.5 text-sm text-ink">{f.note}</p>}
                    {f.lapsedReason && (
                      <p className="mt-0.5 text-sm text-red-700">{REASON[f.lapsedReason] ?? f.lapsedReason}</p>
                    )}
                  </div>
                  {phone && f.status !== 'booked' && (
                    <div className="flex shrink-0 gap-2">
                      <a
                        href={`tel:+${phone}`}
                        className="rounded-full border border-line px-3.5 py-1.5 text-sm font-medium text-ink hover:bg-surface"
                      >
                        Call
                      </a>
                      <a
                        href={`https://wa.me/${phone}`}
                        target="_blank"
                        rel="noreferrer"
                        className="rounded-full bg-ink px-3.5 py-1.5 text-sm font-medium text-white"
                      >
                        WhatsApp
                      </a>
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </div>
  );
}
