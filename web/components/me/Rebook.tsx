'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import type { MeUsual, PublicBookingReceipt, PublicHold, PublicSlot } from '@scalivo/shared';

import { CheckIcon } from '@/components/Icons';
import { formatClock, formatDuration, formatPrice } from '@/lib/format';
import { API_BASE } from '@/lib/site';

/**
 * Booking the usual again.
 *
 * "One tap" in the DoD's sense is about what the customer does NOT do: they
 * never pick a service, never pick a staff member, never type a name or a phone
 * number, and never log in. The page already knows all of it — the service and
 * stylist come from their own history, the identity from the token in the URL.
 * What is left is choosing a time, and nothing can remove that.
 *
 * Deliberately thin, exactly like BookingFlow: this component asks for free
 * times and posts a choice. It never decides a slot is free. The hold and the
 * occupancy transaction behind it are the same ones WhatsApp books through, so
 * a rebook here cannot double-book against a walk-in typed at the counter.
 */

/** A week is enough for "same again". Somebody planning further ahead wants the full booking flow. */
const DAYS_SHOWN = 7;

interface Props {
  token: string;
  usual: MeUsual | null;
  timezone: string;
  businessSlug: string;
  verificationProof: string;
  appointmentHolderId?: string | undefined;
}

type ApiError = { error?: string; reason?: string };

async function call<T>(
  token: string,
  path: string,
  init?: RequestInit,
): Promise<{ ok: true; data: T } | { ok: false; body: ApiError }> {
  try {
    const response = await fetch(`${API_BASE}/public/me/${encodeURIComponent(token)}${path}`, {
      ...init,
      signal: AbortSignal.timeout(15000),
      cache: 'no-store',
      headers: {
        accept: 'application/json',
        ...(init?.body ? { 'content-type': 'application/json' } : {}),
      },
    });
    const body = await response.json().catch(() => ({}));
    return response.ok ? { ok: true, data: body as T } : { ok: false, body: body as ApiError };
  } catch {
    return {
      ok: false,
      body: { error: 'Could not reach Scalivo. Check your connection and try again.' },
    };
  }
}

/** Business-local calendar dates starting today in THEIR zone, not the reader's. */
function upcomingDates(timezone: string, count: number): string[] {
  const today = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());
  const [y, m, d] = today.split('-').map(Number);
  return Array.from({ length: count }, (_, i) =>
    new Date(Date.UTC(y!, m! - 1, d! + i)).toISOString().slice(0, 10),
  );
}

const dayLabel = (date: string, timezone: string, index: number): string => {
  if (index === 0) return 'Today';
  if (index === 1) return 'Tomorrow';
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: timezone,
    weekday: 'short',
    day: 'numeric',
  }).format(new Date(`${date}T12:00:00Z`));
};

export function Rebook({
  token,
  usual,
  timezone,
  businessSlug,
  verificationProof,
  appointmentHolderId,
}: Props) {
  const dates = upcomingDates(timezone, DAYS_SHOWN);
  const [date, setDate] = useState(dates[0]!);
  const [slots, setSlots] = useState<PublicSlot[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [booked, setBooked] = useState<PublicBookingReceipt | null>(null);

  const loadSlots = useCallback(async () => {
    if (!usual) return;
    setSlots(null);
    setError(null);

    const query = new URLSearchParams({ serviceId: usual.serviceId, date });
    // Their usual person when they have one; anybody qualified when they do not.
    if (usual.staffId) query.set('staffId', usual.staffId);

    const result = await call<{ slots: PublicSlot[] }>(token, `/availability?${query}`);
    if (!result.ok) {
      setError(result.body.error ?? 'Could not load times.');
      setSlots([]);
      return;
    }
    setSlots(result.data.slots);
  }, [date, token, usual]);

  useEffect(() => {
    void loadSlots();
  }, [loadSlots]);

  /**
   * Hold, then book — two calls, as the public flow does.
   *
   * The hold is not a formality: it is what stops the slot going to somebody
   * else between the tap and the write, and its token is what proves at booking
   * time that this caller is the one holding it.
   */
  const take = async (slot: PublicSlot) => {
    if (!usual || busy) return;
    setBusy(true);
    setError(null);

    const hold = await call<PublicHold>(token, '/holds', {
      method: 'POST',
      signal: AbortSignal.timeout(15000),
      body: JSON.stringify({
        serviceId: usual.serviceId,
        staffId: slot.staffId,
        startsAt: slot.startsAt,
      }),
    });
    if (!hold.ok) {
      setError(hold.body.error ?? 'That time just went.');
      setBusy(false);
      void loadSlots();
      return;
    }

    const receipt = await call<PublicBookingReceipt>(token, '/bookings', {
      method: 'POST',
      signal: AbortSignal.timeout(15000),
      body: JSON.stringify({
        serviceId: usual.serviceId,
        staffId: hold.data.staffId,
        startsAt: hold.data.startsAt,
        holdToken: hold.data.token,
        verificationProof,
        appointmentHolderId,
      }),
    });
    setBusy(false);

    if (!receipt.ok) {
      setError(receipt.body.error ?? 'That time just went.');
      void loadSlots();
      return;
    }
    setBooked(receipt.data);
  };

  /**
   * No usual service: either they have never completed a visit, or everything
   * they used to book has been retired. Both cases are the same offer — the
   * business's own page, where every service is listed.
   */
  if (!usual) {
    return (
      <section className="mt-10 rounded-2xl border border-line p-6">
        <h2 className="text-[18px] font-bold tracking-[-0.02em]">Book again</h2>
        <p className="mt-1 text-[15px] text-muted">
          Pick a service and a time on the booking page.
        </p>
        <Link
          href={`/${businessSlug}`}
          className="mt-4 inline-flex h-12 items-center rounded-full bg-ink px-6 text-[16px] font-semibold text-white hover:bg-black/80"
        >
          See what&rsquo;s available
        </Link>
      </section>
    );
  }

  if (booked) {
    return (
      <section className="mt-10 rounded-2xl border border-line p-6" aria-live="polite">
        <span className="flex h-12 w-12 items-center justify-center rounded-full bg-open text-white">
          <CheckIcon className="h-6 w-6" />
        </span>
        <h2 className="mt-4 text-[20px] font-bold tracking-[-0.02em]">
          {booked.status === 'awaiting_approval'
            ? 'Request received, awaiting approval'
            : booked.status === 'confirmed'
              ? 'You’re booked'
              : 'Appointment saved, confirmation pending'}
        </h2>
        <p className="mt-1 text-[15px] text-muted">
          {booked.serviceName} with {booked.staffName}, {formatClock(booked.startsAt, timezone)}.
          The confirmation is on its way to your WhatsApp.
        </p>
        {/*
          A full reload rather than patching the list in place: the booking has
          changed the next appointment, the visit history and the points, and
          re-reading is the only way all three are right.
        */}
        <button
          type="button"
          onClick={() => window.location.reload()}
          className="mt-5 inline-flex h-11 items-center rounded-full border border-line px-5 text-[15px] font-semibold hover:bg-surface"
        >
          Refresh my appointments
        </button>
      </section>
    );
  }

  return (
    <section className="mt-10">
      <h2 className="text-[18px] font-bold tracking-[-0.02em]">Book it again</h2>
      <p className="mt-1 text-[15px] text-muted">
        {usual.serviceName}
        {usual.staffName ? ` with ${usual.staffName}` : ''} ·{' '}
        {formatDuration(usual.durationMinutes)} · {formatPrice(usual.priceMinor)}
      </p>

      {/* Horizontally scrolling day strip: seven taps' worth of choice on a phone. */}
      <div className="mt-4 -mx-5 flex gap-2 overflow-x-auto px-5 pb-1">
        {dates.map((value, index) => (
          <button
            key={value}
            type="button"
            onClick={() => setDate(value)}
            aria-pressed={value === date}
            className={`h-10 shrink-0 rounded-full border px-4 text-[14px] font-medium ${
              value === date ? 'border-ink bg-ink text-white' : 'border-line hover:bg-surface'
            }`}
          >
            {dayLabel(value, timezone, index)}
          </button>
        ))}
      </div>

      <div className="mt-4" aria-live="polite">
        {slots === null ? (
          <p className="text-[15px] text-muted">Looking for free times…</p>
        ) : slots.length === 0 ? (
          <p className="text-[15px] text-muted">Nothing free that day. Try another.</p>
        ) : (
          <div className="flex flex-wrap gap-2">
            {slots.map((slot) => (
              <button
                key={`${slot.startsAt}-${slot.staffId}`}
                type="button"
                disabled={busy}
                onClick={() => void take(slot)}
                className="h-11 rounded-full border border-line px-4 text-[15px] font-medium hover:border-ink hover:bg-surface disabled:opacity-50"
              >
                {formatClock(slot.startsAt, timezone)}
              </button>
            ))}
          </div>
        )}
      </div>

      {error && (
        <p className="mt-3 text-[14px] font-medium text-ink" role="alert">
          {error}
        </p>
      )}
    </section>
  );
}
