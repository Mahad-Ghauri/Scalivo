'use client';

import { useState, useTransition } from 'react';
import { CAMPAIGN_STATUS, type CampaignSummary } from '@scalivo/shared';
import { cancelBroadcastAction } from '@/app/(dashboard)/dashboard/[businessId]/grow/actions';
import { AUDIENCE_COPY } from '@/lib/retention';

/**
 * What the broadcasts actually did — SPEC §6.3.
 *
 * Written to resist the one reading an owner wants and the data cannot support:
 * that a sent message is a received message. So "Arrived" is ack-backed and
 * "No answer from WhatsApp" sits next to it with the same weight, because the
 * gap between them IS the finding (FINDING #3) rather than an embarrassment to
 * round away. `Rebooked` is labelled as following the message, not as caused by
 * it — a two-week window is attribution, not proof.
 */
export function CampaignList({
  businessId,
  campaigns,
}: {
  businessId: string;
  campaigns: CampaignSummary[];
}) {
  if (campaigns.length === 0) {
    return <p className="text-[15px] text-muted">You have not sent a broadcast yet.</p>;
  }

  return (
    <ul className="space-y-4">
      {campaigns.map((campaign) => (
        <Row key={campaign.id} businessId={businessId} campaign={campaign} />
      ))}
    </ul>
  );
}

function Row({ businessId, campaign }: { businessId: string; campaign: CampaignSummary }) {
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const { outcome } = campaign;
  const sending = campaign.status === CAMPAIGN_STATUS.SENDING;

  const sent = new Date(campaign.createdAt).toLocaleDateString('en-GB', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  });

  function stop() {
    setError(null);
    startTransition(async () => {
      const result = await cancelBroadcastAction(businessId, campaign.id);
      if (!result.ok) setError(result.error);
    });
  }

  return (
    <li className="rounded-lg border border-line p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="text-[15px] font-semibold text-ink">
            {AUDIENCE_COPY[campaign.audience]?.label ?? campaign.audience} · {campaign.targeted}{' '}
            {campaign.targeted === 1 ? 'person' : 'people'}
          </p>
          <p className="mt-0.5 text-[13px] text-muted">
            {sent} ·{' '}
            {sending
              ? `sending — ${outcome.sends} of ${campaign.targeted} so far`
              : campaign.status === CAMPAIGN_STATUS.CANCELLED
                ? `stopped after ${outcome.sends}`
                : 'finished'}
          </p>
        </div>
        {sending && (
          <button
            type="button"
            onClick={stop}
            disabled={pending}
            className="inline-flex h-9 items-center rounded-full border border-line px-4 text-[14px] font-semibold text-ink hover:bg-surface disabled:opacity-60"
          >
            {pending ? 'Stopping…' : 'Stop sending'}
          </button>
        )}
      </div>

      <p className="mt-3 whitespace-pre-line rounded-lg bg-surface px-3.5 py-3 text-[14px] text-ink">
        {campaign.message}
      </p>

      <dl className="mt-3 grid grid-cols-2 gap-x-4 gap-y-2 text-[14px] sm:grid-cols-4">
        <Stat label="Arrived" value={outcome.delivered} />
        <Stat label="No answer from WhatsApp" value={outcome.undelivered} muted />
        <Stat label="Replied" value={outcome.replied} />
        <Stat label="Booked after it" value={outcome.rebooked} />
      </dl>

      {(outcome.queued > 0 || outcome.skipped > 0 || outcome.optedOut > 0) && (
        <p className="mt-2.5 text-[13px] text-muted">
          {[
            outcome.queued > 0 ? `${outcome.queued} waiting for your number to reconnect` : null,
            outcome.skipped > 0 ? `${outcome.skipped} not sent` : null,
            outcome.optedOut > 0 ? `${outcome.optedOut} opted out` : null,
          ]
            .filter(Boolean)
            .join(' · ')}
        </p>
      )}

      {error && (
        <p role="alert" className="mt-2.5 text-[14px] text-red-600">
          {error}
        </p>
      )}
    </li>
  );
}

function Stat({ label, value, muted }: { label: string; value: number; muted?: boolean }) {
  return (
    <div>
      <dt className="text-[13px] text-muted">{label}</dt>
      <dd className={`text-[17px] font-semibold tabular-nums ${muted ? 'text-muted' : 'text-ink'}`}>{value}</dd>
    </div>
  );
}
