'use client';

import { useState, useTransition } from 'react';
import { BRIEFING_HOUR_RANGE, type AgentSettings as Settings } from '@scalivo/shared';
import { setAgentSettingsAction } from '@/app/(dashboard)/dashboard/[businessId]/briefings/actions';

/**
 * Whether the agent speaks, and when — SPEC §11.3's "don't over-message".
 *
 * Two controls and no more. The thresholds behind the alerts are deliberately not
 * exposed: asking an owner what counts as a no-show spike moves the guessing from
 * the code to the person with the least information about it, and the detector
 * already compares them against their own history (backend/src/agent/thresholds.ts).
 */
export function AgentSettings({
  businessId,
  settings,
}: {
  businessId: string;
  settings: Settings;
}) {
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [hour, setHour] = useState(settings.hour);

  function save(change: { enabled?: boolean; hour?: number }) {
    setError(null);
    startTransition(async () => {
      const result = await setAgentSettingsAction(businessId, change);
      if (!result.ok) setError(result.error);
    });
  }

  const hours = Array.from(
    { length: BRIEFING_HOUR_RANGE.max - BRIEFING_HOUR_RANGE.min + 1 },
    (_, i) => BRIEFING_HOUR_RANGE.min + i,
  );

  return (
    <div>
      <p className="text-[15px] text-ink">
        {settings.enabled ? (
          <>
            <span className="font-semibold text-open">On</span>: you get a summary each morning, a
            look back on Mondays, and a message when something needs you.
          </>
        ) : (
          <>
            <span className="font-semibold">Off</span>: nothing is sent to your phone.
          </>
        )}
      </p>

      <div className="mt-4 flex flex-wrap items-end gap-4">
        <button
          type="button"
          onClick={() => save({ enabled: !settings.enabled })}
          disabled={pending}
          className="inline-flex h-10 items-center rounded-full border border-line px-5 text-[15px] font-semibold text-ink hover:bg-surface disabled:opacity-60"
        >
          {pending ? 'Saving…' : settings.enabled ? 'Turn off' : 'Turn on'}
        </button>

        {settings.enabled && (
          <label className="text-[14px] font-medium text-ink">
            Morning summary at
            <select
              value={hour}
              onChange={(event) => {
                const next = Number(event.target.value);
                setHour(next);
                save({ hour: next });
              }}
              disabled={pending}
              className="ml-2 h-10 rounded-lg border border-line bg-white px-3 text-[15px] text-ink focus:border-brand focus:outline-none disabled:opacity-60"
            >
              {hours.map((option) => (
                <option key={option} value={option}>
                  {option}:00
                </option>
              ))}
            </select>
          </label>
        )}
      </div>

      <p className="mt-3 text-[13px] text-muted">
        Alerts are held to one a week each, and never sent at night. Nothing here messages your
        customers. The agent only ever talks to you.
      </p>

      {error && (
        <p role="alert" className="mt-3 text-[14px] text-red-600">
          {error}
        </p>
      )}
    </div>
  );
}
