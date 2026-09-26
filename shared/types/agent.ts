/**
 * The autonomous agent — SPEC §11.
 *
 * Named accurately, here and in the thesis: a **cron-driven rules loop that uses
 * an LLM to phrase its messages well**. It is not an autonomous decision-maker,
 * and the split below is what keeps that claim true rather than modest.
 *
 * Every number the owner reads is computed by ordinary queries and travels as
 * `facts`. The model receives those facts and returns prose. It is never asked
 * what is true, never asked what to do, and cannot change a figure — so the worst
 * an LLM outage or hallucination can cost is the wording, and the briefing still
 * goes out (§11.3). That is also why `facts` is stored beside the prose: the
 * evaluation chapter needs to check what the agent knew against what it said.
 *
 * Three things fire it: the morning, the week, and a threshold being crossed.
 */

export const BRIEFING_KIND = {
  /** Every morning: today's diary, what it is worth, what needs attention. */
  DAILY: 'daily',
  /** Monday: last week against the one before it. */
  WEEKLY: 'weekly',
  /** Something crossed a line and is worth interrupting for. */
  ALERT: 'alert',
} as const;

export type BriefingKind = (typeof BRIEFING_KIND)[keyof typeof BRIEFING_KIND];

/**
 * The three thresholds — SPEC §11.1's event-driven half.
 *
 * Each one is a thing an owner can still act on when they hear about it. That is
 * the whole test for adding a fourth: an alert about something already finished
 * is a notification tax, and the cost of getting this wrong is not annoyance but
 * the owner learning to swipe these away.
 */
export const ALERT_TYPE = {
  /** They are being stood up more than they usually are. */
  NO_SHOW_SPIKE: 'no_show_spike',
  /** A working day close enough to fill, with nothing in it. */
  EMPTY_DAY: 'empty_day',
  /** Enough lapsed customers to be worth a broadcast. */
  LAPSED_PILEUP: 'lapsed_pileup',
} as const;

export type AlertType = (typeof ALERT_TYPE)[keyof typeof ALERT_TYPE];

export const isAlertType = (value: unknown): value is AlertType =>
  typeof value === 'string' && (Object.values(ALERT_TYPE) as string[]).includes(value);

/** Business-local hour the daily briefing is due. SPEC §11.2 says 7am. */
export const DEFAULT_BRIEFING_HOUR = 7;

/** The hours an owner may be woken. Anything due outside them waits. */
export const BRIEFING_HOUR_RANGE = { min: 5, max: 11 } as const;

/**
 * How late a briefing may still be sent.
 *
 * A 7am briefing arriving at 2pm is not a briefing — it is a summary of a day
 * the owner has already lived. Anything staler is recorded as skipped, which is
 * still a claim, so a process that was down all morning does not deliver
 * yesterday's news the moment it comes back.
 */
export const BRIEFING_MAX_LATE_MINUTES = 4 * 60;

/** Luxon weekday for Monday, the day the weekly summary is due. */
export const WEEKLY_BRIEFING_WEEKDAY = 1;

/**
 * Per alert type, per business, how long before that alert may fire again.
 *
 * The cooldown is the difference between an alert and a nag: an empty Saturday is
 * still empty tomorrow, and the condition being true again is not news. Seven
 * days also means no alert type can fire twice about the same week.
 */
export const ALERT_COOLDOWN_DAYS = 7;

/** Alerts are only worth sending inside the owner's waking hours, business-local. */
export const ALERT_WAKING_HOURS = { FROM: 8, UNTIL: 21 } as const;

/** How many days of history the no-show threshold reads. */
export const NO_SHOW_WINDOW_DAYS = 14;

/** And how far back its baseline goes, to compare a business against itself. */
export const NO_SHOW_BASELINE_DAYS = 90;

/**
 * The smallest sample a no-show rate may be computed from.
 *
 * SPEC §11.3 asks for per-business thresholds because "a no-show spike differs by
 * volume". The honest version of that is not a per-business number to configure —
 * it is refusing to call two no-shows out of three a spike, and comparing every
 * business against its OWN baseline rather than a figure picked in advance.
 */
export const NO_SHOW_MIN_SAMPLE = 6;

/** A rate this far above their own baseline is worth saying out loud. */
export const NO_SHOW_SPIKE_MARGIN = 0.15;

/** …but never below this, so a business with a spotless baseline is not alarmed by one. */
export const NO_SHOW_SPIKE_FLOOR = 0.25;

/** How far ahead to look for a day still worth filling. */
export const EMPTY_DAY_HORIZON = { min: 2, max: 7 } as const;

/** Reachable lapsed customers before a win-back is worth suggesting. */
export const LAPSED_PILEUP_MIN = 8;

/** …and how recently a broadcast must have gone out for the suggestion to be redundant. */
export const LAPSED_PILEUP_QUIET_DAYS = 30;

/** Longest briefing text we will send. Two screens on a phone is already too much. */
export const BRIEFING_TEXT_MAX = 700;

/**
 * What the rules worked out, before anything phrased it.
 *
 * Money is in minor units (paisa) like everywhere else, instants are ISO strings,
 * and `null` means "not knowable" rather than zero — a business with no history
 * has no baseline, and printing 0% would read as a record worth keeping.
 */
export interface DailyFacts {
  kind: typeof BRIEFING_KIND.DAILY;
  /** The business-local date this is about. */
  date: string;
  appointments: number;
  expectedRevenueMinor: number;
  firstStartsAt: string | null;
  lastEndsAt: string | null;
  /** Booked but not yet confirmed, including any waiting on a deposit. */
  unconfirmed: number;
  /** Customers coming today who have never been in before. */
  firstTimers: number;
  /** Bookable hours still open today — the slots worth filling. */
  openHours: number;
}

export interface WeeklyFacts {
  kind: typeof BRIEFING_KIND.WEEKLY;
  /** Business-local dates of the week being reported, both inclusive. */
  from: string;
  to: string;
  bookings: number;
  completed: number;
  noShows: number;
  revenueMinor: number;
  /** The week before it, for the comparison. */
  previousRevenueMinor: number;
  topServiceName: string | null;
  topServiceRevenueMinor: number;
  /** Already on the books for the week ahead. */
  bookedAhead: number;
  bookedAheadRevenueMinor: number;
  /** Customers overdue against their own rhythm — the follow-up list. */
  dueToReturn: number;
}

export interface AlertFacts {
  kind: typeof BRIEFING_KIND.ALERT;
  alertType: AlertType;
  /** The figure that crossed the line: a count, or a rate in 0..1. */
  value: number;
  /** What it is out of, or what it is being compared against. */
  context: number;
  /** The day an EMPTY_DAY alert is about; null for the others. */
  date: string | null;
}

export type BriefingFacts = DailyFacts | WeeklyFacts | AlertFacts;

/**
 * Something the owner can do about it, as a link into the dashboard.
 *
 * Deliberately a LINK and never a one-tap send. SPEC §11.3 requires owner
 * approval before anything customer-facing happens, and the screens these point
 * at already carry the right gate — the broadcast composer makes an owner type
 * the recipient count before it will send to anybody. Collapsing that into
 * "approve" on a notification would quietly delete the safeguard, and a
 * mis-tapped approval reaches real customers and cannot be recalled.
 */
export interface BriefingAction {
  label: string;
  /** Dashboard-relative, e.g. `/grow/broadcast?audience=lapsed`. */
  href: string;
}

/** Who wrote the prose. Stored because the fallback must be visible, not hidden. */
export const PHRASED_BY = { GEMINI: 'gemini', TEMPLATE: 'template' } as const;

export type PhrasedBy = (typeof PHRASED_BY)[keyof typeof PHRASED_BY];

export interface Briefing {
  id: string;
  kind: BriefingKind;
  alertType: AlertType | null;
  /** When it was due, not when it was written. */
  scheduledFor: string;
  headline: string;
  body: string;
  facts: BriefingFacts;
  phrasedBy: PhrasedBy;
  actions: BriefingAction[];
  /** When the owner opened it. The signal the Learning Layer (3.4) will read. */
  readAt: string | null;
  createdAt: string;
}

export interface AgentSettings {
  /** The daily briefing and the Monday summary. Alerts follow the same switch. */
  enabled: boolean;
  /** Business-local hour for the daily briefing. */
  hour: number;
  /**
   * An optional WhatsApp number to copy briefings to, E.164 without '+'.
   *
   * Null by default, and the default is the honest one: the number the business's
   * session runs on is usually the owner's own phone, so a briefing sent there
   * would be the app messaging the device it is running on. Push (§16.1) is the
   * owner channel that always exists. This field is for the case the spec has in
   * mind — a manager's phone, or a second handset — and a copy sent there never
   * invites a reply, because an inbound message from that number reaches the
   * customer FSM and would be answered with a booking menu.
   */
  whatsappTo: string | null;
}

export interface BriefingFeed {
  settings: AgentSettings;
  briefings: Briefing[];
  unread: number;
}
