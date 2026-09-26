import { CLIENT_TAG, type ClientTag } from '@scalivo/shared';

/**
 * Behavioural tags, COMPUTED on read and never stored.
 *
 * Two of the four are functions of elapsed time, and that is the whole design
 * argument: nothing happens when a customer stops coming. There is no event to
 * hook, no webhook, no booking — the absence IS the signal. A tag written at
 * booking time would be stale by the time it mattered, and keeping it fresh
 * would mean a nightly job re-tagging every client of every business to change
 * a handful of rows. Deriving it costs one subtraction.
 *
 * The counters these read from are cached on ClientProfile, so this stays cheap
 * even though it runs on every profile view.
 */

/** Five visits is a habit rather than a coincidence. */
const VIP_VISITS = 5;

/** PKR 50,000 lifetime, in paisa. A package buyer is a VIP on visit one. */
const VIP_SPEND_MINOR = 50_000 * 100;

/** Still new until they have come back once. */
const NEW_MAX_VISITS = 1;

/** Beyond this, "at risk" is wishful thinking whatever their usual cadence. */
const LAPSED_DAYS = 90;

/**
 * How far past their OWN usual gap counts as slipping.
 *
 * Per-customer rather than a fixed number of days, because a fixed number is
 * wrong for almost everyone: a monthly-facial client at 60 days is in trouble,
 * and an annual-checkup client at 60 days is early. 1.5x is late enough that a
 * holiday does not trigger it and early enough to be worth a nudge.
 */
const AT_RISK_GAP_MULTIPLIER = 1.5;

/** Below this, a "usual gap" is one interval and not yet a pattern. */
const MIN_VISITS_FOR_CADENCE = 3;

const DAY_MS = 86_400_000;

export interface TaggableProfile {
  totalVisits: number;
  lifetimeSpendMinor: number;
  firstVisitAt: Date | null;
  lastVisitAt: Date | null;
  lastBookingAt: Date | null;
}

/**
 * Their own average interval between visits, in days, or null when there is not
 * enough history to call it a pattern.
 *
 * Exact rather than a rolling estimate: with a first visit, a last visit and a
 * count, the mean gap is (last − first) / (visits − 1) and needs no extra
 * stored field to drift out of sync.
 */
export function averageGapDays(profile: TaggableProfile): number | null {
  if (profile.totalVisits < MIN_VISITS_FOR_CADENCE) return null;
  if (!profile.firstVisitAt || !profile.lastVisitAt) return null;

  const span = profile.lastVisitAt.getTime() - profile.firstVisitAt.getTime();
  if (span <= 0) return null;

  return span / DAY_MS / (profile.totalVisits - 1);
}

/** When we would expect them next, if they keep doing what they have been doing. */
export function nextExpectedVisitAt(profile: TaggableProfile): Date | null {
  const gap = averageGapDays(profile);
  if (gap === null || !profile.lastVisitAt) return null;
  return new Date(profile.lastVisitAt.getTime() + gap * DAY_MS);
}

/**
 * The instant they crossed into AT_RISK, or null when there is no cadence to be
 * late against.
 *
 * Exported for the retention pass (SPEC §6.1), which needs to know not just
 * whether someone is at risk but *when they became* it — a nudge is worth
 * sending in the weeks after that moment and not two years later. Deriving it
 * there would mean a second copy of the multiplier, and two copies of a
 * threshold is how a tag and the message about the tag come to disagree.
 */
export function atRiskSince(profile: TaggableProfile): Date | null {
  const gap = averageGapDays(profile);
  if (gap === null || !profile.lastVisitAt) return null;
  return new Date(profile.lastVisitAt.getTime() + gap * AT_RISK_GAP_MULTIPLIER * DAY_MS);
}

export interface TagContext {
  /** An appointment already on the books. Someone booked is not lapsing. */
  hasUpcomingBooking: boolean;
  now?: Date;
}

export function computeTags(profile: TaggableProfile, ctx: TagContext): ClientTag[] {
  const now = ctx.now ?? new Date();
  const tags: ClientTag[] = [];

  if (profile.totalVisits <= NEW_MAX_VISITS) tags.push(CLIENT_TAG.NEW);

  // NEW and VIP together is not a contradiction: someone whose first
  // appointment was a PKR 60,000 package is both, and treating them as merely
  // new is how a business loses them.
  if (profile.totalVisits >= VIP_VISITS || profile.lifetimeSpendMinor >= VIP_SPEND_MINOR) {
    tags.push(CLIENT_TAG.VIP);
  }

  // An appointment on the books settles it. Chasing someone who is coming on
  // Thursday reads as a business that does not know its own diary.
  if (ctx.hasUpcomingBooking) return tags;

  // Never visited: there is no cadence to be late against, and calling someone
  // lapsed before their first appointment is just wrong.
  if (!profile.lastVisitAt) return tags;

  const daysSince = (now.getTime() - profile.lastVisitAt.getTime()) / DAY_MS;

  if (daysSince >= LAPSED_DAYS) {
    // Lapsed absorbs at-risk. Two tags for one condition would double-count
    // them in every campaign that reads either.
    tags.push(CLIENT_TAG.LAPSED);
    return tags;
  }

  const gap = averageGapDays(profile);
  if (gap !== null && daysSince >= gap * AT_RISK_GAP_MULTIPLIER) {
    tags.push(CLIENT_TAG.AT_RISK);
  }

  return tags;
}
