import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { DEPOSIT_STATUS, type DepositView } from '@scalivo/shared';
import { SiteHeader } from '@/components/SiteHeader';
import { CheckIcon } from '@/components/Icons';
import { PayDepositButton } from '@/components/PayDepositButton';
import { formatPrice } from '@/lib/format';
import { API_BASE } from '@/lib/site';

/**
 * The deposit page — where the WhatsApp link and the web booking both land,
 * and where the gateway sends the customer back after paying.
 *
 * Rendered fresh every time: this page IS the payment result. A cached copy
 * would show "pay now" to someone who just paid.
 */

export const dynamic = 'force-dynamic';

// A payment link is personal; nothing here belongs in a search index.
export const metadata: Metadata = { title: 'Pay deposit', robots: { index: false, follow: false } };

async function load(token: string): Promise<DepositView | null> {
  const res = await fetch(`${API_BASE}/public/deposits/${encodeURIComponent(token)}`, { cache: 'no-store' });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`deposit lookup failed: ${res.status}`);
  return (await res.json()) as DepositView;
}

export default async function PayDepositPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const deposit = await load(token);
  if (!deposit) notFound();

  const when = new Intl.DateTimeFormat('en-GB', {
    timeZone: deposit.timezone,
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    hour: 'numeric',
    minute: '2-digit',
    // 12-hour with am/pm: "until 3:31" at night reads as the afternoon.
    hour12: true,
  }).format(new Date(deposit.startsAt));
  const clock = (iso: string) =>
    new Intl.DateTimeFormat('en-GB', { timeZone: deposit.timezone, hour: 'numeric', minute: '2-digit', hour12: true }).format(
      new Date(iso),
    );

  const payable =
    deposit.status === DEPOSIT_STATUS.AWAITING && deposit.dueBy !== null && new Date(deposit.dueBy) > new Date();
  const secured = deposit.status === DEPOSIT_STATUS.PAID || deposit.status === DEPOSIT_STATUS.APPLIED;

  return (
    <>
      <SiteHeader />
      <main className="mx-auto max-w-[560px] px-5 pb-20 pt-10 md:pt-16">
        <div className="rounded-2xl border border-line p-6 md:p-8" aria-live="polite">
          {secured ? (
            <>
              <span className="flex h-12 w-12 items-center justify-center rounded-full bg-open text-white">
                <CheckIcon className="h-6 w-6" />
              </span>
              <h1 className="mt-5 text-[26px] font-bold tracking-[-0.02em]">You&rsquo;re booked</h1>
              <p className="mt-1 text-[15px] text-muted">
                Deposit of {formatPrice(deposit.depositMinor)} received. The confirmation is on its way to your
                WhatsApp.
              </p>
            </>
          ) : payable ? (
            <>
              <p className="text-[14px] font-semibold text-muted">Almost booked</p>
              <h1 className="mt-1 text-[26px] font-bold tracking-[-0.02em]">
                Pay {formatPrice(deposit.depositMinor)} to secure your slot
              </h1>
              <p className="mt-2 text-[15px] text-muted">
                We&rsquo;re holding it until <strong className="text-ink">{clock(deposit.dueBy!)}</strong>. After that
                the time is released to other customers.
              </p>
            </>
          ) : (
            <>
              <h1 className="text-[26px] font-bold tracking-[-0.02em]">{closedHeading(deposit)}</h1>
              <p className="mt-2 text-[15px] text-muted">{closedBody(deposit)}</p>
            </>
          )}

          <dl className="mt-6 space-y-3 border-t border-line pt-6 text-[15px]">
            <Row label="Service" value={deposit.serviceName} />
            {deposit.staffName && <Row label="With" value={deposit.staffName} />}
            <Row label="When" value={when} />
            <Row label="At" value={deposit.businessName} />
            <Row label="Deposit" value={formatPrice(deposit.depositMinor)} />
            <Row label="Balance, paid in person" value={formatPrice(Math.max(0, deposit.priceMinor - deposit.depositMinor))} />
          </dl>

          {payable && (
            <div className="mt-8">
              <PayDepositButton token={token} amountLabel={formatPrice(deposit.depositMinor)} />
              <p className="mt-3 text-[13px] text-muted">
                You&rsquo;ll pay on the payment provider&rsquo;s secure page and come straight back here. Cancel at least a day
                ahead and the deposit is refunded.
              </p>
            </div>
          )}

          {!payable && !secured && (
            <Link
              href={`/${deposit.businessSlug}`}
              className="mt-8 inline-flex h-12 items-center rounded-full bg-ink px-6 text-[16px] font-semibold text-white hover:bg-black/80"
            >
              Book again at {deposit.businessName}
            </Link>
          )}
        </div>
      </main>
    </>
  );
}

function closedHeading(deposit: DepositView): string {
  switch (deposit.status) {
    case DEPOSIT_STATUS.REFUNDED:
      return 'Deposit refunded';
    case DEPOSIT_STATUS.RETAINED:
      return 'This appointment has closed';
    case DEPOSIT_STATUS.TRANSFERRED:
      return 'This booking was moved';
    default:
      return 'This hold has expired';
  }
}

function closedBody(deposit: DepositView): string {
  switch (deposit.status) {
    case DEPOSIT_STATUS.REFUNDED:
      return `Your ${formatPrice(deposit.depositMinor)} deposit has been sent back.`;
    case DEPOSIT_STATUS.RETAINED:
      return 'The deposit was kept under the cancellation policy. Contact the business if you think that is wrong.';
    case DEPOSIT_STATUS.TRANSFERRED:
      return 'Your deposit went with it to the new time — check your WhatsApp for the details.';
    default:
      return deposit.refunded
        ? 'The deposit arrived after the slot was released, so it is being refunded in full.'
        : 'The deposit was not received in time, so the slot was released. Nothing was charged.';
  }
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline justify-between gap-4">
      <dt className="text-muted">{label}</dt>
      <dd className="text-right font-medium text-ink">{value}</dd>
    </div>
  );
}
