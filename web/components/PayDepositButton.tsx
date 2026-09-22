'use client';

import { useState } from 'react';
import type { CheckoutRedirect } from '@scalivo/shared';
import { API_BASE } from '@/lib/site';

/**
 * Starts a checkout and hands the browser to the gateway.
 *
 * JazzCash's hosted page takes a signed form POST, not a link, so the page
 * builds that form from the fields the backend signed and submits it. Nothing
 * here computes or sees a secret — the signature arrives already made.
 */
export function PayDepositButton({ token, amountLabel }: { token: string; amountLabel: string }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function pay() {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`${API_BASE}/public/deposits/${encodeURIComponent(token)}/checkout`, {
        method: 'POST',
        headers: { accept: 'application/json' },
      });
      if (!res.ok) {
        // 409: the window closed or it was already paid. The page is stale.
        if (res.status === 409) window.location.reload();
        else setError('Could not start the payment. Please try again.');
        setBusy(false);
        return;
      }

      const redirect = (await res.json()) as CheckoutRedirect;
      const form = document.createElement('form');
      form.method = redirect.method;
      form.action = redirect.url;
      for (const [name, value] of Object.entries(redirect.fields)) {
        const input = document.createElement('input');
        input.type = 'hidden';
        input.name = name;
        input.value = value;
        form.appendChild(input);
      }
      document.body.appendChild(form);
      form.submit();
    } catch {
      setError('Could not reach Scalivo. Check your connection and try again.');
      setBusy(false);
    }
  }

  return (
    <>
      <button
        type="button"
        onClick={pay}
        disabled={busy}
        className="inline-flex h-12 w-full items-center justify-center rounded-full bg-ink px-6 text-[16px] font-semibold text-white transition-colors hover:bg-black/80 disabled:opacity-60"
      >
        {busy ? 'Opening payment…' : `Pay ${amountLabel} deposit`}
      </button>
      {error && (
        <p role="alert" className="mt-3 text-[14px] text-red-600">
          {error}
        </p>
      )}
    </>
  );
}
