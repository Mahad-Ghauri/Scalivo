'use client';

import { useCallback, useEffect, useState } from 'react';
import { SESSION_STATUS, type SessionStatus } from '@scalivo/shared';

/**
 * Connecting a business's WhatsApp number, and reconnecting it when it drops.
 *
 * Built for milestone 1.9, which asks an owner to onboard through the real
 * flow — and found there was no such screen on the web at all. It existed only
 * in the Flutter app, so an owner on a laptop could configure everything about
 * their business except the one thing that makes it work.
 *
 * It matters beyond onboarding. Session Health's whole recovery story
 * (milestone 1.2) is "the owner re-scans" — and until now that sentence quietly
 * meant "the owner re-scans IN THE MOBILE APP". A session that dies while
 * nobody has a build installed had no route back. This is that route.
 *
 * The QR is a PNG data URL straight from the gateway, rendered as-is. Nothing is
 * decoded or re-encoded here: a QR redrawn client-side is a QR that can be
 * subtly wrong, and the failure would look like WhatsApp refusing to scan.
 */

interface Props {
  businessId: string;
  initial: {
    sessionId: string | null;
    status: SessionStatus | null;
    intent: string | null;
  };
}

type ApiError = { error?: string; reason?: string };

/**
 * How often to re-ask while a scan is outstanding.
 *
 * The gateway rotates its QR roughly every 20 seconds and simply issues a new
 * one, so this does double duty: it notices the scan succeeding, and it keeps
 * the displayed code fresh. A code that expires on screen cannot be scanned and
 * gives the person no clue why.
 */
const POLL_MS = 5_000;

export function WhatsAppConnect({ businessId, initial }: Props) {
  const [status, setStatus] = useState<SessionStatus | null>(initial.status);
  const [sessionId, setSessionId] = useState<string | null>(initial.sessionId);
  const [qr, setQr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const linked = status === SESSION_STATUS.READY;

  /**
   * Watch whenever a session exists and is not connected — NOT only after this
   * page asked for a QR.
   *
   * That distinction is the bug this screen shipped with. A session can be
   * sitting in `qr_ready` from a previous attempt, with the gateway rotating a
   * perfectly good code, and the old condition (`a QR we were handed`) meant
   * the page showed an error instead. Watching on STATE rather than on what
   * this tab happens to have done covers the reload, the second tab, and the
   * session that dropped while nobody was looking.
   */
  const watching = Boolean(sessionId) && !linked;

  const call = useCallback(
    async <T,>(path: string, init?: RequestInit): Promise<T | null> => {
      const res = await fetch(`/api/business/${businessId}${path}`, {
        ...init,
        headers: { accept: 'application/json', ...(init?.body ? { 'content-type': 'application/json' } : {}) },
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError((body as ApiError).error ?? 'Could not reach the server.');
        return null;
      }
      return body as T;
    },
    [businessId],
  );

  /** Ask the gateway for a QR — provisioning a session first if there is none. */
  const connect = async (force = false) => {
    setBusy(true);
    setError(null);
    const result = await call<{ sessionId: string; status: SessionStatus; qrCode: string | null }>(
      `/whatsapp/session${force ? '?force=true' : ''}`,
      { method: 'POST' },
    );
    setBusy(false);
    if (!result) return;

    setSessionId(result.sessionId);
    setStatus(result.status);
    if (result.qrCode) setQr(result.qrCode);
  };

  /** An existing session that has dropped: restart it and show whatever it needs. */
  const reconnect = async () => {
    setBusy(true);
    setError(null);
    const result = await call<{ status: SessionStatus; qrCode?: string | null }>('/whatsapp/link', {
      method: 'POST',
    });
    setBusy(false);
    if (!result) return;

    setStatus(result.status);
    if (result.qrCode) setQr(result.qrCode);
  };

  /**
   * While a session exists and is not connected, keep both the status and the
   * code current.
   *
   * The status arrives at the BACKEND by webhook, never at this page, so the
   * page has to ask. And the QR has to be re-fetched rather than held, because
   * the gateway expires it every ~20 seconds — the previous version pinned one
   * code on screen and then declared it expired, which was accurate and
   * useless. Polling stops the moment the session is ready.
   */
  useEffect(() => {
    if (!watching) return;

    let cancelled = false;

    const tick = async () => {
      const current = await call<{ status: SessionStatus }>('/whatsapp');
      if (cancelled || !current) return;
      setStatus(current.status);

      if (current.status === SESSION_STATUS.READY) {
        setQr(null);
        setError(null);
        return;
      }

      // Any not-connected state may be offering a code. Asking costs one call
      // and removes every reason for a scannable QR to go unseen.
      const live = await call<{ qrCode: string | null }>('/whatsapp/qr');
      if (cancelled) return;
      if (live?.qrCode) {
        setQr(live.qrCode);
        setError(null);
      }
    };

    void tick();
    const timer = setInterval(() => void tick(), POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [watching, call]);

  return (
    <div className="max-w-[640px]">
      <h1 className="text-[26px] font-bold tracking-[-0.02em]">WhatsApp</h1>
      <p className="mt-1 text-[15px] text-muted">
        The number your customers message to book. Everything the business sends — confirmations,
        reminders — goes out from here.
      </p>

      <div className="mt-6 rounded-2xl border border-line p-6">
        <StatusLine status={status} />

        {linked && (
          <p className="mt-3 text-[15px] text-muted">
            Connected and taking bookings. Leave the phone online — if it goes offline for too long,
            WhatsApp logs this connection out and you&rsquo;ll need to scan again.
          </p>
        )}

        {qr && (
          <div className="mt-6">
            <ol className="space-y-1 text-[15px] text-muted">
              <li>1. Open WhatsApp on the business phone</li>
              <li>2. Settings → Linked Devices → Link a Device</li>
              <li>3. Scan this code</li>
            </ol>
            {/* A plain <img>: the source is a data: URL the gateway generated,
                so there is nothing for next/image to fetch, resize or cache. */}
            <img
              src={qr}
              alt="QR code to link WhatsApp"
              className="mt-4 h-64 w-64 rounded-xl border border-line bg-white p-2"
            />
            <p className="mt-3 text-[14px] text-muted" aria-live="polite">
              Waiting for the scan. This code refreshes by itself — scan whichever one is on screen.
            </p>
          </div>
        )}

        {error && (
          <p role="alert" className="mt-4 rounded-xl border border-red-100 bg-red-50 px-4 py-3 text-[14px] font-medium text-red-700">
            {error}
          </p>
        )}

        <div className="mt-6 flex flex-wrap gap-3">
          {!sessionId && (
            <button
              type="button"
              disabled={busy}
              onClick={() => void connect()}
              className="inline-flex h-12 items-center rounded-full bg-ink px-6 text-[16px] font-semibold text-white hover:bg-black/80 disabled:opacity-50"
            >
              {busy ? 'Starting…' : 'Connect WhatsApp'}
            </button>
          )}

          {sessionId && !linked && (
            <button
              type="button"
              disabled={busy}
              onClick={() => void reconnect()}
              className="inline-flex h-12 items-center rounded-full bg-ink px-6 text-[16px] font-semibold text-white hover:bg-black/80 disabled:opacity-50"
            >
              {busy ? 'Asking…' : qr ? 'Get a new code' : 'Reconnect'}
            </button>
          )}

          {linked && (
            /**
             * Replacing a live session logs the owner's phone out of it, so this
             * confirms first and sends ?force=true. The backend refuses without
             * it, which is why this is a separate button rather than the one
             * above doing something different depending on state.
             */
            <button
              type="button"
              disabled={busy}
              onClick={() => {
                if (confirm('This disconnects the number that is currently working. Continue?')) {
                  void connect(true);
                }
              }}
              className="inline-flex h-12 items-center rounded-full border border-line px-6 text-[16px] font-semibold hover:bg-surface disabled:opacity-50"
            >
              Use a different number
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

function StatusLine({ status }: { status: SessionStatus | null }) {
  const [dot, label] = describe(status);
  return (
    <div className="flex items-center gap-3">
      <span className={`h-2.5 w-2.5 rounded-full ${dot}`} aria-hidden />
      <span className="text-[16px] font-semibold">{label}</span>
    </div>
  );
}

/**
 * Written for an owner, not an operator. "qr_ready" means nothing to somebody
 * who wants to know whether their bookings are working.
 */
function describe(status: SessionStatus | null): [string, string] {
  switch (status) {
    case SESSION_STATUS.READY:
      return ['bg-open', 'Connected'];
    case SESSION_STATUS.QR_READY:
      return ['bg-star', 'Waiting to be scanned'];
    case SESSION_STATUS.INITIALIZING:
    case SESSION_STATUS.AUTHENTICATING:
      return ['bg-star', 'Connecting…'];
    case SESSION_STATUS.DISCONNECTED:
    case SESSION_STATUS.ACTION_REQUIRED:
      return ['bg-red-500', 'Disconnected — customers cannot reach you'];
    case SESSION_STATUS.FAILED:
      return ['bg-red-500', 'Something went wrong connecting'];
    default:
      return ['bg-line', 'Not connected yet'];
  }
}
