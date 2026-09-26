'use client';

import { useState, useTransition } from 'react';
import { CAMPAIGN_MESSAGE_MAX, MARKETING_QUIET_DAYS, type AudiencePreview, type CampaignAudience } from '@scalivo/shared';
import { sendBroadcastAction } from '@/app/(dashboard)/dashboard/[businessId]/grow/actions';

/**
 * Writing and sending a win-back broadcast — SPEC §6.2.
 *
 * The design problem here is not the form, it is the confirmation. This sends a
 * WhatsApp message to a few hundred real people and there is no unsending it, so
 * the interface has two jobs before it has any others: say exactly how many
 * people will receive this, and make the owner type the number to prove they
 * read it. Everything else on the screen is subordinate to that.
 *
 * The count comes from the server and is deliberately the SMALLER, honest number
 * — reachable, not matched. An owner who is told 212 and sees 178 sends assumes
 * something broke.
 */

export function BroadcastComposer({
  businessId,
  audience,
  preview,
  suggested,
}: {
  businessId: string;
  audience: CampaignAudience;
  preview: AudiencePreview;
  suggested: string;
}) {
  const [message, setMessage] = useState(suggested);
  const [confirming, setConfirming] = useState(false);
  const [typed, setTyped] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [sentTo, setSentTo] = useState<number | null>(null);
  const [pending, startTransition] = useTransition();

  const { reachable, coldContacts, remainingToday } = preview;
  const today = Math.min(reachable, remainingToday.total);
  const tooShort = message.trim().length < 10;

  function send() {
    setError(null);
    startTransition(async () => {
      const result = await sendBroadcastAction(businessId, audience, message.trim());
      if (result.ok) {
        setSentTo(result.recipients);
        setConfirming(false);
        setTyped('');
      } else {
        setError(result.error);
      }
    });
  }

  if (sentTo !== null) {
    return (
      <div className="rounded-lg border border-line bg-surface px-5 py-4">
        <p className="text-[15px] font-semibold text-ink">Sending to {sentTo} people</p>
        <p className="mt-1 text-[14px] text-muted">
          Messages go out gradually over the next few hours — spread out on purpose, so WhatsApp does not treat your
          number as a bulk sender. You can follow the results below.
        </p>
      </div>
    );
  }

  if (reachable === 0) {
    return (
      <p className="text-[15px] text-muted">
        Nobody in this group can be messaged right now. {explainEmpty(preview)}
      </p>
    );
  }

  return (
    <div>
      <label htmlFor="broadcast" className="block text-[14px] font-medium text-ink">
        Your message
      </label>
      <textarea
        id="broadcast"
        value={message}
        onChange={(event) => setMessage(event.target.value.slice(0, CAMPAIGN_MESSAGE_MAX))}
        rows={5}
        className="mt-2 w-full rounded-lg border border-line px-3.5 py-3 text-[15px] text-ink focus:border-brand focus:outline-none"
      />
      <div className="mt-1.5 flex flex-wrap justify-between gap-2 text-[13px] text-muted">
        <span>
          &ldquo;Reply STOP to stop these messages&rdquo; is added for you. Customers who reply BOOK get your booking
          menu.
        </span>
        <span className="tabular-nums">
          {message.length}/{CAMPAIGN_MESSAGE_MAX}
        </span>
      </div>

      {!confirming ? (
        <button
          type="button"
          onClick={() => setConfirming(true)}
          disabled={tooShort}
          className="mt-5 inline-flex h-11 items-center rounded-full bg-ink px-6 text-[15px] font-semibold text-white hover:bg-black/80 disabled:opacity-60"
        >
          Review and send
        </button>
      ) : (
        <div className="mt-5 rounded-lg border border-line bg-surface px-5 py-4">
          <p className="text-[15px] font-semibold text-ink">
            This sends a WhatsApp message to {reachable} {reachable === 1 ? 'person' : 'people'}.
          </p>
          <p className="mt-1 text-[14px] text-muted">
            It cannot be undone. {today < reachable ? `About ${today} today and the rest tomorrow. ` : ''}
            {coldContacts > 0 ? coldWarning(coldContacts) : ''}
          </p>

          <label htmlFor="confirm" className="mt-4 block text-[14px] font-medium text-ink">
            Type {reachable} to confirm
          </label>
          <input
            id="confirm"
            value={typed}
            onChange={(event) => setTyped(event.target.value)}
            inputMode="numeric"
            className="mt-1.5 h-10 w-28 rounded-lg border border-line px-3 text-[15px] tabular-nums text-ink focus:border-brand focus:outline-none"
          />

          <div className="mt-4 flex flex-wrap gap-2">
            <button
              type="button"
              onClick={send}
              disabled={pending || typed.trim() !== String(reachable)}
              className="inline-flex h-10 items-center rounded-full bg-ink px-5 text-[15px] font-semibold text-white hover:bg-black/80 disabled:opacity-60"
            >
              {pending ? 'Sending…' : 'Send now'}
            </button>
            <button
              type="button"
              onClick={() => {
                setConfirming(false);
                setTyped('');
              }}
              disabled={pending}
              className="inline-flex h-10 items-center rounded-full border border-line px-5 text-[15px] font-semibold text-ink hover:bg-white disabled:opacity-60"
            >
              Back
            </button>
          </div>
        </div>
      )}

      {error && (
        <p role="alert" className="mt-3 text-[14px] text-red-600">
          {error}
        </p>
      )}
    </div>
  );
}

/**
 * Why a group with people in it can still have nobody to message.
 *
 * Named rather than left as a shrug: every one of these is a decision the system
 * made on the owner's behalf, and an unexplained zero looks like a bug.
 */
function explainEmpty(preview: AudiencePreview): string {
  const { matched, excluded } = preview;
  if (matched === 0) return 'Nobody falls into this group yet.';

  const parts: string[] = [];
  if (excluded.optedOut > 0) parts.push(`${excluded.optedOut} asked not to receive offers`);
  if (excluded.recentlyMessaged > 0)
    parts.push(`${excluded.recentlyMessaged} heard from you in the last ${MARKETING_QUIET_DAYS} days`);
  if (excluded.noAddress > 0) parts.push(`${excluded.noAddress} have no phone number saved`);

  return parts.length > 0 ? `Of ${matched}, ${parts.join(', ')}.` : '';
}

/**
 * The cold-contact warning, in the owner's terms.
 *
 * This is FINDING #3 made visible: WhatsApp can silently discard a business's
 * first message to someone who has never messaged that number, while the API
 * reports success. An owner who sends to 40 people and hears back from 9 deserves
 * to have known which of them were a gamble — before sending, not after.
 */
function coldWarning(cold: number): string {
  return `${cold} of them have never messaged your WhatsApp number, so WhatsApp may not deliver to them — the results below will show which did arrive.`;
}
