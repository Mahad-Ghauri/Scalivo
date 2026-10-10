'use client';

import { useEffect, useRef, useState } from 'react';
import { API_BASE } from '@/lib/site';

type Challenge = { challengeId: string; whatsappUrl: string | null; accepted: boolean };

/** Shared by first-time booking and sensitive actions on the customer's page. */
export function WhatsAppVerification({
  path,
  onVerified,
  phoneRequired = true,
}: {
  path: string;
  phoneRequired?: boolean;
  onVerified: (proof: string, phone: string) => void;
}) {
  const [phone, setPhone] = useState('');
  const [code, setCode] = useState('');
  const [challenge, setChallenge] = useState<Challenge | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const version = useRef(0);
  useEffect(
    () => () => {
      version.current++;
    },
    [],
  );
  async function request(confirm: boolean) {
    if (busy) return;
    setBusy(true);
    setError(null);
    const current = ++version.current;
    try {
      const response = await fetch(`${API_BASE}${path}/verification${confirm ? '/confirm' : ''}`, {
        method: 'POST',
        signal: AbortSignal.timeout(15000),
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(
          confirm ? { challengeId: challenge?.challengeId, ...(code ? { code } : {}) } : { phone },
        ),
      });
      const data = await response.json();
      if (version.current !== current) return;
      if (!response.ok) {
        setError(typeof data.error === 'string' ? data.error : 'Verification failed. Try again.');
        return;
      }
      if (
        confirm &&
        typeof data.verificationProof === 'string' &&
        /^[A-Za-z0-9_-]{32}$/.test(data.verificationProof)
      )
        onVerified(data.verificationProof, phone);
      else if (
        !confirm &&
        typeof data.challengeId === 'string' &&
        /^[a-f\d-]{36}$/i.test(data.challengeId)
      )
        setChallenge({
          challengeId: data.challengeId,
          accepted: data.accepted === true,
          whatsappUrl:
            typeof data.whatsappUrl === 'string' &&
            /^https:\/\/wa\.me\/\d+\?text=/.test(data.whatsappUrl)
              ? data.whatsappUrl
              : null,
        });
      else setError('Verification failed. Request a new code.');
    } catch {
      if (version.current === current)
        setError('Could not connect. Check your connection and try again.');
    } finally {
      if (version.current === current) setBusy(false);
    }
  }
  return (
    <section className="grid gap-3 rounded-xl border border-line p-4" aria-label="Verify WhatsApp">
      <h3 className="font-semibold">Verify your WhatsApp</h3>
      <p className="text-sm text-muted">
        This protects your appointment and stops someone else booking with your number.
      </p>
      {phoneRequired && (
        <label className="grid gap-1 text-sm">
          WhatsApp number
          <input
            value={phone}
            onChange={(event) => {
              setPhone(event.target.value);
              setChallenge(null);
              setCode('');
            }}
            maxLength={20}
            autoComplete="tel"
            inputMode="tel"
            disabled={busy}
            className="h-12 rounded-lg border border-line px-3"
          />
        </label>
      )}
      {!challenge ? (
        <button
          type="button"
          onClick={() => request(false)}
          disabled={busy || (phoneRequired && phone.trim().length < 7)}
          className="min-h-12 rounded-lg bg-ink px-4 text-white disabled:opacity-50"
        >
          {busy ? 'Sending…' : 'Send verification code'}
        </button>
      ) : (
        <>
          <label className="grid gap-1 text-sm">
            Six-digit code
            <input
              value={code}
              onChange={(event) => setCode(event.target.value.replace(/\D/g, '').slice(0, 6))}
              maxLength={6}
              autoComplete="one-time-code"
              inputMode="numeric"
              className="h-12 rounded-lg border border-line px-3"
            />
          </label>
          <button
            type="button"
            onClick={() => request(true)}
            disabled={busy || (code.length > 0 && code.length !== 6)}
            className="min-h-12 rounded-lg bg-ink px-4 text-white disabled:opacity-50"
          >
            {busy
              ? 'Checking…'
              : code
                ? 'Verify code'
                : 'I sent the WhatsApp message — check verification'}
          </button>
          {challenge.whatsappUrl && (
            <a
              href={challenge.whatsappUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="min-h-11 py-3 text-sm underline"
            >
              Code hasn’t arrived? Send the verification message on WhatsApp
            </a>
          )}
          <button
            type="button"
            disabled={busy}
            onClick={() => {
              setChallenge(null);
              setCode('');
            }}
            className="min-h-11 text-sm underline"
          >
            Request a new code (wait one minute between requests)
          </button>
        </>
      )}
      {error && (
        <p role="alert" className="text-sm text-red-700">
          {error}
        </p>
      )}
    </section>
  );
}
