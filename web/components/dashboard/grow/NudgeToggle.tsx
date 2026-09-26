'use client';

import { useState, useTransition } from 'react';
import { setNudgesAction } from '@/app/(dashboard)/dashboard/[businessId]/grow/actions';

/**
 * The automatic rebooking nudges, on or off — SPEC §6.1.
 *
 * Framed as what it does rather than as a setting name, because "nudges: on" tells
 * an owner nothing about whether their customers are about to receive messages.
 */
export function NudgeToggle({ businessId, enabled }: { businessId: string; enabled: boolean }) {
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  function set(on: boolean) {
    setError(null);
    startTransition(async () => {
      const result = await setNudgesAction(businessId, on);
      if (!result.ok) setError(result.error);
    });
  }

  return (
    <div>
      <p className="text-[15px] text-ink">
        {enabled ? (
          <>
            <span className="font-semibold text-open">On</span> — customers who are overdue compared to their own usual
            gap get one message inviting them to book.
          </>
        ) : (
          <>
            <span className="font-semibold">Off</span> — nobody is messaged automatically.
          </>
        )}
      </p>
      <button
        type="button"
        onClick={() => set(!enabled)}
        disabled={pending}
        className="mt-4 inline-flex h-10 items-center rounded-full border border-line px-5 text-[15px] font-semibold text-ink hover:bg-surface disabled:opacity-60"
      >
        {pending ? 'Saving…' : enabled ? 'Turn off' : 'Turn on'}
      </button>
      <p className="mt-3 text-[13px] text-muted">
        One message per customer per absence, never more than one marketing message a fortnight, and never to anyone who
        replied STOP.
      </p>
      {error && (
        <p role="alert" className="mt-3 text-[14px] text-red-600">
          {error}
        </p>
      )}
    </div>
  );
}
