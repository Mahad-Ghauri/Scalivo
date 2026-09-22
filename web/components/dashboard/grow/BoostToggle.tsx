'use client';

import { useState, useTransition } from 'react';
import Link from 'next/link';
import { BOOST_DAYS, type BoostState } from '@scalivo/shared';
import { setBoostAction } from '@/app/(dashboard)/dashboard/[businessId]/grow/actions';

export function BoostToggle({
  businessId,
  boost,
  published,
  timezone,
}: {
  businessId: string;
  boost: BoostState;
  published: boolean;
  timezone: string;
}) {
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  const until = boost.until
    ? new Intl.DateTimeFormat('en-GB', { timeZone: timezone, weekday: 'long', day: 'numeric', month: 'long' }).format(
        new Date(boost.until),
      )
    : null;

  function set(on: boolean) {
    setError(null);
    startTransition(async () => {
      const result = await setBoostAction(businessId, on);
      if (!result.ok) setError(result.error);
    });
  }

  if (!published) {
    return (
      <p className="text-[14px] text-muted">
        Your listing is hidden from search, so there is nothing to boost yet.{' '}
        <Link href={`/dashboard/${businessId}/settings`} className="font-semibold text-brand hover:underline">
          Publish it in Settings
        </Link>
      </p>
    );
  }

  return (
    <div>
      {boost.active ? (
        <p className="text-[15px] text-ink">
          <span className="font-semibold text-open">Featured</span> at the top of search until {until}.
        </p>
      ) : (
        <p className="text-[15px] text-ink">
          Show up first when customers search your category and city, for {BOOST_DAYS} days.
        </p>
      )}
      <div className="mt-4 flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={() => set(true)}
          disabled={pending}
          className="inline-flex h-10 items-center rounded-full bg-ink px-5 text-[15px] font-semibold text-white hover:bg-black/80 disabled:opacity-60"
        >
          {pending ? 'Saving…' : boost.active ? `Restart for ${BOOST_DAYS} days` : `Boost for ${BOOST_DAYS} days`}
        </button>
        {boost.active && (
          <button
            type="button"
            onClick={() => set(false)}
            disabled={pending}
            className="inline-flex h-10 items-center rounded-full border border-line px-5 text-[15px] font-semibold text-ink hover:bg-surface disabled:opacity-60"
          >
            Stop boost
          </button>
        )}
      </div>
      <p className="mt-3 text-[13px] text-muted">
        Customers see a &ldquo;Featured&rdquo; label on your listing. It only changes your position among businesses that
        match what they searched for. Search updates within a few minutes.
      </p>
      {error && (
        <p role="alert" className="mt-3 text-[14px] text-red-600">
          {error}
        </p>
      )}
    </div>
  );
}
