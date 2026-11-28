'use client';

import { useState, useTransition } from 'react';
import { issueFeedAction, revokeFeedAction, type FeedStatus } from '@/lib/actions/calendar-feed';

/**
 * Getting appointments out of Scalivo — a CSV for any range, and a live
 * calendar subscription. This is also the plan for the day Scalivo is down:
 * the subscribed calendar still shows who is coming.
 */
export function ExportPanel({
  businessId,
  timezone,
  feed,
  staff,
}: {
  businessId: string;
  timezone: string;
  feed: FeedStatus;
  staff: { id: string; name: string }[];
}) {
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: timezone }).format(new Date());
  const monthAhead = new Intl.DateTimeFormat('en-CA', { timeZone: timezone }).format(
    new Date(Date.now() + 30 * 86_400_000),
  );
  const [from, setFrom] = useState(today);
  const [to, setTo] = useState(monthAhead);
  const [includeCancelled, setIncludeCancelled] = useState(false);

  const [enabled, setEnabled] = useState(feed.enabled);
  const [url, setUrl] = useState<string | null>(null);
  const [staffId, setStaffId] = useState('');
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();

  const rangeError = from && to && from > to ? 'The end date is before the start date.' : null;
  const csvHref =
    `/api/business/${encodeURIComponent(businessId)}/export?` +
    new URLSearchParams({ from, to, ...(includeCancelled ? { includeCancelled: 'true' } : {}) });

  const shownUrl = url && staffId ? `${url}?staff=${encodeURIComponent(staffId)}` : url;

  function issue() {
    if (
      enabled &&
      !window.confirm(
        'Make a new link? Calendars subscribed to the current link will stop updating.',
      )
    )
      return;
    setError(null);
    start(async () => {
      const res = await issueFeedAction(businessId);
      if (!res.ok) return setError('Could not create the link. Try again.');
      setUrl(res.url);
      setEnabled(true);
      setCopied(false);
    });
  }

  function revoke() {
    if (!window.confirm('Turn off the calendar link? Subscribed calendars will stop updating.')) return;
    start(async () => {
      const res = await revokeFeedAction(businessId);
      if (!res.ok) return setError('Could not turn the link off. Try again.');
      setEnabled(false);
      setUrl(null);
    });
  }

  async function copy() {
    if (!shownUrl) return;
    try {
      await navigator.clipboard.writeText(shownUrl);
      setCopied(true);
    } catch {
      setError('Copy failed. Select the link and copy it by hand.');
    }
  }

  return (
    <section className="rounded-xl border border-line bg-white p-6 shadow-sm">
      <h2 className="text-[16px] font-semibold text-ink">Export &amp; calendar</h2>
      <p className="mt-0.5 text-[14px] text-muted">
        Take your appointments with you, and keep a copy in your own calendar in case Scalivo is
        ever unavailable.
      </p>

      <div className="mt-5">
        <h3 className="text-[14px] font-semibold text-ink">Download appointments (CSV)</h3>
        <div className="mt-2 flex flex-wrap items-end gap-3">
          <label className="text-[13px] text-muted">
            From
            <input
              type="date"
              value={from}
              onChange={(e) => setFrom(e.target.value)}
              className="mt-1 block rounded-md border border-line px-2 py-1.5 text-sm text-ink"
            />
          </label>
          <label className="text-[13px] text-muted">
            To
            <input
              type="date"
              value={to}
              onChange={(e) => setTo(e.target.value)}
              className="mt-1 block rounded-md border border-line px-2 py-1.5 text-sm text-ink"
            />
          </label>
          <label className="flex items-center gap-2 pb-2 text-[13px] text-ink">
            <input
              type="checkbox"
              checked={includeCancelled}
              onChange={(e) => setIncludeCancelled(e.target.checked)}
              className="rounded text-brand focus:ring-brand"
            />
            Include cancelled
          </label>
          <a
            href={rangeError ? undefined : csvHref}
            aria-disabled={!!rangeError}
            download
            className={`rounded-full bg-ink px-4 py-2 text-sm font-semibold text-white ${
              rangeError ? 'pointer-events-none opacity-50' : 'hover:bg-ink/90'
            }`}
          >
            Download CSV
          </a>
        </div>
        <p className="mt-1.5 text-xs text-muted">
          Up to a year at a time. Opens in Excel or Google Sheets.
        </p>
        {rangeError && <p className="mt-1 text-sm text-red-700">{rangeError}</p>}
      </div>

      <div className="mt-6 border-t border-line pt-5">
        <h3 className="text-[14px] font-semibold text-ink">Subscribe in Google or Apple Calendar</h3>
        <p className="mt-1 text-[13px] text-muted">
          A private link that keeps your calendar app in sync with bookings: new ones appear,
          reschedules move, cancellations disappear. Your calendar app refreshes it every few
          hours. Anyone with the link can see customer names and numbers, so keep it to yourself.
        </p>

        {url ? (
          <div className="mt-3 space-y-2">
            <p className="text-[13px] font-medium text-amber-900">
              Copy this link now. For your security it won&apos;t be shown again.
            </p>
            {staff.length > 1 && (
              <label className="flex items-center gap-2 text-[13px] text-ink">
                Calendar for
                <select
                  value={staffId}
                  onChange={(e) => {
                    setStaffId(e.target.value);
                    setCopied(false);
                  }}
                  className="rounded-md border border-line px-2 py-1 text-sm"
                >
                  <option value="">Everyone</option>
                  {staff.map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.name}
                    </option>
                  ))}
                </select>
              </label>
            )}
            <div className="flex gap-2">
              <input
                readOnly
                value={shownUrl ?? ''}
                onFocus={(e) => e.currentTarget.select()}
                className="min-w-0 flex-1 rounded-md border border-line bg-surface px-3 py-2 font-mono text-xs text-ink"
                aria-label="Calendar subscription link"
              />
              <button
                type="button"
                onClick={copy}
                className="shrink-0 rounded-full bg-ink px-4 py-2 text-sm font-semibold text-white"
              >
                {copied ? 'Copied ✓' : 'Copy'}
              </button>
            </div>
            <p className="text-xs text-muted">
              Google Calendar: Other calendars → + → From URL. iPhone: Settings → Calendar →
              Accounts → Add Subscribed Calendar.
            </p>
          </div>
        ) : enabled ? (
          <p className="mt-3 text-[13px] text-ink">
            A link is active. Lost it? Make a new one. The old one stops working.
          </p>
        ) : null}

        <div className="mt-3 flex flex-wrap gap-3">
          <button
            type="button"
            onClick={issue}
            disabled={pending}
            className="rounded-full border border-line px-4 py-2 text-sm font-semibold text-ink hover:bg-surface disabled:opacity-60"
          >
            {enabled ? 'Make a new link' : 'Create calendar link'}
          </button>
          {enabled && (
            <button
              type="button"
              onClick={revoke}
              disabled={pending}
              className="rounded-full px-3 py-2 text-sm text-muted hover:text-red-700 disabled:opacity-60"
            >
              Turn off
            </button>
          )}
        </div>
        {error && <p className="mt-2 text-sm text-red-700">{error}</p>}
      </div>
    </section>
  );
}
