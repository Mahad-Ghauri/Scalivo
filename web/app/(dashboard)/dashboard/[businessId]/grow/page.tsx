import Link from 'next/link';
import type { BoostState, FunnelReport } from '@scalivo/shared';
import { fetchApi } from '@/lib/api-client';
import { CHANNEL_LABEL, formatPhone, profileLink, shareTargets } from '@/lib/grow';
import { AutoRefresh } from '@/components/dashboard/grow/AutoRefresh';
import { BoostToggle } from '@/components/dashboard/grow/BoostToggle';
import { QrCode } from '@/components/dashboard/grow/QrCode';
import { ShareLinks } from '@/components/dashboard/grow/ShareLinks';

/**
 * Grow — SPEC §10. Marketing for someone with no marketing experience: every
 * action here is one tap, and every word they would post is already written.
 *
 * Top to bottom in the order an owner needs it: is anyone coming (the funnel),
 * then the ways to get more — the counter poster, the share links, the boost.
 */

const RANGES = [
  { key: 'today', label: 'Today', days: 1 },
  { key: '7d', label: 'Last 7 days', days: 7 },
  { key: '30d', label: 'Last 30 days', days: 30 },
] as const;

/** Same rule as analytics: "today" is the business's today, never the server's. */
function localRange(timezone: string, days: number): { from: string; to: string } {
  const to = new Intl.DateTimeFormat('en-CA', { timeZone: timezone }).format(new Date());
  const anchor = new Date(`${to}T00:00:00Z`);
  anchor.setUTCDate(anchor.getUTCDate() - (days - 1));
  return { from: anchor.toISOString().slice(0, 10), to };
}

interface OwnerBusiness {
  name: string;
  slug: string;
  timezone: string;
  published: boolean;
  profile?: { tagline?: string };
  boost?: { until?: string | null };
}

interface Invite {
  phone: string;
  link: string;
}

export default async function GrowPage({
  params,
  searchParams,
}: {
  params: Promise<{ businessId: string }>;
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
}) {
  const { businessId } = await params;
  const { range: rangeParam } = await searchParams;
  const range = RANGES.find((option) => option.key === rangeParam) ?? RANGES[1];

  let business: OwnerBusiness | null = null;
  try {
    business = await fetchApi<OwnerBusiness>(`/businesses/${businessId}`);
  } catch {
    business = null;
  }

  if (!business) {
    return (
      <div className="rounded-2xl border border-red-100 bg-red-50 p-12 text-center shadow-sm">
        <h2 className="text-lg font-semibold text-red-900">Failed to load</h2>
        <p className="mt-2 text-sm font-medium text-red-700">Please try refreshing.</p>
      </div>
    );
  }

  const { from, to } = localRange(business.timezone, range.days);
  const [funnel, boost, invite] = await Promise.all([
    fetchApi<FunnelReport>(`/businesses/${businessId}/grow/funnel`, { params: { from, to } }).catch(() => null),
    fetchApi<BoostState>(`/businesses/${businessId}/grow/boost`).catch(() => null),
    // 409 until a WhatsApp number is connected — the poster then falls back to the web link.
    fetchApi<Invite>(`/businesses/${businessId}/invite`).catch(() => null),
  ]);

  const basePath = `/dashboard/${businessId}/grow`;
  const targets = shareTargets({ name: business.name, slug: business.slug, tagline: business.profile?.tagline ?? '' });
  const posterQr = invite?.link ?? (business.published ? profileLink(business.slug, 'qr') : null);

  return (
    <div className="space-y-6 py-2">
      <AutoRefresh seconds={30} />

      <div>
        <h1 className="text-2xl font-bold tracking-tight text-ink lowercase font-display">grow</h1>
        <p className="mt-1 text-[15px] text-muted">
          Bring in new customers and see which of your efforts is working.
        </p>
      </div>

      {/* ---------------------------------------------------------- funnel */}
      <section className="rounded-xl border border-line bg-white p-6 shadow-sm">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <h2 className="text-[17px] font-semibold text-ink">From visit to booking</h2>
            <p className="mt-0.5 text-[13px] text-muted">
              People who opened your page, started booking, and booked. Updates every 30 seconds.
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            {RANGES.map((option) => {
              const active = option.key === range.key;
              return (
                <Link
                  key={option.key}
                  href={`${basePath}?range=${option.key}`}
                  aria-current={active ? 'page' : undefined}
                  className={`rounded-full border px-3.5 py-1.5 text-[14px] font-medium ${
                    active ? 'border-ink bg-ink text-white' : 'border-line bg-white text-muted hover:text-ink'
                  }`}
                >
                  {option.label}
                </Link>
              );
            })}
          </div>
        </div>

        {funnel ? <Funnel report={funnel} /> : <p className="mt-6 text-[15px] text-muted">Could not load the funnel.</p>}
      </section>

      <div className="grid gap-6 lg:grid-cols-2">
        {/* ------------------------------------------------------ poster */}
        <section className="rounded-xl border border-line bg-white p-6 shadow-sm">
          <h2 className="text-[17px] font-semibold text-ink">QR poster for your counter</h2>
          <p className="mt-0.5 text-[13px] text-muted">
            {invite
              ? `Customers scan it and land in a chat with ${formatPhone(invite.phone)}, ready to book. Once they have messaged you, your reminders reach them reliably.`
              : 'Customers scan it and land on your booking page.'}
          </p>

          {posterQr ? (
            <div className="mt-5 flex flex-wrap items-center gap-6">
              <QrCode
                value={posterQr}
                label={invite ? 'QR code that opens a WhatsApp chat' : 'QR code for your booking page'}
                className="h-36 w-36 rounded-lg border border-line"
              />
              <div className="space-y-3">
                <Link
                  href={`${basePath}/poster`}
                  className="inline-flex h-10 items-center rounded-full bg-ink px-5 text-[15px] font-semibold text-white hover:bg-black/80"
                >
                  Open printable poster
                </Link>
                <p className="max-w-[28ch] text-[13px] text-muted">A4, black and white is fine. Tape it where people wait.</p>
              </div>
            </div>
          ) : (
            <p className="mt-5 text-[14px] text-muted">
              Connect your WhatsApp number in the app, or{' '}
              <Link href={`/dashboard/${businessId}/settings`} className="font-semibold text-brand hover:underline">
                publish your listing
              </Link>
              , and your poster is ready to print.
            </p>
          )}
        </section>

        {/* ------------------------------------------------------- boost */}
        <section className="rounded-xl border border-line bg-white p-6 shadow-sm">
          <h2 className="text-[17px] font-semibold text-ink">Boost your listing</h2>
          <div className="mt-3">
            {boost ? (
              <BoostToggle
                businessId={businessId}
                boost={boost}
                published={business.published}
                timezone={business.timezone}
              />
            ) : (
              <p className="text-[14px] text-muted">Could not load the boost.</p>
            )}
          </div>
        </section>
      </div>

      {/* --------------------------------------------------- win customers back */}
      <section className="rounded-xl border border-line bg-white p-6 shadow-sm">
        <h2 className="text-[17px] font-semibold text-ink">Win customers back</h2>
        <p className="mt-0.5 text-[13px] text-muted">
          The cheapest booking you will get is from someone who has already been in. Customers who are overdue get an
          automatic reminder to rebook, and you can message the ones who have drifted away.
        </p>
        <Link
          href={`${basePath}/broadcast`}
          className="mt-5 inline-flex h-10 items-center rounded-full border border-line px-5 text-[15px] font-semibold text-ink hover:bg-surface"
        >
          Open win-back
        </Link>
      </section>

      {/* ------------------------------------------------------- share */}
      <section className="rounded-xl border border-line bg-white p-6 shadow-sm">
        <h2 className="text-[17px] font-semibold text-ink">Share your booking link</h2>
        <p className="mt-0.5 text-[13px] text-muted">
          Captions are written for you. Each link is tagged, so the funnel above shows where your customers came from.
        </p>
        {business.published ? (
          <div className="mt-5">
            <ShareLinks targets={targets} storyImage={`/${business.slug}/story`} />
          </div>
        ) : (
          <p className="mt-5 text-[14px] text-muted">
            Your page is hidden until you publish it, so a shared link would go nowhere.{' '}
            <Link href={`/dashboard/${businessId}/settings`} className="font-semibold text-brand hover:underline">
              Publish it in Settings
            </Link>
          </p>
        )}
      </section>
    </div>
  );
}

const percent = (part: number, whole: number) => (whole === 0 ? null : Math.min(100, Math.round((part / whole) * 100)));

/**
 * Three bars on one scale, labelled directly — no chart library, no legend, no
 * axis to read. One series, so one colour; the numbers carry the meaning.
 */
function Funnel({ report }: { report: FunnelReport }) {
  const { totals, byChannel, whatsappBookings } = report;
  const max = Math.max(totals.views, totals.starts, totals.bookings, 1);

  if (totals.views + totals.starts + totals.bookings === 0) {
    return (
      <div className="mt-6 rounded-lg bg-surface px-5 py-6">
        <p className="text-[15px] font-semibold text-ink">No visits in this range yet</p>
        <p className="mt-1 text-[14px] text-muted">
          Share your link or put up the poster. Visits show here within a minute of happening.
        </p>
        {whatsappBookings > 0 && <WhatsappLine count={whatsappBookings} />}
      </div>
    );
  }

  const stages = [
    { label: 'Opened your page', value: totals.views, note: null },
    {
      label: 'Started booking',
      value: totals.starts,
      note: percent(totals.starts, totals.views) === null ? null : `${percent(totals.starts, totals.views)}% of visitors`,
    },
    {
      label: 'Booked',
      value: totals.bookings,
      note: percent(totals.bookings, totals.starts) === null ? null : `${percent(totals.bookings, totals.starts)}% of those who started`,
    },
  ];

  return (
    <div className="mt-6 space-y-8">
      <ol className="space-y-4">
        {stages.map((stage) => (
          <li key={stage.label}>
            <div className="flex items-baseline justify-between gap-4 text-[14px]">
              <span className="font-medium text-ink">{stage.label}</span>
              <span className="text-muted">
                {stage.note && <span className="mr-3">{stage.note}</span>}
                <span className="text-[17px] font-semibold tabular-nums text-ink">{stage.value.toLocaleString('en-US')}</span>
              </span>
            </div>
            <div className="mt-1.5 h-3 rounded-full bg-surface">
              <div
                className="h-3 rounded-full bg-brand"
                // At least a sliver, so a stage of 1 against 400 is still visibly there.
                style={{ width: stage.value === 0 ? 0 : `max(${(stage.value / max) * 100}%, 6px)` }}
              />
            </div>
          </li>
        ))}
      </ol>

      <div className="overflow-x-auto">
        <table className="w-full min-w-[480px] text-left text-[14px]">
          <caption className="sr-only">Visits, starts and bookings by where customers came from</caption>
          <thead>
            <tr className="border-b border-line text-[13px] text-muted">
              <th scope="col" className="py-2 pr-4 font-medium">Came from</th>
              <th scope="col" className="py-2 pr-4 text-right font-medium">Visits</th>
              <th scope="col" className="py-2 pr-4 text-right font-medium">Started</th>
              <th scope="col" className="py-2 pr-4 text-right font-medium">Booked</th>
              <th scope="col" className="py-2 text-right font-medium">Booked per visit</th>
            </tr>
          </thead>
          <tbody>
            {byChannel.map((row) => {
              const rate = percent(row.bookings, row.views);
              return (
                <tr key={row.channel} className="border-b border-line last:border-0">
                  <th scope="row" className="py-2.5 pr-4 font-medium text-ink">{CHANNEL_LABEL[row.channel]}</th>
                  <td className="py-2.5 pr-4 text-right tabular-nums">{row.views}</td>
                  <td className="py-2.5 pr-4 text-right tabular-nums">{row.starts}</td>
                  <td className="py-2.5 pr-4 text-right tabular-nums font-semibold">{row.bookings}</td>
                  <td className="py-2.5 text-right tabular-nums text-muted">{rate === null ? '-' : `${rate}%`}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {whatsappBookings > 0 && <WhatsappLine count={whatsappBookings} />}
    </div>
  );
}

function WhatsappLine({ count }: { count: number }) {
  return (
    <p className="mt-3 text-[14px] text-muted">
      Plus <span className="font-semibold text-ink">{count}</span> booking{count === 1 ? '' : 's'} made by messaging you on
      WhatsApp, which don&rsquo;t pass through your page.
    </p>
  );
}
