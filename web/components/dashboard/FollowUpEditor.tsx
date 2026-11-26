'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { FOLLOW_UP_STATUS, type FollowUpStatus, type FollowUpSummary } from '@scalivo/shared';
import { clearFollowUpAction, setFollowUpAction } from '@/lib/actions/followups';

const STATUS_LABEL: Record<FollowUpStatus, { text: string; cls: string }> = {
  scheduled: { text: 'Scheduled', cls: 'bg-brand/10 text-brand' },
  offered: { text: 'Customer messaged', cls: 'bg-star/20 text-amber-900' },
  nudged: { text: 'Reminded once', cls: 'bg-star/20 text-amber-900' },
  booked: { text: 'Booked ✅', cls: 'bg-open/10 text-open' },
  declined: { text: 'Customer said not now', cls: 'bg-surface text-muted' },
  lapsed: { text: 'Needs a call', cls: 'bg-red-100 text-red-800' },
  cancelled: { text: 'Removed', cls: 'bg-surface text-muted' },
};

/**
 * The owner's follow-up control for one booking: "come back in N days".
 *
 * Editable only while SCHEDULED (or removed). Once the customer has been
 * messaged, changing it would make the message they hold wrong, so it is
 * shown read-only from then on.
 */
export function FollowUpEditor({
  businessId,
  bookingId,
  followUp,
  defaultDays,
  defaultNote,
  timezone,
  emphasise = false,
  onSaved,
}: {
  businessId: string;
  bookingId: string;
  followUp: FollowUpSummary | null | undefined;
  /** The service's default, used to prefill a new follow-up. */
  defaultDays?: number | null | undefined;
  defaultNote?: string | null | undefined;
  timezone: string;
  /** Highlight right after "Mark completed": the moment the owner decides. */
  emphasise?: boolean;
  onSaved?: (f: FollowUpSummary | null) => void;
}) {
  const router = useRouter();
  const [current, setCurrent] = useState(followUp ?? null);
  const open = !current || current.status === FOLLOW_UP_STATUS.CANCELLED;
  const editable = open || current.status === FOLLOW_UP_STATUS.SCHEDULED;

  const [editing, setEditing] = useState(false);
  const [days, setDays] = useState(String(defaultDays ?? 21));
  const [note, setNote] = useState(current?.note ?? defaultNote ?? '');
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();

  const due = current
    ? new Intl.DateTimeFormat('en-US', {
        timeZone: timezone,
        weekday: 'short',
        month: 'short',
        day: 'numeric',
      }).format(new Date(current.dueAt))
    : null;

  function save() {
    const n = Number(days);
    if (!Number.isInteger(n) || n < 1 || n > 365) {
      setError('Enter a number of days between 1 and 365.');
      return;
    }
    setError(null);
    start(async () => {
      const res = await setFollowUpAction(businessId, bookingId, {
        afterDays: n,
        note: note.trim() || null,
      });
      if (!res.success) return setError(res.error);
      setCurrent(res.followUp);
      setEditing(false);
      onSaved?.(res.followUp);
      router.refresh();
    });
  }

  function remove() {
    start(async () => {
      const res = await clearFollowUpAction(businessId, bookingId);
      if (!res.success) return setError(res.error);
      setCurrent(null);
      onSaved?.(null);
      router.refresh();
    });
  }

  const showForm = editing || (open && emphasise);

  return (
    <div
      className={`rounded-xl border p-4 ${emphasise && open ? 'border-brand bg-brand/5' : 'border-line'}`}
    >
      <div className="flex items-center justify-between gap-2">
        <h3 className="text-xs font-semibold uppercase tracking-wider text-muted">Follow-up</h3>
        {current && current.status !== FOLLOW_UP_STATUS.CANCELLED && (
          <span
            className={`rounded-full px-2 py-0.5 text-xs font-medium ${STATUS_LABEL[current.status].cls}`}
          >
            {STATUS_LABEL[current.status].text}
          </span>
        )}
      </div>

      {emphasise && open && !editing && (
        <p className="mt-2 text-sm text-ink">Does this customer need to come back?</p>
      )}

      {!showForm && current && current.status !== FOLLOW_UP_STATUS.CANCELLED && (
        <div className="mt-2 text-sm text-ink">
          Due around <span className="font-medium">{due}</span>
          {current.note && <p className="mt-0.5 text-muted">{current.note}</p>}
          {current.status === FOLLOW_UP_STATUS.SCHEDULED && (
            <p className="mt-1 text-xs text-muted">
              We&apos;ll message the customer on WhatsApp 3 days before, with a time they can
              book in one reply.
            </p>
          )}
        </div>
      )}

      {showForm ? (
        <div className="mt-3 space-y-3">
          <label className="flex items-center gap-2 text-sm text-ink">
            Come back in
            <input
              type="number"
              min={1}
              max={365}
              value={days}
              onChange={(e) => setDays(e.target.value)}
              className="w-20 rounded-md border border-line px-2 py-1 text-sm"
              aria-label="Days until follow-up"
            />
            days
          </label>
          <input
            type="text"
            maxLength={200}
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder="Note for the customer, e.g. Session 2 of 6"
            className="w-full rounded-md border border-line px-3 py-2 text-sm"
          />
          <div className="flex gap-2">
            <button
              type="button"
              onClick={save}
              disabled={pending}
              className="rounded-full bg-ink px-4 py-1.5 text-sm font-semibold text-white disabled:opacity-60"
            >
              {pending ? 'Saving…' : 'Save follow-up'}
            </button>
            {editing && (
              <button
                type="button"
                onClick={() => setEditing(false)}
                className="rounded-full px-3 py-1.5 text-sm text-muted hover:text-ink"
              >
                Cancel
              </button>
            )}
          </div>
        </div>
      ) : (
        editable && (
          <div className="mt-3 flex gap-3 text-sm">
            <button
              type="button"
              onClick={() => setEditing(true)}
              className="font-medium text-brand hover:underline"
            >
              {open ? '+ Add follow-up' : 'Edit'}
            </button>
            {!open && (
              <button
                type="button"
                onClick={remove}
                disabled={pending}
                className="text-muted hover:text-red-700"
              >
                Remove
              </button>
            )}
          </div>
        )
      )}
      {error && <p className="mt-2 text-sm text-red-700">{error}</p>}
    </div>
  );
}
