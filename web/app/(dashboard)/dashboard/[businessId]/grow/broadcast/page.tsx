import Link from 'next/link';
import {
  CAMPAIGN_AUDIENCE,
  isCampaignAudience,
  type AudiencePreview,
  type CampaignAudience,
  type CampaignSummary,
  type NudgeReport,
} from '@scalivo/shared';
import { fetchApi } from '@/lib/api-client';
import { BroadcastComposer } from '@/components/dashboard/grow/BroadcastComposer';
import { CampaignList } from '@/components/dashboard/grow/CampaignList';
import { NudgeToggle } from '@/components/dashboard/grow/NudgeToggle';
import { AUDIENCE_COPY } from '@/lib/retention';

/**
 * Winning customers back — SPEC §6.
 *
 * Two halves on one page, in the order they deserve attention: the automatic
 * nudges, which run on their own and are the bigger half by volume, and the
 * broadcast, which is the owner deliberately messaging a group.
 *
 * The broadcast is on its own page rather than a card on Grow for one reason: it
 * is the only action in the whole dashboard that cannot be undone and reaches
 * hundreds of real people. A confirmation step belongs on a screen of its own,
 * not squeezed between a QR code and a boost button.
 */

interface OwnerBusiness {
  name: string;
  timezone: string;
  whatsapp?: { sessionId?: string | null };
}

type PreviewResponse = AudiencePreview & { suggested: string };

export default async function BroadcastPage({
  params,
  searchParams,
}: {
  params: Promise<{ businessId: string }>;
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
}) {
  const { businessId } = await params;
  const { audience: audienceParam } = await searchParams;

  const audience: CampaignAudience = isCampaignAudience(audienceParam)
    ? audienceParam
    : CAMPAIGN_AUDIENCE.LAPSED;

  const business = await fetchApi<OwnerBusiness>(`/businesses/${businessId}`).catch(() => null);
  if (!business) {
    return <p className="py-12 text-center text-muted">Could not load your business. Please try refreshing.</p>;
  }

  const [preview, campaigns, nudges] = await Promise.all([
    fetchApi<PreviewResponse>(`/businesses/${businessId}/retention/audience`, {
      params: { audience },
    }).catch(() => null),
    fetchApi<{ campaigns: CampaignSummary[] }>(`/businesses/${businessId}/retention/campaigns`).catch(
      () => null,
    ),
    fetchApi<NudgeReport>(`/businesses/${businessId}/retention/nudges`).catch(() => null),
  ]);

  const connected = Boolean(business.whatsapp?.sessionId);
  const basePath = `/dashboard/${businessId}/grow`;

  return (
    <div className="space-y-6 py-2">
      <div>
        <Link href={basePath} className="text-[14px] font-semibold text-brand hover:underline">
          ← Grow
        </Link>
        <h1 className="mt-1 text-2xl font-bold tracking-tight text-ink lowercase font-display">win customers back</h1>
        <p className="mt-1 text-[15px] text-muted">
          Reach the customers who have stopped coming, automatically or with a message you write.
        </p>
      </div>

      {!connected && (
        <p className="rounded-xl border border-amber-200 bg-amber-50 px-5 py-4 text-[15px] text-amber-900">
          Connect your WhatsApp number in the Scalivo app before using either of these. Without it there is no number to
          send from.
        </p>
      )}

      {/* ------------------------------------------------ automatic nudges */}
      <section className="rounded-xl border border-line bg-white p-6 shadow-sm">
        <h2 className="text-[17px] font-semibold text-ink">Automatic reminders to rebook</h2>
        <p className="mt-0.5 text-[13px] text-muted">
          Each customer has their own rhythm: monthly, quarterly, twice a year. When someone is well past theirs, they
          get one message naming what they had last time.
        </p>
        <div className="mt-4">
          {nudges ? (
            <>
              <NudgeToggle businessId={businessId} enabled={nudges.enabled} />
              {nudges.outcome.sends > 0 && (
                <p className="mt-4 border-t border-line pt-4 text-[14px] text-muted">
                  Last {nudges.days} days: <strong className="font-semibold text-ink">{nudges.outcome.sends}</strong>{' '}
                  sent, <strong className="font-semibold text-ink">{nudges.outcome.delivered}</strong> arrived,{' '}
                  <strong className="font-semibold text-ink">{nudges.outcome.rebooked}</strong> booked afterwards
                  {nudges.outcome.optedOut > 0 ? `, ${nudges.outcome.optedOut} opted out` : ''}.
                </p>
              )}
            </>
          ) : (
            <p className="text-[14px] text-muted">Could not load your nudge settings.</p>
          )}
        </div>
      </section>

      {/* ----------------------------------------------------- a broadcast */}
      <section className="rounded-xl border border-line bg-white p-6 shadow-sm">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <h2 className="text-[17px] font-semibold text-ink">Send a message to a group</h2>
            <p className="mt-0.5 text-[13px] text-muted">{AUDIENCE_COPY[audience].who}.</p>
          </div>
          <div className="flex rounded-full border border-line p-1" role="group" aria-label="Who to message">
            {[CAMPAIGN_AUDIENCE.LAPSED, CAMPAIGN_AUDIENCE.AT_RISK].map((option) => (
              <Link
                key={option}
                href={`${basePath}/broadcast?audience=${option}`}
                aria-current={audience === option ? 'page' : undefined}
                className={`rounded-full px-3.5 py-1.5 text-[14px] font-medium ${
                  audience === option ? 'bg-ink text-white' : 'text-muted hover:text-ink'
                }`}
              >
                {AUDIENCE_COPY[option].label}
              </Link>
            ))}
          </div>
        </div>

        {preview ? (
          <>
            <dl className="mt-5 grid grid-cols-2 gap-4 sm:grid-cols-3">
              <Figure label="In this group" value={preview.matched} />
              <Figure label="Can be messaged" value={preview.reachable} emphasis />
              <Figure label="Never messaged you" value={preview.coldContacts} muted />
            </dl>

            <div className="mt-6 border-t border-line pt-6">
              <BroadcastComposer
                businessId={businessId}
                audience={audience}
                preview={preview}
                suggested={preview.suggested}
              />
            </div>
          </>
        ) : (
          <p className="mt-5 text-[14px] text-muted">Could not work out who is in this group.</p>
        )}
      </section>

      {/* ------------------------------------------------------- what happened */}
      <section className="rounded-xl border border-line bg-white p-6 shadow-sm">
        <h2 className="text-[17px] font-semibold text-ink">Broadcasts you have sent</h2>
        <p className="mt-0.5 text-[13px] text-muted">
          &ldquo;Arrived&rdquo; means WhatsApp confirmed delivery. Anything else was handed over and never confirmed,
          which is what happens to people who have never messaged your number.
        </p>
        <div className="mt-5">
          {campaigns ? (
            <CampaignList businessId={businessId} campaigns={campaigns.campaigns} />
          ) : (
            <p className="text-[14px] text-muted">Could not load your broadcasts.</p>
          )}
        </div>
      </section>
    </div>
  );
}

function Figure({
  label,
  value,
  emphasis,
  muted,
}: {
  label: string;
  value: number;
  emphasis?: boolean;
  muted?: boolean;
}) {
  return (
    <div className="rounded-lg bg-surface px-4 py-3">
      <dt className="text-[13px] text-muted">{label}</dt>
      <dd
        className={`mt-0.5 text-[22px] font-bold tabular-nums ${
          muted ? 'text-muted' : emphasis ? 'text-brand' : 'text-ink'
        }`}
      >
        {value}
      </dd>
    </div>
  );
}
