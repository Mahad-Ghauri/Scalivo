import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import {
  BOOKING_STATUS,
  LOYALTY_MINOR_PER_POINT,
  type MeAppointment,
  type MeView,
} from '@scalivo/shared';

import { CustomerBookingTools } from '@/components/me/CustomerBookingTools';
import { RateVisit } from '@/components/me/RateVisit';
import { InstallHint } from '@/components/me/InstallHint';
import { formatDay, formatDuration, formatPrice, formatWhen } from '@/lib/format';
import { API_BASE } from '@/lib/site';

/**
 * The customer's own page — milestone 3.3.
 *
 * Reached from a WhatsApp link and, once installed, from a home-screen icon.
 * Everything about it follows from who is reading: somebody with no account,
 * usually on a phone, usually checking one thing ("when is it again?").
 *
 * So it is a single scrolling page with no navigation and no login. The URL is
 * the credential — see backend me/token.ts for what that costs and why it is
 * still the right trade for something meant to live on a home screen.
 */

export const dynamic = 'force-dynamic';

/**
 * Never indexed, and the `nofollow` matters as much as the `noindex`: this page
 * links out to the business's public profile, and a crawler that followed the
 * link would carry the token in the Referer. The backend sends
 * `Referrer-Policy: no-referrer` for the same reason; this is the half a search
 * engine obeys.
 *
 * The title deliberately names nobody. It becomes the home-screen label and the
 * browser tab, both of which are read over shoulders.
 */
export const metadata: Metadata = {
  title: 'My appointments',
  robots: { index: false, follow: false, nocache: true },
};

async function load(token: string): Promise<MeView | null> {
  const res = await fetch(`${API_BASE}/public/me/${encodeURIComponent(token)}`, {
    cache: 'no-store',
    signal: AbortSignal.timeout(15000),
  });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`customer page lookup failed: ${res.status}`);
  return (await res.json()) as MeView;
}

export default async function MePage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const me = await load(token);
  if (!me) notFound();

  const [next, ...laterOnes] = me.upcoming;

  return (
    <main className="mx-auto max-w-[560px] px-5 pb-24 pt-8">
      {/*
        The manifest is per-customer, because `start_url` has to be THIS page —
        an installed icon that opens a tokenless /me is an icon that opens a 404.
      */}
      <link rel="manifest" href={`/me/${token}/manifest.webmanifest`} />

      <header className="flex items-baseline justify-between gap-4">
        <div>
          <h1 className="text-[26px] font-bold tracking-[-0.02em]">
            {me.firstName ? `Hello, ${me.firstName}` : 'Your appointments'}
          </h1>
          <p className="mt-1 text-[15px] text-muted">at {me.businessName}</p>
        </div>
      </header>

      {next ? (
        <NextUp appointment={next} timezone={me.timezone} />
      ) : (
        <p className="mt-6 rounded-2xl border border-line p-6 text-[15px] text-muted">
          Nothing booked at the moment.
        </p>
      )}

      {laterOnes.length > 0 && (
        <section className="mt-8">
          <h2 className="text-[13px] font-semibold uppercase tracking-wide text-muted">
            Also coming up
          </h2>
          <ul className="mt-3 space-y-3">
            {laterOnes.map((appointment) => (
              <li key={appointment.id} className="rounded-2xl border border-line p-4">
                <p className="font-semibold">{appointment.serviceName}</p>
                <p className="mt-0.5 text-[15px] text-muted">
                  {formatWhen(appointment.startsAt, me.timezone)} · with {appointment.staffName}
                </p>
                <DepositNudge appointment={appointment} />
                <ApprovalNudge appointment={appointment} />
              </li>
            ))}
          </ul>
        </section>
      )}

      {/*
        The rating sits above the rebook on purpose. It is about a visit that has
        already happened, so it is the question the customer can answer without
        deciding anything — and asking after the booking flow would be asking
        somebody who has already got what they came for.
      */}
      {me.pendingReview && (
        <RateVisit token={token} pending={me.pendingReview} timezone={me.timezone} />
      )}

      <CustomerBookingTools
        token={token}
        appointments={me.upcoming}
        usual={me.usual}
        timezone={me.timezone}
        businessSlug={me.businessSlug}
      />

      <Loyalty me={me} />

      {me.past.length > 0 && (
        <section className="mt-10">
          <h2 className="text-[13px] font-semibold uppercase tracking-wide text-muted">
            Your visits
          </h2>
          <ul className="mt-3 divide-y divide-line border-t border-line">
            {me.past.map((visit) => (
              <li key={visit.id} className="flex items-baseline justify-between gap-4 py-3">
                <div>
                  <p className="text-[15px] font-medium">{visit.serviceName}</p>
                  <p className="text-[14px] text-muted">
                    {formatDay(visit.startsAt, me.timezone)} · {visit.staffName}
                  </p>
                </div>
                <span className="shrink-0 text-[14px] text-muted">
                  {visit.status === BOOKING_STATUS.NO_SHOW
                    ? 'Missed'
                    : formatPrice(visit.priceMinor)}
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}

      <InstallHint />

      <footer className="mt-10 border-t border-line pt-6 text-[13px] text-muted">
        <p>
          Keep this private link safe. Verify WhatsApp above to change appointments or replace your
          link. You can also reply CANCEL or RESCHEDULE on WhatsApp.
        </p>
        <Link href={`/${me.businessSlug}`} className="mt-2 inline-block font-medium text-brand">
          {me.businessName} →
        </Link>
      </footer>
    </main>
  );
}

/** The one thing most visits to this page are for. */
function NextUp({ appointment, timezone }: { appointment: MeAppointment; timezone: string }) {
  return (
    <section className="mt-6 rounded-2xl border border-line bg-surface p-6">
      <p className="text-[13px] font-semibold uppercase tracking-wide text-muted">Next up</p>
      <p className="mt-2 text-[22px] font-bold leading-tight tracking-[-0.02em]">
        {formatWhen(appointment.startsAt, timezone)}
      </p>
      <p className="mt-1 text-[16px]">
        {appointment.serviceName} with {appointment.staffName}
      </p>
      <p className="mt-1 text-[15px] text-muted">
        {formatDuration(appointment.durationMinutes)} · {formatPrice(appointment.priceMinor)}
      </p>
      <DepositNudge appointment={appointment} />
      <ApprovalNudge appointment={appointment} />
      {appointment.appointmentHolderName && (
        <p className="mt-2 text-sm">Appointment for {appointment.appointmentHolderName}</p>
      )}
    </section>
  );
}

/** Pending requests need the same clear label in next-up and later cards. */
function ApprovalNudge({ appointment }: { appointment: MeAppointment }) {
  if (appointment.status !== BOOKING_STATUS.AWAITING_APPROVAL) return null;
  return (
    <p className="mt-3 text-sm font-semibold">
      Awaiting owner approval. This appointment is not confirmed yet.
    </p>
  );
}

/** Only offer payment while the backend says a deposit is actually owed. */
function DepositNudge({ appointment }: { appointment: MeAppointment }) {
  if (appointment.status !== BOOKING_STATUS.AWAITING_DEPOSIT || !appointment.depositToken)
    return null;

  return (
    <Link
      href={`/pay/${appointment.depositToken}`}
      className="mt-4 inline-flex h-11 items-center rounded-full bg-ink px-5 text-[15px] font-semibold text-white hover:bg-black/80"
    >
      Pay the deposit to secure it
    </Link>
  );
}

/**
 * Standing history. Points are derived from completed spend rather than kept in
 * a ledger (see shared/types/me.ts), so this panel can never disagree with the
 * visits listed below it.
 */
function Loyalty({ me }: { me: MeView }) {
  if (me.loyalty.visits === 0) return null;

  return (
    <section className="mt-10 rounded-2xl border border-line p-6">
      <div className="flex items-baseline justify-between gap-4">
        <div>
          <p className="text-[13px] font-semibold uppercase tracking-wide text-muted">
            Your points
          </p>
          <p className="mt-1 text-[32px] font-bold leading-none tracking-[-0.02em] text-brand">
            {me.loyalty.points.toLocaleString('en-PK')}
          </p>
        </div>
        <p className="text-right text-[14px] text-muted">
          {me.loyalty.visits} {me.loyalty.visits === 1 ? 'visit' : 'visits'}
          {me.loyalty.memberSince && (
            <>
              <br />
              since {formatDay(me.loyalty.memberSince, me.timezone)}
            </>
          )}
        </p>
      </div>
      <p className="mt-4 text-[14px] text-muted">
        You earn a point for every {formatPrice(LOYALTY_MINOR_PER_POINT)} you spend at{' '}
        {me.businessName}.
      </p>
    </section>
  );
}
