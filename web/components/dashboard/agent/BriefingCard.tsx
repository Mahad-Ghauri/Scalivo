'use client';

import { useState, useTransition } from 'react';
import Link from 'next/link';
import { BRIEFING_KIND, PHRASED_BY, type Briefing } from '@scalivo/shared';
import { markBriefingReadAction } from '@/app/(dashboard)/dashboard/[businessId]/briefings/actions';
import { briefingLabel, briefingWhen } from '@/lib/agent';

/**
 * One thing the agent said — SPEC §11.
 *
 * Its own file because it is used in two places that must agree: the Overview,
 * where the newest one sits at the top of the page an owner lands on, and the
 * archive behind it. A second copy of this card would eventually let the two
 * disagree about what "read" means.
 *
 * Marked read on an explicit gesture — opening an action, or saying so — never on
 * render. A briefing that marks itself read when the dashboard happens to load
 * destroys the only signal the Learning Layer (3.4) has to learn from, and it is
 * a signal that cannot be recovered afterwards.
 */
export function BriefingCard({
  businessId,
  briefing,
  timezone,
}: {
  businessId: string;
  briefing: Briefing;
  timezone: string;
}) {
  const [pending, startTransition] = useTransition();
  const [read, setRead] = useState(briefing.readAt !== null);

  const isAlert = briefing.kind === BRIEFING_KIND.ALERT;

  function markRead() {
    if (read) return;
    setRead(true);
    startTransition(async () => {
      await markBriefingReadAction(businessId, briefing.id);
    });
  }

  return (
    <div
      className={`rounded-xl border p-5 ${
        read ? 'border-line bg-white' : 'border-brand/30 bg-brand/[0.03]'
      }`}
    >
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <p className="text-[13px] font-semibold uppercase tracking-wide text-muted">
          {briefingLabel(briefing.kind, briefing.alertType)}
          {isAlert && <span className="text-amber-700"> · needs you</span>}
        </p>
        <p className="text-[13px] text-muted">{briefingWhen(briefing.scheduledFor, timezone)}</p>
      </div>

      <h3 className="mt-1.5 text-[17px] font-semibold text-ink">{briefing.headline}</h3>
      <p className="mt-1.5 text-[15px] leading-relaxed text-ink">{briefing.body}</p>

      {briefing.actions.length > 0 && (
        <div className="mt-4 flex flex-wrap gap-2">
          {briefing.actions.map((action) => (
            <Link
              key={action.href}
              href={`/dashboard/${businessId}${action.href}`}
              onClick={markRead}
              className="inline-flex h-9 items-center rounded-full border border-line px-4 text-[14px] font-semibold text-ink hover:bg-surface"
            >
              {action.label}
            </Link>
          ))}
        </div>
      )}

      <div className="mt-4 flex flex-wrap items-center justify-between gap-3 border-t border-line pt-3">
        {/*
          Said out loud rather than hidden. The template is not a degraded mode —
          it IS the briefing, and the model only ever rewords it. An owner who can
          see which is which can also see that nothing was lost on the mornings the
          LLM was unavailable.
        */}
        <p className="text-[12px] text-muted">
          {briefing.phrasedBy === PHRASED_BY.GEMINI
            ? 'Written by Scalivo'
            : 'Written from your numbers'}
        </p>
        {!read && (
          <button
            type="button"
            onClick={markRead}
            disabled={pending}
            className="text-[13px] font-semibold text-brand hover:underline disabled:opacity-60"
          >
            Mark as read
          </button>
        )}
      </div>
    </div>
  );
}
