import mongoose from 'mongoose';
import { DateTime } from 'luxon';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  BOOKING_STATUS,
  BRIEFING_KIND,
  DELIVERY_STATUS,
  DEPOSIT_STATUS,
  FLOW_KIND,
  FLOW_OUTCOME,
  NOTIFICATION_KIND,
  PHRASED_BY,
  SESSION_INTENT,
  SESSION_STATUS,
  rateOf,
} from '@scalivo/shared';
import { Booking } from '../src/models/Booking.js';
import { Briefing } from '../src/models/Briefing.js';
import { Business } from '../src/models/Business.js';
import { FlowRun } from '../src/models/FlowRun.js';
import { FunnelDay } from '../src/models/FunnelDay.js';
import { Notification } from '../src/models/Notification.js';
import { Review } from '../src/models/Review.js';
import { SessionEvent } from '../src/models/SessionEvent.js';
import {
  adoptionMetric,
  agentMetric,
  completionMetric,
  noShowMetric,
  retentionMetric,
  reviewMetric,
  type Window,
} from '../src/evaluation/metrics.js';
import { sessionUptime } from '../src/evaluation/uptime.js';
import { buildEvaluation } from '../src/evaluation/report.js';
import { FLOW_STALE_MS, recordFlowStep } from '../src/whatsapp/flow-run.js';
import { CONVERSATION_STATE, type Conversation } from '../src/whatsapp/fsm/states.js';
import { businessDayBounds } from '../src/lib/time.js';
import { infraReady } from './infra.js';

/**
 * The evaluation pipeline — PROJECT_PLAN §7, milestone 3.9.
 *
 * What is worth testing here is not that the queries return numbers. It is that the
 * numbers are the ones the thesis will claim, and every test below is aimed at a way
 * this could produce a plausible figure that is wrong — which is the only failure
 * mode that matters in a measurement system, because nobody checks a number that
 * looks reasonable.
 *
 * Four properties, in order of how badly each would hurt:
 *
 * 1. **An empty sample is never a finding.** Every rate returns null rather than 0
 *    when there was nothing to divide, because "0% of our customers no-showed" read
 *    off an empty month is a sentence that could reach a thesis.
 * 2. **The exclusions are the right ones, and they are visible.** A customer who
 *    typed CANCEL is not a booking flow that failed. A nudge queued behind an outage
 *    did not fail to convert. A session we stopped ourselves was not down.
 * 3. **The booking funnel counts the flows that left no other trace.** This is the
 *    one record 3.9 had to add, and its whole purpose is the abandonments — so most
 *    of the funnel tests are about a customer who never booked.
 * 4. **Uptime measures a quiet month.** A business with no incidents has no rows
 *    inside the window, and the naive query reports it as having no uptime. That is
 *    the headline metric failing on its best possible input.
 *
 * Needs Mongo. No Redis and no replica set: nothing here holds a slot or opens a
 * transaction, and the recorder is driven directly rather than through the router.
 */

const TZ = 'Asia/Karachi';
const DAY_MS = 86_400_000;

/** A fixed Wednesday in the business's zone, so no test depends on the day it runs. */
const NOW = DateTime.fromISO('2026-09-16T14:00', { zone: TZ }).startOf('week').plus({ days: 2, hours: 14 });
const now = NOW.toJSDate();

const dayOf = (offsetDays: number) => NOW.plus({ days: offsetDays }).toISODate()!;
const ago = (days: number, hours = 0) => new Date(now.getTime() - days * DAY_MS - hours * 3_600_000);

const infraUp = await infraReady();

describe.skipIf(!infraUp)('evaluation pipeline', () => {
  let businessId: string;
  const SESSION_ID = 'evaluation-test-session';

  /** The 30-day window every metric test uses unless it says otherwise. */
  let window: Window;

  beforeAll(async () => {
    await Promise.all([FlowRun.syncIndexes(), SessionEvent.syncIndexes()]);
  });

  afterAll(async () => {
    await mongoose.disconnect();
  });

  beforeEach(async () => {
    const doc = await Business.findOneAndUpdate(
      { slug: 'evaluation-test' },
      {
        slug: 'evaluation-test',
        name: 'Evaluation Test Clinic',
        category: 'salon',
        timezone: TZ,
        whatsapp: { sessionId: SESSION_ID },
      },
      { upsert: true, new: true, setDefaultsOnInsert: true },
    );
    businessId = String(doc!._id);

    await Promise.all([
      Booking.deleteMany({ businessId }),
      Briefing.deleteMany({ businessId }),
      FlowRun.deleteMany({ businessId }),
      FunnelDay.deleteMany({ businessId }),
      Notification.deleteMany({ businessId }),
      Review.deleteMany({ businessId }),
      SessionEvent.deleteMany({ businessId }),
    ]);

    const from = dayOf(-30);
    const to = dayOf(0);

    window = {
      businessId,
      timezone: TZ,
      from: businessDayBounds(from, TZ).start,
      to: businessDayBounds(to, TZ).end,
      fromDay: from,
      toDay: to,
      now,
    };
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // The honesty primitive
  // ─────────────────────────────────────────────────────────────────────────────

  describe('a rate over nothing', () => {
    it('is null, not zero', () => {
      expect(rateOf(0, 0).rate).toBeNull();
      expect(rateOf(0, 4).rate).toBe(0);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // The funnel record — the one thing this milestone had to add
  // ─────────────────────────────────────────────────────────────────────────────

  describe('recording a booking conversation', () => {
    const CLIENT = 'flow-client-1';

    /** A conversation in a given state, with no confusion behind it. */
    const conv = (state: string, extra: Partial<Conversation> = {}): Conversation =>
      ({ state, invalidCount: 0, ...extra }) as Conversation;

    const step = (before: Conversation | null, after: Conversation | null, extra: {
      bookingId?: string;
      at?: Date;
      clientId?: string;
    } = {}) =>
      recordFlowStep({
        businessId,
        clientId: extra.clientId ?? CLIENT,
        before,
        after,
        bookingId: extra.bookingId,
        at: extra.at ?? now,
      });

    const only = async () => {
      const rows = await FlowRun.find({ businessId });
      expect(rows).toHaveLength(1);
      return rows[0]!;
    };

    it('opens a flow when the customer reaches the service menu', async () => {
      await step(null, conv(CONVERSATION_STATE.SELECTING_SERVICE));

      const flow = await only();
      expect(flow.startedState).toBe(CONVERSATION_STATE.SELECTING_SERVICE);
      expect(flow.furthestState).toBe(CONVERSATION_STATE.SELECTING_SERVICE);
      expect(flow.outcome).toBeNull();
      expect(flow.kind).toBe(FLOW_KIND.NEW);
    });

    it('records where a flow entered, which is not always the service menu', async () => {
      // Accepting the rebook offer after a cancellation drops straight into dates.
      await step(conv(CONVERSATION_STATE.OFFERING_REBOOK), conv(CONVERSATION_STATE.SELECTING_DATE));

      const flow = await only();
      expect(flow.startedState).toBe(CONVERSATION_STATE.SELECTING_DATE);
    });

    it('does not open a flow for a conversation that is not a booking', async () => {
      await step(null, conv(CONVERSATION_STATE.AWAITING_RATING));
      await step(conv(CONVERSATION_STATE.AWAITING_RATING), conv(CONVERSATION_STATE.HELP));

      expect(await FlowRun.countDocuments({ businessId })).toBe(0);
    });

    it('deepens as the customer progresses', async () => {
      await step(null, conv(CONVERSATION_STATE.SELECTING_SERVICE));
      await step(conv(CONVERSATION_STATE.SELECTING_SERVICE), conv(CONVERSATION_STATE.SELECTING_DATE));
      await step(conv(CONVERSATION_STATE.SELECTING_DATE), conv(CONVERSATION_STATE.SELECTING_SLOT));

      const flow = await only();
      expect(flow.furthestState).toBe(CONVERSATION_STATE.SELECTING_SLOT);
      expect(flow.steps).toBe(3);
    });

    it("does not move a customer's progress backwards when they change their mind", async () => {
      await step(null, conv(CONVERSATION_STATE.SELECTING_SLOT));
      // Back out to pick a different service. They still got as far as the slots,
      // and reporting them as dropping off at the service menu would point the
      // usability finding at the wrong screen.
      await step(conv(CONVERSATION_STATE.SELECTING_SLOT), conv(CONVERSATION_STATE.SELECTING_SERVICE));

      expect((await only()).furthestState).toBe(CONVERSATION_STATE.SELECTING_SLOT);
    });

    it('closes as booked, carrying the appointment it produced', async () => {
      await step(null, conv(CONVERSATION_STATE.CONFIRMING));
      await step(conv(CONVERSATION_STATE.CONFIRMING), null, { bookingId: 'booking-xyz' });

      const flow = await only();
      expect(flow.outcome).toBe(FLOW_OUTCOME.BOOKED);
      expect(flow.bookingId).toBe('booking-xyz');
    });

    it('records a booking even if the flow was never opened', async () => {
      // The success must not be lost when an earlier write failed, or the funnel
      // would read worse than the system performed.
      await step(conv(CONVERSATION_STATE.CONFIRMING), null, { bookingId: 'booking-orphan' });

      const flow = await only();
      expect(flow.outcome).toBe(FLOW_OUTCOME.BOOKED);
      expect(flow.bookingId).toBe('booking-orphan');
    });

    it('counts each misread as it happens, not from the final counter', async () => {
      await step(null, conv(CONVERSATION_STATE.SELECTING_SERVICE));
      // Two fumbles...
      await step(
        conv(CONVERSATION_STATE.SELECTING_SERVICE),
        conv(CONVERSATION_STATE.SELECTING_SERVICE, { invalidCount: 1 }),
      );
      await step(
        conv(CONVERSATION_STATE.SELECTING_SERVICE, { invalidCount: 1 }),
        conv(CONVERSATION_STATE.SELECTING_SERVICE, { invalidCount: 2 }),
      );
      // ...then they get it right, and the counter resets to zero.
      await step(
        conv(CONVERSATION_STATE.SELECTING_SERVICE, { invalidCount: 2 }),
        conv(CONVERSATION_STATE.SELECTING_DATE),
      );

      // Reading the final counter would have recorded none of it.
      expect((await only()).invalidInputs).toBe(2);
    });

    it('distinguishes a customer the menu gave up on from one who chose to leave', async () => {
      await step(null, conv(CONVERSATION_STATE.SELECTING_SLOT));
      await step(
        conv(CONVERSATION_STATE.SELECTING_SLOT, { invalidCount: 2 }),
        conv(CONVERSATION_STATE.HELP, { invalidCount: 3 }),
      );

      expect((await only()).outcome).toBe(FLOW_OUTCOME.ESCALATED);
    });

    it('closes as left when the customer asks for a person from a standing start', async () => {
      await step(null, conv(CONVERSATION_STATE.SELECTING_SLOT));
      // HELP with no confusion behind it: they typed HELP.
      await step(conv(CONVERSATION_STATE.SELECTING_SLOT), conv(CONVERSATION_STATE.HELP));

      expect((await only()).outcome).toBe(FLOW_OUTCOME.LEFT);
    });

    it('closes as left when a global command interrupts the booking', async () => {
      await step(null, conv(CONVERSATION_STATE.SELECTING_DATE));
      // STOP clears the conversation entirely.
      await step(conv(CONVERSATION_STATE.SELECTING_DATE), null);

      const flow = await only();
      expect(flow.outcome).toBe(FLOW_OUTCOME.LEFT);
      expect(flow.furthestState).toBe(CONVERSATION_STATE.SELECTING_DATE);
    });

    it('marks a flow that is moving an appointment as a reschedule', async () => {
      await step(null, conv(CONVERSATION_STATE.SELECTING_DATE, { bookingId: 'old-booking' }));
      expect((await only()).kind).toBe(FLOW_KIND.RESCHEDULE);
    });

    it('recognises a reschedule discovered a turn after the flow opened', async () => {
      await step(null, conv(CONVERSATION_STATE.SELECTING_SERVICE));
      await step(
        conv(CONVERSATION_STATE.SELECTING_SERVICE),
        conv(CONVERSATION_STATE.SELECTING_DATE, { bookingId: 'old-booking' }),
      );

      expect((await only()).kind).toBe(FLOW_KIND.RESCHEDULE);
    });

    it('starts a new flow rather than reviving one abandoned last week', async () => {
      await step(null, conv(CONVERSATION_STATE.SELECTING_SERVICE), { at: ago(7) });
      // Redis dropped that conversation long ago; this is a fresh customer visit.
      await step(null, conv(CONVERSATION_STATE.SELECTING_SERVICE));

      const rows = await FlowRun.find({ businessId }).sort({ startedAt: 1 });
      expect(rows).toHaveLength(2);
      // The old one is left open on purpose — it becomes 'abandoned' by the clock,
      // and nothing ever writes an event the customer did not generate.
      expect(rows[0]!.outcome).toBeNull();
    });

    it('keeps one customer out of another flow', async () => {
      await step(null, conv(CONVERSATION_STATE.SELECTING_SERVICE), { clientId: 'client-a' });
      await step(null, conv(CONVERSATION_STATE.SELECTING_SERVICE), { clientId: 'client-b' });

      expect(await FlowRun.countDocuments({ businessId })).toBe(2);
    });

    it('never throws, because the customer is mid-booking', async () => {
      // An unstorable instant: the write fails validation inside the recorder.
      await expect(
        step(null, conv(CONVERSATION_STATE.SELECTING_SERVICE), { at: new Date(NaN) }),
      ).resolves.toBeUndefined();
    });
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // Booking completion
  // ─────────────────────────────────────────────────────────────────────────────

  describe('booking completion', () => {
    /**
     * Silent long enough to count as abandoned, and recently enough to count as live.
     *
     * Derived from the recorder's own constant rather than written as "a day ago", so
     * that changing the conversation TTL cannot leave these tests asserting against a
     * threshold the code no longer uses.
     */
    const silent = () => new Date(now.getTime() - FLOW_STALE_MS - 60_000);
    const active = () => new Date(now.getTime() - FLOW_STALE_MS / 2);

    /** A flow row, written directly so the metric is tested apart from the recorder. */
    const flow = (opts: {
      outcome?: string | null;
      furthest?: string;
      lastStepAt?: Date;
      startedAt?: Date;
      kind?: string;
      steps?: number;
      invalidInputs?: number;
    }) =>
      FlowRun.create({
        businessId,
        clientId: `c-${Math.random()}`,
        startedAt: opts.startedAt ?? ago(3),
        lastStepAt: opts.lastStepAt ?? ago(3),
        startedState: CONVERSATION_STATE.SELECTING_SERVICE,
        furthestState: opts.furthest ?? CONVERSATION_STATE.SELECTING_SLOT,
        kind: opts.kind ?? FLOW_KIND.NEW,
        steps: opts.steps ?? 4,
        invalidInputs: opts.invalidInputs ?? 0,
        outcome: opts.outcome ?? null,
      });

    it('treats a silent open flow as abandoned, and a live one as neither', async () => {
      await flow({ outcome: FLOW_OUTCOME.BOOKED });
      await flow({ outcome: null, lastStepAt: silent() });
      await flow({ outcome: null, lastStepAt: active() });

      const metric = await completionMetric(window);

      expect(metric.whatsapp).toMatchObject({ numerator: 1, denominator: 2 });
      expect(metric.whatsappOpen).toBe(1);
    });

    it('counts a flow the menu gave up on as a failure to complete', async () => {
      await flow({ outcome: FLOW_OUTCOME.BOOKED });
      await flow({ outcome: FLOW_OUTCOME.ESCALATED });

      const metric = await completionMetric(window);

      expect(metric.whatsapp).toMatchObject({ numerator: 1, denominator: 2 });
      expect(metric.whatsappEscalated).toBe(1);
    });

    it('excludes a customer who chose not to book', async () => {
      await flow({ outcome: FLOW_OUTCOME.BOOKED });
      await flow({ outcome: FLOW_OUTCOME.LEFT });

      const metric = await completionMetric(window);

      // A customer who decides against booking has not been failed by the booking
      // flow, and counting them would make the metric worse every time it worked.
      expect(metric.whatsapp).toMatchObject({ numerator: 1, denominator: 1 });
      expect(metric.whatsappLeft).toBe(1);
    });

    it('reports where the flows that failed stopped, ignoring the ones that left', async () => {
      await flow({ outcome: null, lastStepAt: silent(), furthest: CONVERSATION_STATE.SELECTING_SLOT });
      await flow({ outcome: null, lastStepAt: silent(), furthest: CONVERSATION_STATE.SELECTING_SLOT });
      await flow({ outcome: FLOW_OUTCOME.ESCALATED, furthest: CONVERSATION_STATE.SELECTING_SERVICE });
      await flow({ outcome: FLOW_OUTCOME.LEFT, furthest: CONVERSATION_STATE.CONFIRMING });

      const metric = await completionMetric(window);

      expect(metric.whatsappDropOff).toEqual([
        { state: CONVERSATION_STATE.SELECTING_SLOT, flows: 2 },
        { state: CONVERSATION_STATE.SELECTING_SERVICE, flows: 1 },
      ]);
    });

    it('averages the messages a booking cost, and the misreads on the way', async () => {
      await flow({ outcome: FLOW_OUTCOME.BOOKED, steps: 4, invalidInputs: 0 });
      await flow({ outcome: FLOW_OUTCOME.BOOKED, steps: 6, invalidInputs: 2 });

      const metric = await completionMetric(window);

      expect(metric.messagesPerBooking).toBe(5);
      expect(metric.invalidInputsPerFlow).toBe(1);
    });

    it('says nothing rather than zero when nobody booked', async () => {
      const metric = await completionMetric(window);

      expect(metric.whatsapp.rate).toBeNull();
      expect(metric.messagesPerBooking).toBeNull();
      expect(metric.invalidInputsPerFlow).toBeNull();
    });

    it('reports reschedules apart from new bookings', async () => {
      await flow({ outcome: FLOW_OUTCOME.BOOKED, kind: FLOW_KIND.NEW });
      await flow({ outcome: FLOW_OUTCOME.BOOKED, kind: FLOW_KIND.RESCHEDULE });
      await flow({ outcome: null, lastStepAt: silent(), kind: FLOW_KIND.RESCHEDULE });

      const metric = await completionMetric(window);

      expect(metric.whatsappReschedules).toMatchObject({ numerator: 1, denominator: 2 });
    });

    it('measures the web arm against form starts, in the business\'s own days', async () => {
      await FunnelDay.create({
        businessId,
        day: dayOf(-2),
        channel: 'marketplace',
        views: 40,
        starts: 10,
      });
      // Outside the window: must not enlarge the denominator.
      await FunnelDay.create({
        businessId,
        day: dayOf(-60),
        channel: 'marketplace',
        views: 400,
        starts: 100,
      });

      await webBooking(ago(2));
      await webBooking(ago(2));

      const metric = await completionMetric(window);

      expect(metric.web).toMatchObject({ numerator: 2, denominator: 10 });
    });

    it('reports a web rate over 100% rather than clamping it', async () => {
      // Three bookings, one recorded start. Found by running this against seeded
      // data, where bookings are written directly and the funnel counter never sees
      // them. Capping at 100% would hide the only signal that starts are missing.
      await FunnelDay.create({
        businessId,
        day: dayOf(-2),
        channel: 'marketplace',
        views: 4,
        starts: 1,
      });
      await webBooking(ago(2));
      await webBooking(ago(2));
      await webBooking(ago(2));

      const metric = await completionMetric(window);

      expect(metric.web).toMatchObject({ numerator: 3, denominator: 1 });
      expect(metric.web.rate).toBe(3);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // Session uptime — the headline metric
  // ─────────────────────────────────────────────────────────────────────────────

  describe('session uptime', () => {
    const transition = (opts: {
      status: string;
      at: Date;
      intent?: string;
      sessionId?: string;
      previous?: string | null;
    }) =>
      SessionEvent.create({
        businessId,
        sessionId: opts.sessionId ?? SESSION_ID,
        status: opts.status,
        previousStatus: opts.previous ?? null,
        intent: opts.intent ?? SESSION_INTENT.LIVE,
        source: 'webhook',
        occurredAt: opts.at,
      });

    it('measures a quiet month, whose transitions are all outside the window', async () => {
      // The naive query finds nothing in the window and reports no uptime — for the
      // business that performed best. The row before `from` is what saves it.
      await transition({ status: SESSION_STATUS.READY, at: ago(120) });

      const metric = await sessionUptime(businessId, window.from, window.to, now);

      expect(metric.rate).toBe(1);
      expect(metric.downMs).toBe(0);
      expect(metric.upMs).toBeGreaterThan(29 * DAY_MS);
      // Measurement begins at the window's start, not at a transition inside it.
      expect(metric.measuredFrom).toBe(window.from.toISOString());
    });

    it('reports a business that was never linked as unknown, not as always down', async () => {
      const metric = await sessionUptime(businessId, window.from, window.to, now);

      expect(metric.rate).toBeNull();
      expect(metric.measuredFrom).toBeNull();
      expect(metric.upMs).toBe(0);
      expect(metric.downMs).toBe(0);
    });

    it('counts a drop as downtime until it recovers', async () => {
      await transition({ status: SESSION_STATUS.READY, at: ago(20) });
      await transition({ status: SESSION_STATUS.QR_READY, at: ago(10) });
      await transition({ status: SESSION_STATUS.READY, at: ago(9) });

      const metric = await sessionUptime(businessId, window.from, window.to, now);

      expect(metric.outages).toBe(1);
      expect(metric.downMs).toBe(DAY_MS);
      expect(metric.longestOutageMs).toBe(DAY_MS);
    });

    it('holds neither up nor down against time we caused ourselves', async () => {
      await transition({ status: SESSION_STATUS.READY, at: ago(20) });
      // Deliberately stopped for two days — our maintenance, not the platform failing.
      await transition({ status: SESSION_STATUS.DISCONNECTED, at: ago(12), intent: SESSION_INTENT.STOPPED });
      await transition({ status: SESSION_STATUS.READY, at: ago(10) });

      const metric = await sessionUptime(businessId, window.from, window.to, now);

      expect(metric.untrackedMs).toBe(2 * DAY_MS);
      expect(metric.downMs).toBe(0);
      // Untracked time is in neither half of the fraction, so the rate is still 100%.
      expect(metric.rate).toBe(1);
      expect(metric.outages).toBe(0);
    });

    it('does not count a QR the owner asked for as an outage', async () => {
      await transition({ status: SESSION_STATUS.QR_READY, at: ago(20), intent: SESSION_INTENT.LINKING });
      await transition({ status: SESSION_STATUS.READY, at: ago(19) });

      const metric = await sessionUptime(businessId, window.from, window.to, now);

      expect(metric.outages).toBe(0);
      expect(metric.untrackedMs).toBe(DAY_MS);
    });

    it('runs the last interval to the clock, because no row says "still up"', async () => {
      await transition({ status: SESSION_STATUS.QR_READY, at: ago(2) });

      const metric = await sessionUptime(businessId, window.from, window.to, now);

      expect(metric.measuredTo).toBe(now.toISOString());
      expect(metric.downMs).toBe(2 * DAY_MS);
      // The outage is still running, and is still one outage.
      expect(metric.outages).toBe(1);
    });

    it('keeps two sessions apart, because a re-link is not one continuous run', async () => {
      await transition({ status: SESSION_STATUS.READY, at: ago(20), sessionId: 'session-old' });
      await transition({
        status: SESSION_STATUS.QR_READY,
        at: ago(15),
        sessionId: 'session-old',
      });
      await transition({ status: SESSION_STATUS.READY, at: ago(14), sessionId: 'session-new' });

      const metric = await sessionUptime(businessId, window.from, window.to, now);

      expect(metric.sessions).toHaveLength(2);
      const old = metric.sessions.find((s) => s.sessionId === 'session-old')!;
      const current = metric.sessions.find((s) => s.sessionId === 'session-new')!;

      expect(old.upMs).toBe(5 * DAY_MS);
      expect(old.outages).toBe(1);
      expect(old.current).toBe(false);
      expect(current.current).toBe(true);
    });

    it('never measures the future', async () => {
      await transition({ status: SESSION_STATUS.READY, at: ago(5) });

      const nextMonth = new Date(now.getTime() + 30 * DAY_MS);
      const metric = await sessionUptime(businessId, window.from, nextMonth, now);

      expect(metric.measuredTo).toBe(now.toISOString());
      expect(metric.upMs).toBe(5 * DAY_MS);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // No-show rate
  // ─────────────────────────────────────────────────────────────────────────────

  describe('no-show rate', () => {
    const appointment = (opts: {
      status: string;
      startsAt?: Date;
      depositMinor?: number | null;
      depositStatus?: string | null;
    }) =>
      Booking.create({
        businessId,
        clientId: `c-${Math.random()}`,
        serviceId: 'service-1',
        staffId: 'staff-1',
        startsAt: opts.startsAt ?? ago(5),
        durationMinutes: 45,
        status: opts.status,
        priceMinor: 500_000,
        source: 'whatsapp',
        depositMinor: opts.depositMinor ?? null,
        depositStatus: opts.depositStatus ?? null,
      });

    it('splits on whether a deposit was asked for', async () => {
      // Deposit arm: 1 of 4 stood us up.
      await appointment({ status: BOOKING_STATUS.NO_SHOW, depositMinor: 100_000, depositStatus: DEPOSIT_STATUS.PAID });
      for (let i = 0; i < 3; i++) {
        await appointment({ status: BOOKING_STATUS.COMPLETED, depositMinor: 100_000, depositStatus: DEPOSIT_STATUS.APPLIED });
      }
      // No-deposit arm: 2 of 4.
      await appointment({ status: BOOKING_STATUS.NO_SHOW });
      await appointment({ status: BOOKING_STATUS.NO_SHOW });
      await appointment({ status: BOOKING_STATUS.COMPLETED });
      await appointment({ status: BOOKING_STATUS.COMPLETED });

      const metric = await noShowMetric(window);

      expect(metric.withDeposit.rate).toBe(0.25);
      expect(metric.withoutDeposit.rate).toBe(0.5);
      expect(metric.differencePoints).toBeCloseTo(25);
    });

    it('ignores appointments that never reached their hour', async () => {
      await appointment({ status: BOOKING_STATUS.CONFIRMED, startsAt: new Date(now.getTime() + DAY_MS) });
      await appointment({ status: BOOKING_STATUS.CANCELLED });

      const metric = await noShowMetric(window);

      expect(metric.withoutDeposit.denominator).toBe(0);
      expect(metric.withoutDeposit.rate).toBeNull();
    });

    it('reports no difference when one arm has no sample', async () => {
      await appointment({ status: BOOKING_STATUS.NO_SHOW });

      const metric = await noShowMetric(window);

      expect(metric.withDeposit.rate).toBeNull();
      expect(metric.differencePoints).toBeNull();
    });

    it('flags deposit-required appointments that went unpaid', async () => {
      // The caveat that makes the first number readable: a deposit demanded and
      // never paid protected nothing.
      await appointment({
        status: BOOKING_STATUS.NO_SHOW,
        depositMinor: 100_000,
        depositStatus: DEPOSIT_STATUS.AWAITING,
      });

      expect((await noShowMetric(window)).unpaidWithDeposit).toBe(1);
    });

    it('windows on when the appointment was due, not when it was booked', async () => {
      await appointment({ status: BOOKING_STATUS.NO_SHOW, startsAt: ago(200) });

      expect((await noShowMetric(window)).withoutDeposit.denominator).toBe(0);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // Retention conversion
  // ─────────────────────────────────────────────────────────────────────────────

  describe('retention conversion', () => {
    let seq = 0;

    const message = (opts: {
      kind: string;
      status?: string;
      scheduledFor?: Date;
      rebooked?: boolean;
      replied?: boolean;
      cold?: boolean;
    }) =>
      Notification.create({
        businessId,
        clientId: `c-${seq}`,
        kind: opts.kind,
        dedupeKey: `eval-${businessId}-${seq++}`,
        scheduledFor: opts.scheduledFor ?? ago(20),
        status: opts.status ?? DELIVERY_STATUS.DELIVERED,
        rebookedBookingId: opts.rebooked ? 'booking-1' : null,
        repliedAt: opts.replied ? ago(19) : null,
        coldContact: opts.cold ?? false,
      });

    it('reports nudges and broadcasts separately', async () => {
      await message({ kind: NOTIFICATION_KIND.REBOOK_NUDGE, rebooked: true });
      await message({ kind: NOTIFICATION_KIND.REBOOK_NUDGE });
      await message({ kind: NOTIFICATION_KIND.CAMPAIGN, rebooked: true });
      await message({ kind: NOTIFICATION_KIND.CAMPAIGN, rebooked: true });
      await message({ kind: NOTIFICATION_KIND.CAMPAIGN });

      const metric = await retentionMetric(window);

      // Averaged together these would be 50% and hide that the broadcast did better.
      expect(metric.nudges.rate).toBe(0.5);
      expect(metric.campaigns.rate).toBeCloseTo(2 / 3);
    });

    it('excludes a message that never left the building', async () => {
      await message({ kind: NOTIFICATION_KIND.CAMPAIGN, rebooked: true });
      await message({ kind: NOTIFICATION_KIND.CAMPAIGN, status: DELIVERY_STATUS.QUEUED });
      await message({ kind: NOTIFICATION_KIND.CAMPAIGN, status: DELIVERY_STATUS.SKIPPED });

      const metric = await retentionMetric(window);

      // An outage is not a campaign that failed to convert.
      expect(metric.campaigns).toMatchObject({ numerator: 1, denominator: 1 });
      expect(metric.notSent).toBe(2);
    });

    it('names the sends whose fortnight has not closed yet', async () => {
      await message({ kind: NOTIFICATION_KIND.CAMPAIGN, scheduledFor: ago(3) });
      await message({ kind: NOTIFICATION_KIND.CAMPAIGN, scheduledFor: ago(25) });

      // A nudge sent three days ago has not failed — it has not finished.
      expect((await retentionMetric(window)).unresolved).toBe(1);
    });

    it('counts replies and cold contacts', async () => {
      await message({ kind: NOTIFICATION_KIND.CAMPAIGN, replied: true, cold: true });
      await message({ kind: NOTIFICATION_KIND.CAMPAIGN });

      const metric = await retentionMetric(window);

      expect(metric.replies.rate).toBe(0.5);
      expect(metric.coldContacts).toBe(1);
    });

    it('does not let a review request claim a booking', async () => {
      // A review request is marketing but not retention; crediting it would report
      // the nudge that did the work as converting nobody.
      await message({ kind: NOTIFICATION_KIND.REVIEW_REQUEST, rebooked: true });

      const metric = await retentionMetric(window);

      expect(metric.nudges.denominator).toBe(0);
      expect(metric.campaigns.denominator).toBe(0);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // Review capture
  // ─────────────────────────────────────────────────────────────────────────────

  describe('review capture', () => {
    let seq = 0;

    async function completedAppointment(completedAt: Date): Promise<string> {
      const booking = await Booking.create({
        businessId,
        clientId: `c-${seq++}`,
        serviceId: 'service-1',
        staffId: 'staff-1',
        startsAt: completedAt,
        durationMinutes: 45,
        status: BOOKING_STATUS.COMPLETED,
        priceMinor: 500_000,
        source: 'whatsapp',
        completedAt,
      });
      return String(booking._id);
    }

    const requested = (bookingId: string) =>
      Notification.create({
        businessId,
        clientId: 'c-x',
        bookingId,
        kind: NOTIFICATION_KIND.REVIEW_REQUEST,
        dedupeKey: `${bookingId}:review_request`,
        scheduledFor: ago(4),
        status: DELIVERY_STATUS.DELIVERED,
      });

    const rated = (bookingId: string, rating: number, published = rating >= 4) =>
      Review.create({
        businessId,
        bookingId,
        clientId: 'c-x',
        authorName: 'Sara',
        rating,
        published,
      });

    it('separates whether we asked from whether they answered', async () => {
      const a = await completedAppointment(ago(5));
      const b = await completedAppointment(ago(5));
      await completedAppointment(ago(5)); // never asked
      await requested(a);
      await requested(b);
      await rated(a, 5);

      const metric = await reviewMetric(window);

      // Two of three appointments were asked; one of two answered. One number could
      // not have told those apart.
      expect(metric.requested).toMatchObject({ numerator: 2, denominator: 3 });
      expect(metric.captured).toMatchObject({ numerator: 1, denominator: 2 });
    });

    it('cannot exceed 100% from a rating that belongs to an earlier window', async () => {
      const old = await completedAppointment(ago(200));
      await requested(old);
      await rated(old, 5);

      const inside = await completedAppointment(ago(5));
      await requested(inside);

      const metric = await reviewMetric(window);

      expect(metric.captured).toMatchObject({ numerator: 0, denominator: 1 });
    });

    it('says nothing rather than zero with no completed appointments', async () => {
      const metric = await reviewMetric(window);

      expect(metric.captured.rate).toBeNull();
      expect(metric.requested.rate).toBeNull();
      expect(metric.averageRating).toBeNull();
    });

    it('reports the distribution and what a stranger can see', async () => {
      const a = await completedAppointment(ago(5));
      const b = await completedAppointment(ago(5));
      await requested(a);
      await requested(b);
      await rated(a, 5);
      await rated(b, 2);

      const metric = await reviewMetric(window);

      expect(metric.distribution).toEqual([0, 1, 0, 0, 1]);
      expect(metric.averageRating).toBe(3.5);
      expect(metric.published).toBe(1);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // Adoption
  // ─────────────────────────────────────────────────────────────────────────────

  describe('adoption', () => {
    it('splits customer-made bookings from ones the owner typed in', async () => {
      await madeBooking('whatsapp', ago(3));
      await madeBooking('whatsapp', ago(3));
      await madeBooking('web', ago(3));
      await madeBooking('owner', ago(3));

      const metric = await adoptionMetric(window);

      expect(metric.total).toBe(4);
      expect(metric.automated).toBe(3);
      expect(metric.manual).toBe(1);
      expect(metric.automatedShare.rate).toBe(0.75);
    });

    it('groups weeks by the business\'s own Monday, not the server\'s', async () => {
      // 02:00 Monday in Karachi is still Sunday in UTC. Grouped on UTC this would
      // land in the previous week.
      const mondayEarly = NOW.startOf('week').set({ hour: 2 }).toJSDate();
      await madeBooking('whatsapp', mondayEarly);

      const metric = await adoptionMetric(window);

      expect(metric.weeks).toHaveLength(1);
      expect(metric.weeks[0]!.from).toBe(NOW.startOf('week').toISODate());
    });

    it('windows on when the booking was made, not when the appointment is', async () => {
      // A quiet week in which twenty appointments were booked for next month was a
      // busy week for the product.
      await madeBooking('whatsapp', ago(2), new Date(now.getTime() + 60 * DAY_MS));

      expect((await adoptionMetric(window)).total).toBe(1);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // Agent engagement
  // ─────────────────────────────────────────────────────────────────────────────

  describe('agent engagement', () => {
    let seq = 0;

    const briefing = (opts: { kind: string; read?: boolean; gemini?: boolean; at?: Date }) =>
      Briefing.create({
        businessId,
        kind: opts.kind,
        dedupeKey: `eval-brief-${seq++}`,
        scheduledFor: opts.at ?? ago(5),
        headline: 'Something happened',
        body: 'A sentence about it.',
        facts: { kind: opts.kind },
        phrasedBy: opts.gemini ? PHRASED_BY.GEMINI : PHRASED_BY.TEMPLATE,
        readAt: opts.read ? ago(4) : null,
      });

    it('counts only an explicit gesture as engagement', async () => {
      await briefing({ kind: BRIEFING_KIND.DAILY, read: true });
      await briefing({ kind: BRIEFING_KIND.DAILY });
      await briefing({ kind: BRIEFING_KIND.ALERT, read: true });

      const metric = await agentMetric(window);

      expect(metric.briefings).toBe(3);
      expect(metric.read).toMatchObject({ numerator: 2, denominator: 3 });
    });

    it('separates the kinds, so a daily nobody opens is visible', async () => {
      await briefing({ kind: BRIEFING_KIND.DAILY });
      await briefing({ kind: BRIEFING_KIND.DAILY });
      await briefing({ kind: BRIEFING_KIND.ALERT, read: true });

      const metric = await agentMetric(window);

      const daily = metric.byKind.find((k) => k.kind === BRIEFING_KIND.DAILY)!;
      const alert = metric.byKind.find((k) => k.kind === BRIEFING_KIND.ALERT)!;

      expect(daily.read.rate).toBe(0);
      expect(alert.read.rate).toBe(1);
    });

    it('reports how often the LLM was reached at all', async () => {
      await briefing({ kind: BRIEFING_KIND.DAILY, gemini: true });
      await briefing({ kind: BRIEFING_KIND.DAILY });

      expect((await agentMetric(window)).phrasedByLlm.rate).toBe(0.5);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // The whole set — the milestone's actual DoD
  // ─────────────────────────────────────────────────────────────────────────────

  describe('the whole set', () => {
    it('runs end to end and agrees with itself about the window', async () => {
      await madeBooking('whatsapp', ago(3));
      await FlowRun.create({
        businessId,
        clientId: 'c-report',
        startedAt: ago(3),
        lastStepAt: ago(3),
        startedState: CONVERSATION_STATE.SELECTING_SERVICE,
        furthestState: CONVERSATION_STATE.CONFIRMING,
        outcome: FLOW_OUTCOME.BOOKED,
        bookingId: 'b-1',
      });
      await SessionEvent.create({
        businessId,
        sessionId: SESSION_ID,
        status: SESSION_STATUS.READY,
        previousStatus: null,
        intent: SESSION_INTENT.LIVE,
        source: 'webhook',
        occurredAt: ago(40),
      });

      const report = await buildEvaluation(businessId, dayOf(-30), dayOf(0), now);

      expect(report.businessName).toBe('Evaluation Test Clinic');
      expect(report.timezone).toBe(TZ);
      expect(report.from).toBe(dayOf(-30));
      expect(report.adoption.total).toBe(1);
      expect(report.completion.whatsapp.rate).toBe(1);
      expect(report.uptime.rate).toBe(1);

      // Every metric answered. A pipeline where one of these is quietly undefined is
      // exactly what building it before the pilot is meant to catch.
      for (const key of ['noShow', 'retention', 'completion', 'uptime', 'adoption', 'reviews', 'agent'] as const) {
        expect(report[key]).toBeDefined();
      }
    });

    it('refuses a business that does not exist rather than reporting zeros', async () => {
      await expect(
        buildEvaluation(String(new mongoose.Types.ObjectId()), dayOf(-30), dayOf(0), now),
      ).rejects.toThrow(/no business/);
    });
  });

  // ─── fixtures shared across the metric groups ──────────────────────────────

  let bookingSeq = 0;

  /**
   * A booking whose `createdAt` is set explicitly.
   *
   * Written through the raw driver, because Mongoose declares `createdAt` immutable
   * when timestamps are on and silently DROPS it from a `$set` — the update reports
   * success and changes nothing. Adoption windows on when a booking was MADE, so a
   * fixture that cannot control that would only ever test today, and would have
   * passed here by coincidence on any day inside the window.
   */
  async function madeBooking(
    source: 'whatsapp' | 'web' | 'owner',
    createdAt: Date,
    startsAt = new Date(createdAt.getTime() + DAY_MS),
  ): Promise<string> {
    const booking = await Booking.create({
      businessId,
      clientId: `made-${bookingSeq++}`,
      serviceId: 'service-1',
      staffId: 'staff-1',
      startsAt,
      durationMinutes: 45,
      status: BOOKING_STATUS.CONFIRMED,
      priceMinor: 500_000,
      source,
    });

    await Booking.collection.updateOne({ _id: booking._id }, { $set: { createdAt } });
    return String(booking._id);
  }

  const webBooking = (createdAt: Date) => madeBooking('web', createdAt);
});
