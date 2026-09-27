import { DateTime } from 'luxon';
import {
  BOOKING_STATUS,
  BRIEFING_KIND,
  CAMPAIGN_AUDIENCE,
  type DailyFacts,
  type WeeklyFacts,
} from '@scalivo/shared';
import { Booking } from '../models/Booking.js';
import { ClientProfile } from '../models/ClientProfile.js';
import { Staff } from '../models/Staff.js';
import { buildReport } from '../analytics/report.js';
import { buildAudience } from '../retention/audience.js';
import { businessDayBounds, toBusinessLocal } from '../lib/time.js';

/**
 * What the agent knows — SPEC §11.1's reasoning layer, the half that is rules.
 *
 * Every figure here comes from a query over the same data the dashboard reads,
 * and most of it is the dashboard's own code: the weekly summary calls
 * `buildReport`, and "customers due to return" is the retention audience. That
 * reuse is deliberate and it is not laziness — a second implementation of
 * "revenue last week" would eventually disagree with the first, and the owner
 * would be told one number by the briefing and another by the Analytics page
 * with no way to know which was wrong.
 *
 * Nothing in this file phrases anything. Nothing in this file decides whether to
 * send. It answers "what is true about this business right now", and the two
 * layers above it are kept honest by being unable to compute anything themselves.
 */

const DAY_MS = 86_400_000;

/** Statuses that occupy a slot in a diary an owner is about to read. */
const ON_THE_BOOKS = [
  BOOKING_STATUS.PENDING,
  BOOKING_STATUS.CONFIRMED,
  BOOKING_STATUS.COMPLETED,
  BOOKING_STATUS.AWAITING_DEPOSIT,
] as const;

/** Appointments that reached their hour, and so have a no-show verdict. */
const REACHED_THEIR_HOUR = [BOOKING_STATUS.COMPLETED, BOOKING_STATUS.NO_SHOW] as const;

/**
 * Staffed minutes on one business-local date, breaks removed.
 *
 * Read from the roster rather than from availability, and the difference matters:
 * `getAvailability` answers "when could THIS service be booked", which needs a
 * service, a duration and a Redis round trip per day. The briefing's question is
 * coarser — how much of the day is staffed and how much of that is already sold
 * — so a business with twelve services does not need twelve answers.
 *
 * Summed ACROSS staff, so two people on all day is sixteen hours of capacity and
 * not eight. A briefing that reported eight would tell a two-chair salon it was
 * full when half its chairs were empty.
 */
export async function rosterMinutes(
  businessId: string,
  localDate: string,
  timezone: string,
): Promise<number> {
  return minutesOn(await loadRoster(businessId), localDate, timezone);
}

/** One shift, as the schema stores it: local wall clock, Sunday-0. */
interface Shift {
  dayOfWeek: number;
  opensAt: string;
  closesAt: string;
  breaks?: { startsAt?: string | null; endsAt?: string | null }[];
}

/**
 * The roster, read once.
 *
 * The alert detectors ask about a month of days at a time — twenty-eight for the
 * baseline and up to six ahead — and a query per day turns one pass into sixty
 * round trips per business. The working hours do not change between those
 * questions, so they are loaded once and the arithmetic is done in memory.
 */
export async function loadRoster(businessId: string): Promise<Shift[][]> {
  const staff = await Staff.find({ businessId, active: true }).select('workingHours');
  return staff.map((member) => (member.workingHours ?? []) as Shift[]);
}

/** Staffed minutes on one local date, from an already-loaded roster. */
export function minutesOn(roster: Shift[][], localDate: string, timezone: string): number {
  const day = DateTime.fromISO(localDate, { zone: timezone });
  if (!day.isValid) return 0;

  // Luxon's Monday-1..Sunday-7 against the schema's Sunday-0.
  const dayOfWeek = day.weekday === 7 ? 0 : day.weekday;

  let minutes = 0;
  for (const member of roster) {
    for (const shift of member) {
      if (shift.dayOfWeek !== dayOfWeek) continue;

      const open = clock(shift.opensAt);
      const close = clock(shift.closesAt);
      if (open === null || close === null || close <= open) continue;

      let span = close - open;
      for (const gap of shift.breaks ?? []) {
        const from = clock(gap.startsAt);
        const until = clock(gap.endsAt);
        // Clamped to the shift: a break recorded outside it should not subtract
        // capacity that was never there.
        if (from === null || until === null || until <= from) continue;
        span -= Math.max(0, Math.min(until, close) - Math.max(from, open));
      }

      minutes += Math.max(0, span);
    }
  }

  return minutes;
}

/** 'HH:mm' as minutes past midnight, or null if it is not that. */
function clock(value: string | null | undefined): number | null {
  const match = /^(\d{1,2}):(\d{2})$/.exec(value ?? '');
  if (!match) return null;
  const hours = Number(match[1]);
  const mins = Number(match[2]);
  if (hours > 23 || mins > 59) return null;
  return hours * 60 + mins;
}

/**
 * The morning briefing's numbers — SPEC §11.2.
 *
 * Deliberately about the day AHEAD and not the day behind. An owner reading this
 * over breakfast can still fill a gap, chase an unconfirmed booking or prepare
 * for a first-time customer; none of that is possible about yesterday, and a
 * briefing that reports only history is a report, not a briefing.
 */
export async function dailyFacts(
  businessId: string,
  timezone: string,
  localDate: string,
): Promise<DailyFacts> {
  const { start, end } = businessDayBounds(localDate, timezone);

  const [bookings, staffed] = await Promise.all([
    Booking.find({
      businessId,
      startsAt: { $gte: start, $lt: end },
      status: { $in: [...ON_THE_BOOKS] },
    })
      .select('clientId startsAt durationMinutes priceMinor status')
      .sort({ startsAt: 1 }),
    rosterMinutes(businessId, localDate, timezone),
  ]);

  const first = bookings[0];
  const last = bookings[bookings.length - 1];

  const bookedMinutes = bookings.reduce((sum, b) => sum + b.durationMinutes, 0);

  return {
    kind: BRIEFING_KIND.DAILY,
    date: localDate,
    appointments: bookings.length,
    expectedRevenueMinor: bookings.reduce((sum, b) => sum + b.priceMinor, 0),
    firstStartsAt: first ? first.startsAt.toISOString() : null,
    // The last APPOINTMENT's end, not the last start: "your day finishes at 6"
    // is what the owner wants to know, and a 90-minute treatment at 4:30 does not
    // finish at 4:30.
    lastEndsAt: last ? new Date(last.startsAt.getTime() + last.durationMinutes * 60_000).toISOString() : null,
    unconfirmed: bookings.filter(
      (b) => b.status === BOOKING_STATUS.PENDING || b.status === BOOKING_STATUS.AWAITING_DEPOSIT,
    ).length,
    firstTimers: await countFirstTimers(businessId, bookings.map((b) => b.clientId)),
    // One decimal: "3.5 hours still free" is actionable, "3.4833 hours" is noise.
    // Floored at zero because an overbooked day (a walk-in squeezed in on top of
    // the roster) has no free hours, and a negative number reads as a bug.
    openHours: Math.max(0, Math.round(((staffed - bookedMinutes) / 60) * 10) / 10),
  };
}

/**
 * How many of today's customers have never completed a visit here.
 *
 * Worth its own line in the briefing because it is the one fact in it that
 * changes how the owner behaves in the next hour — a first-timer is the
 * appointment where being remembered by name decides whether they come back.
 */
async function countFirstTimers(businessId: string, clientIds: string[]): Promise<number> {
  const unique = [...new Set(clientIds)];
  if (unique.length === 0) return 0;

  const profiles = await ClientProfile.find({
    businessId,
    clientId: { $in: unique },
  }).select('clientId totalVisits');

  const visits = new Map(profiles.map((p) => [p.clientId, p.totalVisits]));
  // No profile at all is also a first-timer: the profile is written by the
  // booking path, so its absence means nothing has ever completed.
  return unique.filter((id) => (visits.get(id) ?? 0) === 0).length;
}

/**
 * The Monday summary's numbers — SPEC §7.2, delivered by §11.
 *
 * Reports the week that just ENDED (Monday to Sunday), not the seven days behind
 * now. A rolling window would make "last week" mean something different every
 * time it was read, and the comparison against the week before it — the only
 * figure here that says whether the business is growing — would compare two
 * overlapping periods.
 */
export async function weeklyFacts(
  businessId: string,
  timezone: string,
  /** Any instant inside the Monday the summary is being sent on. */
  on: Date,
): Promise<WeeklyFacts> {
  const monday = toBusinessLocal(on, timezone).startOf('week');
  const lastWeek = { start: monday.minus({ weeks: 1 }), end: monday.minus({ days: 1 }) };
  const weekBefore = { start: monday.minus({ weeks: 2 }), end: monday.minus({ days: 8 }) };

  const from = lastWeek.start.toISODate() ?? '';
  const to = lastWeek.end.toISODate() ?? '';

  const [report, previous, atRisk] = await Promise.all([
    buildReport({ businessId, timezone, from, to, granularity: 'week', now: on }),
    buildReport({
      businessId,
      timezone,
      from: weekBefore.start.toISODate() ?? '',
      to: weekBefore.end.toISODate() ?? '',
      granularity: 'week',
      now: on,
    }),
    // The same audience the win-back broadcast targets, so "12 customers due to
    // return" and the number on the broadcast screen are the same 12 people.
    buildAudience(businessId, timezone, CAMPAIGN_AUDIENCE.AT_RISK, on),
  ]);

  const top = report.topServices[0] ?? null;

  return {
    kind: BRIEFING_KIND.WEEKLY,
    from,
    to,
    bookings: report.volume.total,
    completed: report.volume.completed,
    noShows: report.volume.noShow,
    revenueMinor: report.revenueMinor,
    previousRevenueMinor: previous.revenueMinor,
    topServiceName: top?.name ?? null,
    topServiceRevenueMinor: top?.revenueMinor ?? 0,
    bookedAhead: report.forecast.bookings,
    bookedAheadRevenueMinor: report.forecast.revenueMinor,
    dueToReturn: atRisk.preview.matched,
  };
}

/**
 * Appointments on one business-local date, by status.
 *
 * Shared by the empty-day detector and its own baseline, so "a day with nothing
 * in it" and "a normal day here" are counted the same way.
 */
export async function countOnDate(
  businessId: string,
  localDate: string,
  timezone: string,
): Promise<number> {
  const { start, end } = businessDayBounds(localDate, timezone);
  return Booking.countDocuments({
    businessId,
    startsAt: { $gte: start, $lt: end },
    status: { $in: [...ON_THE_BOOKS] },
  });
}

/** No-show verdicts over a window of days ending at `until`. */
export async function noShowWindow(
  businessId: string,
  until: Date,
  days: number,
  /** Excludes the most recent `skipDays`, so a baseline can exclude the window it is judging. */
  skipDays = 0,
): Promise<{ reached: number; noShows: number }> {
  const end = new Date(until.getTime() - skipDays * DAY_MS);
  const start = new Date(end.getTime() - days * DAY_MS);

  const rows = await Booking.aggregate<{ _id: string; count: number }>([
    {
      $match: {
        businessId,
        startsAt: { $gte: start, $lt: end },
        status: { $in: [...REACHED_THEIR_HOUR] },
      },
    },
    { $group: { _id: '$status', count: { $sum: 1 } } },
  ]);

  const of = (status: string) => rows.find((row) => row._id === status)?.count ?? 0;
  const noShows = of(BOOKING_STATUS.NO_SHOW);

  return { reached: of(BOOKING_STATUS.COMPLETED) + noShows, noShows };
}
