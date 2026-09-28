'use client';

import { useState } from 'react';
import { REVIEW_COMMENT_MAX_LENGTH, REVIEW_PUBLISH_MIN_RATING, type MePendingReview } from '@scalivo/shared';

import { formatDay } from '@/lib/format';
import { API_BASE } from '@/lib/site';

/**
 * The review screen — the same question WhatsApp asks (SPEC §9.1), surviving on
 * a surface the customer came to anyway.
 *
 * It does not replace the WhatsApp request and is not a second ask: whichever
 * one is answered first records the rating, and the other becomes a no-op,
 * because `recordRating` is keyed on the booking. A customer who rated here and
 * then types `4` on WhatsApp gets the fourth service, not a duplicate rating —
 * the backend disarms the pending prompt when this posts.
 *
 * The comment box appears only for 4 and 5. That is the published band
 * (REVIEW_PUBLISH_MIN_RATING), and asking a disappointed customer to write
 * something for a public profile is asking them to do the business a favour at
 * the worst possible moment. Their rating still reaches the owner privately.
 */

interface Props {
  token: string;
  pending: MePendingReview;
  timezone: string;
}

const STARS = [1, 2, 3, 4, 5] as const;

export function RateVisit({ token, pending, timezone }: Props) {
  const [rating, setRating] = useState<number | null>(null);
  const [comment, setComment] = useState('');
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (value: number, text?: string) => {
    setBusy(true);
    setError(null);
    try {
      const response = await fetch(`${API_BASE}/public/me/${encodeURIComponent(token)}/reviews`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify({
          bookingId: pending.bookingId,
          rating: value,
          ...(text?.trim() ? { comment: text.trim() } : {}),
        }),
      });
      if (!response.ok) throw new Error(String(response.status));
      setDone(true);
    } catch {
      setError('That did not save. Try again in a moment.');
    } finally {
      setBusy(false);
    }
  };

  if (done) {
    return (
      <section className="mt-8 rounded-2xl border border-line p-6" aria-live="polite">
        <p className="text-[16px] font-semibold">Thank you — that helps.</p>
      </section>
    );
  }

  return (
    <section className="mt-8 rounded-2xl border border-line p-6">
      <h2 className="text-[18px] font-bold tracking-[-0.02em]">How was your {pending.serviceName}?</h2>
      <p className="mt-1 text-[15px] text-muted">{formatDay(pending.visitedAt, timezone)}</p>

      <div className="mt-4 flex gap-2" role="group" aria-label="Rating out of five">
        {STARS.map((value) => (
          <button
            key={value}
            type="button"
            disabled={busy}
            aria-pressed={rating === value}
            aria-label={`${value} out of 5`}
            onClick={() => {
              setRating(value);
              // A low rating is finished the moment it is given: the comment box
              // would only ask an unhappy customer for more work.
              if (value < REVIEW_PUBLISH_MIN_RATING) void submit(value);
            }}
            className={`h-12 w-12 rounded-full border text-[17px] font-semibold disabled:opacity-50 ${
              rating === value ? 'border-ink bg-ink text-white' : 'border-line hover:bg-surface'
            }`}
          >
            {value}
          </button>
        ))}
      </div>

      {rating !== null && rating >= REVIEW_PUBLISH_MIN_RATING && (
        <div className="mt-4">
          <label htmlFor="me-comment" className="text-[15px] text-muted">
            Anything you&rsquo;d like to add? It may appear on their page.
          </label>
          <textarea
            id="me-comment"
            value={comment}
            maxLength={REVIEW_COMMENT_MAX_LENGTH}
            onChange={(event) => setComment(event.target.value)}
            rows={3}
            className="mt-2 w-full rounded-xl border border-line p-3 text-[15px]"
          />
          <button
            type="button"
            disabled={busy}
            onClick={() => void submit(rating, comment)}
            className="mt-3 inline-flex h-12 items-center rounded-full bg-ink px-6 text-[16px] font-semibold text-white hover:bg-black/80 disabled:opacity-50"
          >
            {comment.trim() ? 'Send' : 'Send rating'}
          </button>
        </div>
      )}

      {error && (
        <p className="mt-3 text-[14px] font-medium text-ink" role="alert">
          {error}
        </p>
      )}
    </section>
  );
}
