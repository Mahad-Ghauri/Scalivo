import { ALERT_TYPE, BRIEFING_KIND, type AlertType, type BriefingKind } from '@scalivo/shared';

/**
 * How the agent's messages are labelled for an owner — SPEC §11.
 *
 * In a plain module rather than beside the components, for the same reason
 * `lib/retention.ts` is: a non-component export from a `'use client'` file
 * reaches a server component as a client reference, not as the object, and
 * reading a property off it is a runtime crash rather than a type error.
 *
 * None of these labels says "briefing", "alert" or "agent". Those are the
 * system's words for its own plumbing. An owner reading this wants to know what
 * it is about — this morning, last week, or something that needs them.
 */

export const KIND_LABEL: Record<BriefingKind, string> = {
  [BRIEFING_KIND.DAILY]: 'Your day',
  [BRIEFING_KIND.WEEKLY]: 'Last week',
  [BRIEFING_KIND.ALERT]: 'Worth a look',
};

export const ALERT_LABEL: Record<AlertType, string> = {
  [ALERT_TYPE.NO_SHOW_SPIKE]: 'People not turning up',
  [ALERT_TYPE.EMPTY_DAY]: 'An empty day ahead',
  [ALERT_TYPE.LAPSED_PILEUP]: 'Customers to win back',
};

export function briefingLabel(kind: BriefingKind, alertType: AlertType | null): string {
  if (kind === BRIEFING_KIND.ALERT && alertType) return ALERT_LABEL[alertType] ?? KIND_LABEL[kind];
  return KIND_LABEL[kind];
}

/**
 * When it was for, in the owner's terms.
 *
 * "This morning" rather than a timestamp, because a briefing's whole value is
 * that it is current — and "26 Sep, 07:00" makes the reader do the arithmetic
 * that tells them whether it still is.
 */
export function briefingWhen(scheduledFor: string, timezone: string, now = new Date()): string {
  const at = new Date(scheduledFor);
  const day = (value: Date) =>
    new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit' })
      .format(value);

  const time = new Intl.DateTimeFormat('en-GB', {
    timeZone: timezone,
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  }).format(at);

  if (day(at) === day(now)) return `Today, ${time}`;

  const yesterday = new Date(now.getTime() - 86_400_000);
  if (day(at) === day(yesterday)) return `Yesterday, ${time}`;

  return new Intl.DateTimeFormat('en-GB', {
    timeZone: timezone,
    day: 'numeric',
    month: 'short',
  }).format(at);
}
