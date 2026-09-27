import {
  BOOKING_STATUS,
  BRIEFING_KIND,
  DELIVERY_STATUS,
  DEPOSIT_STATUS,
  FLOW_KIND,
  FLOW_OPENER,
  FLOW_OUTCOME,
  NOTIFICATION_KIND,
  PHRASED_BY,
  REBOOK_ATTRIBUTION_DAYS,
  rateOf,
  type AdoptionMetric,
  type AdoptionWeek,
  type AgentEngagementMetric,
  type CompletionMetric,
  type FlowDropOff,
  type NoShowMetric,
  type OpenerCompletion,
  type RetentionMetric,
  type ReviewMetric,
} from '@scalivo/shared';
import { Booking } from '../models/Booking.js';
import { Briefing } from '../models/Briefing.js';
import { FlowRun } from '../models/FlowRun.js';
import { FunnelDay } from '../models/FunnelDay.js';
import { Notification } from '../models/Notification.js';
import { Review } from '../models/Review.js';
import { FLOW_STALE_MS } from '../whatsapp/flow-run.js';
import { toBusinessLocal } from '../lib/time.js';

/**
 * The six metrics of PROJECT_PLAN §7, plus agent engagement — milestone 3.9.
 *
 * Every function here is a query over data that was already being written. That is
 * the whole design goal: the pipeline is built now, before the pilot, so that it can
 * be PROVEN to work while the events it reads are still being generated — and the
 * only thing this milestone had to add to the system was the one record that did not
 * exist (FlowRun, for the booking funnel's denominator).
 *
 * Two rules hold throughout, and both cost the reported figures something:
 *
 * - **An empty sample is null, never zero** (see `Rate`). A metric over nothing has
 *   no value, and a 0 would be read as a finding.
 * - **What is excluded is reported.** Every rate below that drops rows from its
 *   denominator says how many and why, on the metric itself. An exclusion nobody can
 *   see is indistinguishable from a bug, six months later, to the person writing it
 *   up.
 */

const DAY_MS = 86_400_000;

export interface Window {
  businessId: string;
  timezone: string;
  /** UTC instants bounding the business-local window, `to` inclusive. */
  from: Date;
  to: Date;
  /** The same bounds as business-local dates, for the collections keyed by day. */
  fromDay: string;
  toDay: string;
  now: Date;
}

/** Appointments that reached their hour, and so have a verdict either way. */
const REACHED = [BOOKING_STATUS.COMPLETED, BOOKING_STATUS.NO_SHOW] as const;

/** The message left the building. Everything else cannot have caused anything. */
const WAS_SENT = [
  DELIVERY_STATUS.ACCEPTED,
  DELIVERY_STATUS.DELIVERED,
  DELIVERY_STATUS.READ,
] as const;

/**
 * No-show rate, deposit required against not — SPEC §12.3.
 *
 * Windowed on `startsAt`: the question is about appointments that came due in the
 * period, not ones booked in it. A booking made in March for June belongs to June's
 * no-show figure, and windowing on creation would credit it to a month in which
 * nobody either turned up or failed to.
 */
export async function noShowMetric(w: Window): Promise<NoShowMetric> {
  const due = {
    businessId: w.businessId,
    startsAt: { $gte: w.from, $lte: w.to },
    status: { $in: [...REACHED] },
  };

  // A deposit was ASKED FOR. See NoShowMetric for why this is the split rather than
  // whether one was paid.
  const required = { ...due, depositMinor: { $ne: null } };
  const notRequired = { ...due, depositMinor: null };

  const [withTotal, withNoShow, withoutTotal, withoutNoShow, unpaid] = await Promise.all([
    Booking.countDocuments(required),
    Booking.countDocuments({ ...required, status: BOOKING_STATUS.NO_SHOW }),
    Booking.countDocuments(notRequired),
    Booking.countDocuments({ ...notRequired, status: BOOKING_STATUS.NO_SHOW }),
    Booking.countDocuments({
      ...required,
      depositStatus: { $in: [DEPOSIT_STATUS.AWAITING, DEPOSIT_STATUS.EXPIRED, null] },
    }),
  ]);

  const withDeposit = rateOf(withNoShow, withTotal);
  const withoutDeposit = rateOf(withoutNoShow, withoutTotal);

  return {
    withDeposit,
    withoutDeposit,
    differencePoints:
      withDeposit.rate === null || withoutDeposit.rate === null
        ? null
        : (withoutDeposit.rate - withDeposit.rate) * 100,
    unpaidWithDeposit: unpaid,
  };
}

/**
 * Retention conversion — SPEC §6.3.
 *
 * Reads the attribution already stamped on each Notification rather than recomputing
 * "did a booking follow this?" now. That is not an optimisation: the window is
 * measured from the send, so a report run next year would have to reconstruct what
 * "within two weeks" meant at the time, and would quietly rewrite its own history
 * every time it ran.
 */
export async function retentionMetric(w: Window): Promise<RetentionMetric> {
  const sent = {
    businessId: w.businessId,
    status: { $in: [...WAS_SENT] },
    scheduledFor: { $gte: w.from, $lte: w.to },
  };

  const nudge = { ...sent, kind: NOTIFICATION_KIND.REBOOK_NUDGE };
  const campaign = { ...sent, kind: NOTIFICATION_KIND.CAMPAIGN };
  const marketing = { ...sent, kind: { $in: [NOTIFICATION_KIND.REBOOK_NUDGE, NOTIFICATION_KIND.CAMPAIGN] } };

  const [
    nudgesSent,
    nudgesRebooked,
    campaignsSent,
    campaignsRebooked,
    replied,
    notSent,
    coldContacts,
    unresolved,
  ] = await Promise.all([
    Notification.countDocuments(nudge),
    Notification.countDocuments({ ...nudge, rebookedBookingId: { $ne: null } }),
    Notification.countDocuments(campaign),
    Notification.countDocuments({ ...campaign, rebookedBookingId: { $ne: null } }),
    Notification.countDocuments({ ...marketing, repliedAt: { $ne: null } }),
    // Claimed but never handed over: queued behind an outage, or skipped because the
    // moment passed. Not a failed conversion — an absent one.
    Notification.countDocuments({
      businessId: w.businessId,
      kind: { $in: [NOTIFICATION_KIND.REBOOK_NUDGE, NOTIFICATION_KIND.CAMPAIGN] },
      scheduledFor: { $gte: w.from, $lte: w.to },
      status: { $in: [DELIVERY_STATUS.QUEUED, DELIVERY_STATUS.SKIPPED, DELIVERY_STATUS.FAILED] },
    }),
    Notification.countDocuments({ ...marketing, coldContact: true }),
    // Sent too recently for the attribution window to have closed.
    Notification.countDocuments({
      ...marketing,
      rebookedBookingId: null,
      scheduledFor: { $gt: new Date(w.now.getTime() - REBOOK_ATTRIBUTION_DAYS * DAY_MS) },
    }),
  ]);

  const sentTotal = nudgesSent + campaignsSent;

  return {
    nudges: rateOf(nudgesRebooked, nudgesSent),
    campaigns: rateOf(campaignsRebooked, campaignsSent),
    replies: rateOf(replied, sentTotal),
    notSent,
    unresolved,
    coldContacts,
  };
}

/**
 * Booking completion, WhatsApp against web — PROJECT_PLAN §7.
 *
 * The metric this milestone existed to unblock, and the only one whose data did not
 * exist beforehand. See models/FlowRun.ts.
 *
 * `abandoned` is computed here and stored nowhere: an open flow that has been silent
 * longer than the conversation TTL is one the customer walked away from. Deriving it
 * against the clock means the same row answers correctly as time passes, and it means
 * no job ever writes an event — "gave up" — that never actually happened.
 */
export async function completionMetric(w: Window): Promise<CompletionMetric> {
  const started = { businessId: w.businessId, startedAt: { $gte: w.from, $lte: w.to } };
  const stale = new Date(w.now.getTime() - FLOW_STALE_MS);

  /** Silent long enough to be gone. */
  const abandonedFilter = { ...started, outcome: null, lastStepAt: { $lt: stale } };
  /** Still going, at the moment of asking. In neither half of the rate. */
  const openFilter = { ...started, outcome: null, lastStepAt: { $gte: stale } };

  const [booked, escalated, left, abandoned, open, reschedules, rescheduleBooked, steps, misreads, dropOff] =
    await Promise.all([
      FlowRun.countDocuments({ ...started, outcome: FLOW_OUTCOME.BOOKED }),
      FlowRun.countDocuments({ ...started, outcome: FLOW_OUTCOME.ESCALATED }),
      FlowRun.countDocuments({ ...started, outcome: FLOW_OUTCOME.LEFT }),
      FlowRun.countDocuments(abandonedFilter),
      FlowRun.countDocuments(openFilter),
      FlowRun.countDocuments({
        ...started,
        kind: FLOW_KIND.RESCHEDULE,
        $or: [
          { outcome: { $in: [FLOW_OUTCOME.BOOKED, FLOW_OUTCOME.ESCALATED] } },
          { outcome: null, lastStepAt: { $lt: stale } },
        ],
      }),
      FlowRun.countDocuments({ ...started, kind: FLOW_KIND.RESCHEDULE, outcome: FLOW_OUTCOME.BOOKED }),
      averageFlowField({ ...started, outcome: FLOW_OUTCOME.BOOKED }, 'steps'),
      averageFlowField(
        {
          ...started,
          $or: [
            { outcome: { $in: [FLOW_OUTCOME.BOOKED, FLOW_OUTCOME.ESCALATED] } },
            { outcome: null, lastStepAt: { $lt: stale } },
          ],
        },
        'invalidInputs',
      ),
      // Where the involuntary failures stopped. LEFT flows are excluded: a customer
      // who typed CANCEL did not get stuck at the step they happened to be on, and
      // including them would point the usability finding at the wrong screen.
      FlowRun.aggregate<{ _id: string; flows: number }>([
        {
          $match: {
            ...started,
            $or: [{ outcome: FLOW_OUTCOME.ESCALATED }, { outcome: null, lastStepAt: { $lt: stale } }],
          },
        },
        { $group: { _id: '$furthestState', flows: { $sum: 1 } } },
        { $sort: { flows: -1 } },
      ]),
    ]);

  // Escalated and abandoned are both failures to complete. Left is not.
  const attempts = booked + escalated + abandoned;

  const [webStarts, webBookings] = await Promise.all([
    // FunnelDay is keyed by the business's own calendar date, so this window is the
    // local one — the same 'yesterday' the owner would mean.
    FunnelDay.aggregate<{ starts: number }>([
      { $match: { businessId: w.businessId, day: { $gte: w.fromDay, $lte: w.toDay } } },
      { $group: { _id: null, starts: { $sum: '$starts' } } },
    ]),
    Booking.countDocuments({
      businessId: w.businessId,
      source: 'web',
      createdAt: { $gte: w.from, $lte: w.to },
    }),
  ]);

  return {
    whatsapp: rateOf(booked, attempts),
    web: rateOf(webBookings, webStarts[0]?.starts ?? 0),
    whatsappOpen: open,
    whatsappEscalated: escalated,
    whatsappLeft: left,
    whatsappDropOff: dropOff.map((row): FlowDropOff => ({ state: row._id, flows: row.flows })),
    whatsappReschedules: rateOf(rescheduleBooked, reschedules),
    messagesPerBooking: steps,
    invalidInputsPerFlow: misreads,
    byOpener: await byOpener(started, stale),
  };
}

/**
 * The same funnel per entry point — milestone 3.2's evidence.
 *
 * Reuses `started` and `stale` rather than recomputing them so the split cannot
 * drift from the headline rate it is supposed to decompose. An opener with no flows
 * at all is omitted: a tenant whose Gemini key is not configured should show one row,
 * not a free-text row reading "— (no sample)" as though it had been tried.
 */
async function byOpener(
  started: Record<string, unknown>,
  stale: Date,
): Promise<OpenerCompletion[]> {
  const rows = await Promise.all(
    Object.values(FLOW_OPENER).map(async (opener): Promise<OpenerCompletion | null> => {
      const mine = { ...started, opener };

      /**
       * Flows that tried to reach a booking and settled one way or the other — the
       * denominator, spelled exactly as the headline metric spells it. A deliberate
       * exit is not in it, and neither is a flow still running.
       *
       * Written once and used for both the rate and the misread average, because the
       * headline averages misreads over completed flows too: a booking that took four
       * corrections still cost the customer four corrections, and dropping it would
       * make the menu look better the more often it worked despite itself.
       */
      const attempted = {
        ...mine,
        $or: [
          { outcome: { $in: [FLOW_OUTCOME.BOOKED, FLOW_OUTCOME.ESCALATED] } },
          { outcome: null, lastStepAt: { $lt: stale } },
        ],
      };

      const [booked, settled, steps, misreads, any] = await Promise.all([
        FlowRun.countDocuments({ ...mine, outcome: FLOW_OUTCOME.BOOKED }),
        FlowRun.countDocuments(attempted),
        averageFlowField({ ...mine, outcome: FLOW_OUTCOME.BOOKED }, 'steps'),
        averageFlowField(attempted, 'invalidInputs'),
        FlowRun.countDocuments(mine),
      ]);

      // No flows of this kind at all — not even open ones. Nothing to report.
      if (any === 0) return null;

      return {
        opener,
        flows: rateOf(booked, settled),
        messagesPerBooking: steps,
        invalidInputsPerFlow: misreads,
      };
    }),
  );

  return rows.filter((row): row is OpenerCompletion => row !== null);
}

/**
 * Adoption — bookings per week, and the automated/manual split.
 *
 * Windowed on `createdAt`, not `startsAt`: adoption is about when the system was
 * USED. A quiet week in which the owner booked twenty appointments for next month was
 * a busy week for the product.
 *
 * Weeks are the business's own, starting Monday in its own zone, so a Sunday evening
 * booking in Karachi does not land in the following week because the server is in UTC.
 */
export async function adoptionMetric(w: Window): Promise<AdoptionMetric> {
  const bookings = await Booking.find({
    businessId: w.businessId,
    createdAt: { $gte: w.from, $lte: w.to },
  }).select('source createdAt');

  const byWeek = new Map<string, AdoptionWeek>();
  let whatsapp = 0;
  let web = 0;
  let owner = 0;

  for (const booking of bookings) {
    const created = (booking as { createdAt?: Date }).createdAt;
    if (!created) continue;

    const monday = toBusinessLocal(created, w.timezone).startOf('week').toISODate();
    if (!monday) continue;

    const week =
      byWeek.get(monday) ?? { from: monday, bookings: 0, whatsapp: 0, web: 0, owner: 0 };

    week.bookings += 1;
    if (booking.source === 'whatsapp') {
      week.whatsapp += 1;
      whatsapp += 1;
    } else if (booking.source === 'web') {
      week.web += 1;
      web += 1;
    } else {
      week.owner += 1;
      owner += 1;
    }

    byWeek.set(monday, week);
  }

  const weeks = [...byWeek.values()].sort((a, b) => a.from.localeCompare(b.from));
  const total = whatsapp + web + owner;

  return {
    weeks,
    total,
    automated: whatsapp + web,
    manual: owner,
    automatedShare: rateOf(whatsapp + web, total),
  };
}

/**
 * Review capture — SPEC §9.
 *
 * A cohort, not three independent counts: the denominator is appointments COMPLETED
 * in the window, and both rates are computed over those same appointments. Counting
 * requests and ratings in the window independently would let a rating for March's
 * appointment land in April's capture rate and push it over 100%.
 *
 * `requested` will sit slightly below 1 on a window ending today, because the request
 * goes out a couple of hours after the appointment is marked complete. Over any window
 * worth reporting that lag is immaterial; over a single day it is not, and a capture
 * rate for "today" should not be read.
 */
export async function reviewMetric(w: Window): Promise<ReviewMetric> {
  const completed = await Booking.find({
    businessId: w.businessId,
    completedAt: { $gte: w.from, $lte: w.to },
  }).select('_id');

  const bookingIds = completed.map((booking) => String(booking._id));

  if (bookingIds.length === 0) {
    return {
      captured: rateOf(0, 0),
      requested: rateOf(0, 0),
      averageRating: null,
      distribution: [0, 0, 0, 0, 0],
      published: 0,
    };
  }

  const [requests, reviews] = await Promise.all([
    Notification.countDocuments({
      businessId: w.businessId,
      kind: NOTIFICATION_KIND.REVIEW_REQUEST,
      bookingId: { $in: bookingIds },
      status: { $in: [...WAS_SENT] },
    }),
    Review.find({ businessId: w.businessId, bookingId: { $in: bookingIds } }).select(
      'rating published',
    ),
  ]);

  const distribution: [number, number, number, number, number] = [0, 0, 0, 0, 0];
  let sum = 0;

  for (const review of reviews) {
    const star = Math.min(5, Math.max(1, Math.round(review.rating)));
    distribution[star - 1] = (distribution[star - 1] ?? 0) + 1;
    sum += review.rating;
  }

  return {
    captured: rateOf(reviews.length, requests),
    requested: rateOf(requests, bookingIds.length),
    averageRating: reviews.length === 0 ? null : sum / reviews.length,
    distribution,
    published: reviews.filter((review) => review.published).length,
  };
}

/**
 * Agent engagement — the input milestone 3.4 needs, and beyond §7's six.
 *
 * `readAt` is set only by an explicit gesture: the owner pressing the button or
 * following a suggested action, never by the card rendering. That is what makes this
 * a signal at all — a render-based count would be "the dashboard loaded", which is
 * always true, and 3.4 would then adapt to noise.
 */
export async function agentMetric(w: Window): Promise<AgentEngagementMetric> {
  const sent = { businessId: w.businessId, scheduledFor: { $gte: w.from, $lte: w.to } };

  const [briefings, read, llm, byKind] = await Promise.all([
    Briefing.countDocuments(sent),
    Briefing.countDocuments({ ...sent, readAt: { $ne: null } }),
    Briefing.countDocuments({ ...sent, phrasedBy: PHRASED_BY.GEMINI }),
    Briefing.aggregate<{ _id: string; briefings: number; read: number }>([
      { $match: sent },
      {
        $group: {
          _id: '$kind',
          briefings: { $sum: 1 },
          read: { $sum: { $cond: [{ $ne: ['$readAt', null] }, 1, 0] } },
        },
      },
    ]),
  ]);

  const order = [BRIEFING_KIND.DAILY, BRIEFING_KIND.WEEKLY, BRIEFING_KIND.ALERT] as string[];

  return {
    briefings,
    read: rateOf(read, briefings),
    byKind: byKind
      .map((row) => ({ kind: row._id, read: rateOf(row.read, row.briefings) }))
      .sort((a, b) => order.indexOf(a.kind) - order.indexOf(b.kind)),
    phrasedByLlm: rateOf(llm, briefings),
  };
}

/**
 * The mean of one numeric field over a filter, or null when nothing matched.
 *
 * Null rather than 0 for the same reason every rate is: "booking took no messages"
 * and "nobody booked" are different statements, and only one of them is ever true.
 */
async function averageFlowField(
  match: Record<string, unknown>,
  field: 'steps' | 'invalidInputs',
): Promise<number | null> {
  const rows = await FlowRun.aggregate<{ value: number }>([
    { $match: match },
    { $group: { _id: null, value: { $avg: `$${field}` } } },
  ]);

  return rows[0]?.value ?? null;
}
