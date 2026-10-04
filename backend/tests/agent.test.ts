import mongoose from 'mongoose';
import { DateTime } from 'luxon';
import { Redis } from 'ioredis';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { MessagingProvider, SendResult } from '@scalivo/shared';
import {
  ALERT_TYPE,
  BOOKING_STATUS,
  BRIEFING_KIND,
  LAPSED_PILEUP_MIN,
  PHRASED_BY,
  SESSION_STATUS,
  type AlertFacts,
  type DailyFacts,
  type WeeklyFacts,
} from '@scalivo/shared';
import { Booking } from '../src/models/Booking.js';
import { Briefing } from '../src/models/Briefing.js';
import { Business } from '../src/models/Business.js';
import { Campaign } from '../src/models/Campaign.js';
import { Client } from '../src/models/Client.js';
import { ClientProfile } from '../src/models/ClientProfile.js';
import { Service } from '../src/models/Service.js';
import { Staff } from '../src/models/Staff.js';
import { briefBusiness, briefingDueAt } from '../src/agent/job.js';
import { dailyFacts, weeklyFacts } from '../src/agent/facts.js';
import { detectAlerts } from '../src/agent/thresholds.js';
import { sameNumbers } from '../src/agent/gemini.js';
import { infraReady } from './infra.js';

/**
 * The agent — SPEC §11.
 *
 * The thing worth testing here is not that a briefing can be produced. It is the
 * four properties that decide whether an owner keeps the notifications switched
 * on, and every one of them is a way this feature fails quietly:
 *
 * 1. **Once, at the right time, in the business's own clock.** A pass on a UTC
 *    timer deciding a business-local 7am is the classic bug, and a pass that
 *    overlaps itself briefs the same morning twice.
 * 2. **The numbers are the same numbers the dashboard shows.** The briefing reads
 *    the analytics and retention code rather than reimplementing it, so these
 *    tests check the facts, which is where a divergence would appear.
 * 3. **The alerts do not cry wolf.** Most of the alert tests are about NOT
 *    firing: too small a sample, a day the business is closed, a condition that
 *    already fired this week. An alert an owner learns to swipe away costs them
 *    the one that matters.
 * 4. **The LLM cannot change a figure.** The phrasing layer is allowed to reword
 *    and nothing else, and the check that enforces it is tested directly — no key
 *    is needed, and no test here calls Gemini.
 *
 * Needs Mongo (replica set) and Redis.
 */

const TZ = 'Asia/Karachi';
const SESSION_ID = 'agent-test-session';
const DAY_MS = 86_400_000;

/**
 * A fixed Wednesday, in the business's zone.
 *
 * Fixed rather than "now" because two of these tests depend on the day of the
 * week — a Monday fires the weekly summary, which would then be the thing
 * blocking the alert under test — and a suite that passes six days out of seven
 * is worse than one that fails, since nobody sees it fail on the Monday.
 */
const WEDNESDAY = DateTime.fromISO('2026-09-16T00:00', { zone: TZ }).startOf('week').plus({ days: 2 });

/** Business-local wall clock on that Wednesday, as an instant. */
const at = (hour: number, minute = 5) => WEDNESDAY.set({ hour, minute }).toJSDate();

/** The same wall clock on the Monday of that week. */
const monday = (hour: number, minute = 5) =>
  WEDNESDAY.startOf('week').set({ hour, minute }).toJSDate();

class FakeProvider implements MessagingProvider {
  readonly name = 'fake';
  sent: { to: string; text: string }[] = [];

  async sendText(_sessionId: string, to: string, text: string): Promise<SendResult> {
    this.sent.push({ to, text });
    return { providerMessageId: `agent-${this.sent.length}`, acceptedAt: new Date() };
  }
  async getSessionStatus() {
    return SESSION_STATUS.READY;
  }
  async startSession() {
    return { status: SESSION_STATUS.READY };
  }
  async getSessionQr() {
    return null;
  }
  async provisionSession() {
    return { sessionId: 'fake-session', status: SESSION_STATUS.READY };
  }
  async registerWebhook() {
    /* the agent never provisions */
  }
  async getSessionPhone() {
    return '923001112222';
  }
  async resolveContactPhone() {
    return null;
  }
  parseWebhook() {
    return [];
  }
}

const infraUp = await infraReady({ replicaSet: true, redis: true });

describe.skipIf(!infraUp)('agent', () => {
  let redis: Redis;
  let provider: FakeProvider;
  let deps: { redis: Redis; provider: FakeProvider };
  let businessId: string;
  let serviceId: string;
  let staffId: string;

  /** Clients this suite invents, cleaned up by id — Client is global. */
  const made: string[] = [];

  const ago = (days: number, from: Date) => new Date(from.getTime() - days * DAY_MS);

  /** The business doc, re-read so a settings change in a test is picked up. */
  const fresh = async () => (await Business.findById(businessId))!;

  const localDate = (instant: Date) =>
    DateTime.fromJSDate(instant, { zone: 'utc' }).setZone(TZ).toISODate()!;

  /**
   * An appointment. Everything the agent reads about a day comes from these, so
   * the tests build them directly rather than through the booking path — which
   * would test availability and slot locking instead.
   */
  async function booking(opts: {
    startsAt: Date;
    status?: string;
    priceMinor?: number;
    durationMinutes?: number;
    clientId?: string;
  }) {
    return Booking.create({
      businessId,
      clientId: opts.clientId ?? (await customer('Walk-in')),
      serviceId,
      staffId,
      startsAt: opts.startsAt,
      durationMinutes: opts.durationMinutes ?? 45,
      status: opts.status ?? BOOKING_STATUS.CONFIRMED,
      priceMinor: opts.priceMinor ?? 500_000,
      source: 'whatsapp',
    });
  }

  async function customer(name: string, profile: Partial<{
    visits: number;
    firstVisitDaysAgo: number;
    lastVisitDaysAgo: number;
    from: Date;
  }> = {}): Promise<string> {
    const client = await Client.create({
      phone: `9230077${String(made.length).padStart(5, '0')}`,
      displayName: name,
    });
    const clientId = String(client._id);
    made.push(clientId);

    const from = profile.from ?? at(13);
    await ClientProfile.create({
      businessId,
      clientId,
      totalVisits: profile.visits ?? 0,
      lifetimeSpendMinor: (profile.visits ?? 0) * 500_000,
      firstVisitAt: profile.firstVisitDaysAgo === undefined ? null : ago(profile.firstVisitDaysAgo, from),
      lastVisitAt: profile.lastVisitDaysAgo === undefined ? null : ago(profile.lastVisitDaysAgo, from),
      lastBookingAt: profile.lastVisitDaysAgo === undefined ? null : ago(profile.lastVisitDaysAgo, from),
      serviceCounts: new Map([[serviceId, profile.visits ?? 0]]),
    });

    return clientId;
  }

  /** Lapsed: four visits, last seen four months before `from`. */
  const lapsedCustomer = (name: string, from: Date) =>
    customer(name, { visits: 4, firstVisitDaysAgo: 210, lastVisitDaysAgo: 120, from });

  /** The roster the fixtures use: one member, 09:00–18:00, on the given weekdays. */
  async function roster(days = [0, 1, 2, 3, 4, 5, 6]) {
    await Staff.deleteMany({ businessId });
    const staff = await Staff.create({
      businessId,
      name: 'Ayesha',
      serviceIds: [serviceId],
      workingHours: days.map((dayOfWeek) => ({
        dayOfWeek,
        opensAt: '09:00',
        closesAt: '18:00',
      })),
    });
    staffId = String(staff._id);
  }

  const briefings = () => Briefing.find({ businessId }).sort({ scheduledFor: 1 });

  beforeAll(async () => {
    // db 9 — 1–8 belong to the suites that came before this one.
    redis = new Redis(process.env.REDIS_URL!, { db: 9 });
    await Briefing.syncIndexes();
  });

  afterAll(async () => {
    await Promise.all([mongoose.disconnect(), redis.quit()]);
  });

  beforeEach(async () => {
    provider = new FakeProvider();
    deps = { redis, provider };

    const doc = await Business.findOneAndUpdate(
      { slug: 'agent-test' },
      {
        slug: 'agent-test',
        name: 'Agent Test Salon',
        category: 'salon',
        timezone: TZ,
        whatsapp: { sessionId: SESSION_ID },
        'agent.briefings': true,
        'agent.hour': 7,
        'agent.whatsappTo': null,
      },
      { upsert: true, new: true, setDefaultsOnInsert: true },
    );
    businessId = String(doc!._id);

    const previous = await ClientProfile.distinct('clientId', { businessId });
    await Client.deleteMany({ _id: { $in: [...previous, ...made] } });
    made.length = 0;

    await Promise.all([
      Booking.deleteMany({ businessId }),
      Briefing.deleteMany({ businessId }),
      Campaign.deleteMany({ businessId }),
      ClientProfile.deleteMany({ businessId }),
      Service.deleteMany({ businessId }),
      redis.flushdb(),
    ]);

    const service = await Service.create({
      businessId,
      name: 'Hydrafacial',
      durationMinutes: 45,
      priceMinor: 500_000,
    });
    serviceId = String(service._id);

    await roster();
  });

  /* ==================================================== when it fires */

  describe('the trigger', () => {
    it('sends the morning briefing once the local hour arrives', async () => {
      await booking({ startsAt: WEDNESDAY.set({ hour: 11 }).toJSDate() });

      const sent = await briefBusiness(deps, await fresh(), at(7));

      expect(sent.filter((r) => r.sent)).toHaveLength(1);
      const rows = await briefings();
      expect(rows).toHaveLength(1);
      expect(rows[0]!.kind).toBe(BRIEFING_KIND.DAILY);
      expect(rows[0]!.dedupeKey).toBe(`daily:${WEDNESDAY.toISODate()}`);
    });

    it('stays quiet before the hour', async () => {
      await briefBusiness(deps, await fresh(), at(6, 30));
      expect(await briefings()).toHaveLength(0);
    });

    /**
     * The property the whole claim-first design exists for. A pass that overlaps
     * itself, or a container restarting between the two calls, must not brief the
     * same morning twice — an owner who gets two identical notifications has
     * learned something false about how reliable this is.
     */
    it('never briefs the same morning twice', async () => {
      await briefBusiness(deps, await fresh(), at(7));
      const second = await briefBusiness(deps, await fresh(), at(7, 20));

      expect(second).toEqual([{ sent: false, reason: 'already_sent' }]);
      expect(await briefings()).toHaveLength(1);
    });

    /**
     * A briefing about today's diary, delivered at four in the afternoon, is a
     * report about a day the owner has already lived. Better to say nothing.
     */
    it('gives up on a morning briefing that is hours late', async () => {
      await briefBusiness(deps, await fresh(), at(16));
      expect(await briefings()).toHaveLength(0);
    });

    it('honours the hour the owner chose', async () => {
      await Business.updateOne({ _id: businessId }, { $set: { 'agent.hour': 10 } });

      await briefBusiness(deps, await fresh(), at(7));
      expect(await briefings()).toHaveLength(0);

      await briefBusiness(deps, await fresh(), at(10));
      expect(await briefings()).toHaveLength(1);
    });

    it('sends nothing at all when briefings are switched off', async () => {
      await Business.updateOne({ _id: businessId }, { $set: { 'agent.briefings': false } });

      expect(await briefBusiness(deps, await fresh(), at(7))).toEqual([]);
      expect(await briefings()).toHaveLength(0);
    });

    it('adds a weekly summary on Monday, as a separate briefing', async () => {
      const sent = await briefBusiness(deps, await fresh(), monday(7));

      expect(sent.filter((r) => r.sent)).toHaveLength(2);
      const kinds = (await briefings()).map((row) => row.kind);
      expect(kinds).toContain(BRIEFING_KIND.DAILY);
      expect(kinds).toContain(BRIEFING_KIND.WEEKLY);
    });

    it('does not repeat the weekly summary later on the same Monday', async () => {
      await briefBusiness(deps, await fresh(), monday(7));
      await briefBusiness(deps, await fresh(), monday(15));

      const weekly = (await briefings()).filter((row) => row.kind === BRIEFING_KIND.WEEKLY);
      expect(weekly).toHaveLength(1);
    });

    /**
     * The weekly summary is deliberately allowed all day, unlike the daily
     * briefing's four hours: a summary of last week is exactly as true at 3pm, so
     * a morning of downtime should not cost the owner their only look at it.
     */
    it('still sends the weekly summary after a morning of downtime', async () => {
      await briefBusiness(deps, await fresh(), monday(15));

      const rows = await briefings();
      expect(rows.map((row) => row.kind)).toEqual([BRIEFING_KIND.WEEKLY]);
    });

    /**
     * The weekly summary still goes out on a closed Monday — it is about last
     * week, not about today — so this checks the daily alone is suppressed.
     */
    it('says nothing on a day the business is closed and empty', async () => {
      await Staff.updateMany({ businessId }, { $set: { workingHours: [] } });

      await briefBusiness(deps, await fresh(), at(7));
      expect(await briefings()).toHaveLength(0);
    });

    it('still briefs a closed day that has an appointment on it', async () => {
      await booking({ startsAt: WEDNESDAY.set({ hour: 10 }).toJSDate() });
      await Staff.updateMany({ businessId }, { $set: { workingHours: [] } });

      await briefBusiness(deps, await fresh(), at(7));

      const rows = await briefings();
      expect(rows).toHaveLength(1);
      expect((rows[0]!.facts as DailyFacts).appointments).toBe(1);
    });

    it('computes the due moment in the business zone, not the server one', () => {
      const due = briefingDueAt('2026-09-16', 7, TZ);
      // 07:00 in Karachi is 02:00 UTC. A server-local reading would give 07:00Z.
      expect(due.toISOString()).toBe('2026-09-16T02:00:00.000Z');
    });
  });

  /* ================================================= what it knows */

  describe("the day's facts", () => {
    it("names the day's volume, value and shape", async () => {
      const client = await customer('Fatima', { visits: 3, firstVisitDaysAgo: 90, lastVisitDaysAgo: 30, from: at(7) });
      await booking({
        startsAt: WEDNESDAY.set({ hour: 10 }).toJSDate(),
        priceMinor: 500_000,
        clientId: client,
      });
      await booking({
        startsAt: WEDNESDAY.set({ hour: 16 }).toJSDate(),
        priceMinor: 300_000,
        durationMinutes: 90,
      });

      const facts = await dailyFacts(businessId, TZ, WEDNESDAY.toISODate()!);

      expect(facts.appointments).toBe(2);
      expect(facts.expectedRevenueMinor).toBe(800_000);
      expect(localDate(new Date(facts.firstStartsAt!))).toBe(WEDNESDAY.toISODate());
      // 16:00 plus 90 minutes. The last START would say 16:00 and be wrong about
      // when the owner actually gets to go home.
      expect(new Date(facts.lastEndsAt!).toISOString()).toBe(
        WEDNESDAY.set({ hour: 17, minute: 30 }).toUTC().toISO({ suppressMilliseconds: false }),
      );
    });

    it('counts the bookings still waiting to be confirmed', async () => {
      await booking({ startsAt: WEDNESDAY.set({ hour: 10 }).toJSDate(), status: BOOKING_STATUS.PENDING });
      await booking({
        startsAt: WEDNESDAY.set({ hour: 11 }).toJSDate(),
        status: BOOKING_STATUS.AWAITING_DEPOSIT,
      });
      await booking({ startsAt: WEDNESDAY.set({ hour: 12 }).toJSDate() });

      const facts = await dailyFacts(businessId, TZ, WEDNESDAY.toISODate()!);
      expect(facts.unconfirmed).toBe(2);
      expect(facts.appointments).toBe(3);
    });

    it('leaves a cancelled appointment out of the day entirely', async () => {
      await booking({
        startsAt: WEDNESDAY.set({ hour: 10 }).toJSDate(),
        status: BOOKING_STATUS.CANCELLED,
        priceMinor: 900_000,
      });

      const facts = await dailyFacts(businessId, TZ, WEDNESDAY.toISODate()!);
      expect(facts.appointments).toBe(0);
      expect(facts.expectedRevenueMinor).toBe(0);
    });

    it('reports the hours still free against the roster, summed across staff', async () => {
      await booking({ startsAt: WEDNESDAY.set({ hour: 10 }).toJSDate(), durationMinutes: 60 });

      const one = await dailyFacts(businessId, TZ, WEDNESDAY.toISODate()!);
      // One member, 09:00–18:00, one hour sold.
      expect(one.openHours).toBe(8);

      await Staff.create({
        businessId,
        name: 'Sana',
        serviceIds: [serviceId],
        workingHours: [{ dayOfWeek: WEDNESDAY.weekday === 7 ? 0 : WEDNESDAY.weekday, opensAt: '09:00', closesAt: '18:00' }],
      });

      const two = await dailyFacts(businessId, TZ, WEDNESDAY.toISODate()!);
      // Two chairs is eighteen hours of capacity, not nine. Reporting nine would
      // tell a two-chair salon it was full with half its chairs empty.
      expect(two.openHours).toBe(17);
    });

    it('takes breaks out of the capacity', async () => {
      await Staff.updateMany(
        { businessId },
        {
          $set: {
            workingHours: [
              {
                dayOfWeek: WEDNESDAY.weekday === 7 ? 0 : WEDNESDAY.weekday,
                opensAt: '09:00',
                closesAt: '18:00',
                breaks: [{ startsAt: '13:00', endsAt: '14:00' }],
              },
            ],
          },
        },
      );

      const facts = await dailyFacts(businessId, TZ, WEDNESDAY.toISODate()!);
      expect(facts.openHours).toBe(8);
    });

    it('counts the customers who have never been in before', async () => {
      const returning = await customer('Hina', { visits: 6, firstVisitDaysAgo: 200, lastVisitDaysAgo: 20, from: at(7) });
      const first = await customer('Maryam');

      await booking({ startsAt: WEDNESDAY.set({ hour: 10 }).toJSDate(), clientId: returning });
      await booking({ startsAt: WEDNESDAY.set({ hour: 11 }).toJSDate(), clientId: first });

      const facts = await dailyFacts(businessId, TZ, WEDNESDAY.toISODate()!);
      expect(facts.firstTimers).toBe(1);
    });

    it('says an empty diary is empty, and offers something to do about it', async () => {
      const sent = await briefBusiness(deps, await fresh(), at(7));
      expect(sent[0]!.sent).toBe(true);

      const row = (await briefings())[0]!;
      const facts = row.facts as DailyFacts;
      expect(facts.appointments).toBe(0);
      expect(row.headline.toLowerCase()).toContain('nothing booked');
      expect(row.actions.map((a) => a.href)).toContain('/grow/broadcast?audience=lapsed');
    });
  });

  describe("the week's facts", () => {
    it('compares last week against the week before it', async () => {
      const lastWeek = WEDNESDAY.startOf('week').minus({ days: 4 });
      const weekBefore = WEDNESDAY.startOf('week').minus({ days: 11 });

      await booking({ startsAt: lastWeek.toJSDate(), status: BOOKING_STATUS.COMPLETED, priceMinor: 600_000 });
      await booking({ startsAt: weekBefore.toJSDate(), status: BOOKING_STATUS.COMPLETED, priceMinor: 300_000 });

      const facts = await weeklyFacts(businessId, TZ, monday(7));

      expect(facts.revenueMinor).toBe(600_000);
      expect(facts.previousRevenueMinor).toBe(300_000);
      expect(facts.completed).toBe(1);
      expect(facts.topServiceName).toBe('Hydrafacial');
    });

    /**
     * A percentage against a week with no revenue is either a division by zero or
     * an infinite improvement. Both are worse than saying there is nothing to
     * compare against, so the template has to say it — and this is the test that
     * the numbers reaching it make that possible.
     */
    it('reports no comparison when the week before was empty', async () => {
      const lastWeek = WEDNESDAY.startOf('week').minus({ days: 4 });
      await booking({ startsAt: lastWeek.toJSDate(), status: BOOKING_STATUS.COMPLETED, priceMinor: 600_000 });

      await briefBusiness(deps, await fresh(), monday(7));

      const row = (await briefings()).find((r) => r.kind === BRIEFING_KIND.WEEKLY)!;
      expect((row.facts as WeeklyFacts).previousRevenueMinor).toBe(0);
      expect(row.body).toContain('nothing to compare');
    });

    it('counts customers overdue against their own rhythm', async () => {
      // Four visits a month apart, last seen 50 days ago: their own gap is 30
      // days and they are past 1.5x it.
      await customer('Zainab', { visits: 4, firstVisitDaysAgo: 140, lastVisitDaysAgo: 50, from: monday(7) });

      const facts = await weeklyFacts(businessId, TZ, monday(7));
      expect(facts.dueToReturn).toBe(1);
    });
  });

  /* ==================================================== the alerts */

  describe('thresholds', () => {
    /** 13:00 on the Wednesday: too late for the daily briefing, inside waking hours. */
    const midweek = at(13);

    /** Enough history that an empty day is remarkable — used only where that is the point. */
    async function busyPast(perDay = 2) {
      const rows = [];
      for (let back = 1; back <= 28; back += 1) {
        for (let n = 0; n < perDay; n += 1) {
          rows.push({
            businessId,
            clientId: `history-${back}-${n}`,
            serviceId,
            staffId,
            startsAt: WEDNESDAY.minus({ days: back }).set({ hour: 10 + n }).toJSDate(),
            durationMinutes: 45,
            status: BOOKING_STATUS.COMPLETED,
            priceMinor: 500_000,
            source: 'owner' as const,
          });
        }
      }
      await Booking.insertMany(rows);
    }

    async function noShowHistory(opts: { recentNoShows: number; recentDone: number; baselineDone: number }) {
      const rows = [];
      for (let i = 0; i < opts.recentNoShows; i += 1) {
        rows.push(row(WEDNESDAY.minus({ days: 3 }).set({ hour: 9 + i }), BOOKING_STATUS.NO_SHOW));
      }
      for (let i = 0; i < opts.recentDone; i += 1) {
        rows.push(row(WEDNESDAY.minus({ days: 4 }).set({ hour: 9 + i }), BOOKING_STATUS.COMPLETED));
      }
      for (let i = 0; i < opts.baselineDone; i += 1) {
        rows.push(row(WEDNESDAY.minus({ days: 40 + i }).set({ hour: 10 }), BOOKING_STATUS.COMPLETED));
      }
      await Booking.insertMany(rows);

      function row(startsAt: DateTime, status: string) {
        return {
          businessId,
          clientId: `ns-${Math.random()}`,
          serviceId,
          staffId,
          startsAt: startsAt.toJSDate(),
          durationMinutes: 45,
          status,
          priceMinor: 500_000,
          source: 'owner' as const,
        };
      }
    }

    it("reports a no-show rate well above the business's own baseline", async () => {
      await noShowHistory({ recentNoShows: 4, recentDone: 4, baselineDone: 20 });

      const found = await detectAlerts(businessId, TZ, midweek);
      const spike = found.find((c) => c.type === ALERT_TYPE.NO_SHOW_SPIKE);

      expect(spike).toBeDefined();
      expect(spike!.facts.value).toBe(4);
      expect(spike!.facts.context).toBe(8);
    });

    /**
     * Two no-shows out of three is not a spike, it is a Tuesday. Without a
     * minimum sample this alert fires on the quietest week a business ever has,
     * which is exactly the week its owner least wants to be told off.
     */
    it('refuses to call a tiny sample a spike', async () => {
      await noShowHistory({ recentNoShows: 2, recentDone: 1, baselineDone: 20 });

      const found = await detectAlerts(businessId, TZ, midweek);
      expect(found.map((c) => c.type)).not.toContain(ALERT_TYPE.NO_SHOW_SPIKE);
    });

    it('stays quiet when this is simply normal for them', async () => {
      // A third of appointments were always no-shows here, and still are. Above
      // the floor, but not above their own history — so it is not news.
      await noShowHistory({ recentNoShows: 3, recentDone: 6, baselineDone: 0 });
      await Booking.insertMany(
        Array.from({ length: 30 }, (_, i) => ({
          businessId,
          clientId: `base-${i}`,
          serviceId,
          staffId,
          startsAt: WEDNESDAY.minus({ days: 40 + (i % 30) }).set({ hour: 10 }).toJSDate(),
          durationMinutes: 45,
          status: i % 3 === 0 ? BOOKING_STATUS.NO_SHOW : BOOKING_STATUS.COMPLETED,
          priceMinor: 500_000,
          source: 'owner' as const,
        })),
      );

      const found = await detectAlerts(businessId, TZ, midweek);
      expect(found.map((c) => c.type)).not.toContain(ALERT_TYPE.NO_SHOW_SPIKE);
    });

    it('names an empty day that is still worth filling', async () => {
      await busyPast();

      const found = await detectAlerts(businessId, TZ, midweek);
      const empty = found.find((c) => c.type === ALERT_TYPE.EMPTY_DAY);

      expect(empty).toBeDefined();
      expect((empty!.facts as AlertFacts).date).toBe(WEDNESDAY.plus({ days: 2 }).toISODate());
    });

    /**
     * The fastest way to lose an owner's trust in everything else the agent says
     * is to alert them that their day off is empty.
     */
    it('skips a day the business is closed', async () => {
      const closedOn = WEDNESDAY.plus({ days: 2 });
      const closedDow = closedOn.weekday === 7 ? 0 : closedOn.weekday;
      await roster([0, 1, 2, 3, 4, 5, 6].filter((day) => day !== closedDow));
      await busyPast(3);

      const found = await detectAlerts(businessId, TZ, midweek);
      const empty = found.find((c) => c.type === ALERT_TYPE.EMPTY_DAY);

      expect(empty).toBeDefined();
      expect((empty!.facts as AlertFacts).date).toBe(WEDNESDAY.plus({ days: 3 }).toISODate());
    });

    /**
     * A business in its first week has nothing but empty days. Telling it so
     * every afternoon is a notification stream that says only "you are new".
     */
    it('does not tell a brand-new business that its days are empty', async () => {
      const found = await detectAlerts(businessId, TZ, midweek);
      expect(found.map((c) => c.type)).not.toContain(ALERT_TYPE.EMPTY_DAY);
    });

    it('suggests a win-back once enough customers have lapsed', async () => {
      for (let i = 0; i < LAPSED_PILEUP_MIN; i += 1) {
        await lapsedCustomer(`Lapsed ${i}`, midweek);
      }

      const found = await detectAlerts(businessId, TZ, midweek);
      const pileup = found.find((c) => c.type === ALERT_TYPE.LAPSED_PILEUP);

      expect(pileup).toBeDefined();
      expect(pileup!.facts.value).toBe(LAPSED_PILEUP_MIN);
    });

    it('says nothing about lapsed customers when a broadcast just went out', async () => {
      for (let i = 0; i < LAPSED_PILEUP_MIN; i += 1) {
        await lapsedCustomer(`Lapsed ${i}`, midweek);
      }
      await Campaign.create({
        businessId,
        audience: 'lapsed',
        message: 'we miss you',
        recipients: 12,
      });

      const found = await detectAlerts(businessId, TZ, midweek);
      expect(found.map((c) => c.type)).not.toContain(ALERT_TYPE.LAPSED_PILEUP);
    });

    it('sends one alert at a time, even when several are true', async () => {
      await noShowHistory({ recentNoShows: 4, recentDone: 4, baselineDone: 20 });
      for (let i = 0; i < LAPSED_PILEUP_MIN; i += 1) {
        await lapsedCustomer(`Lapsed ${i}`, midweek);
      }

      const sent = await briefBusiness(deps, await fresh(), midweek);

      expect(sent.filter((r) => r.sent)).toHaveLength(1);
      const rows = await briefings();
      expect(rows).toHaveLength(1);
      // The order in detectAlerts is the priority: no-show behaviour is bleeding,
      // a pile of lapsed customers has been true for weeks and will keep.
      expect(rows[0]!.alertType).toBe(ALERT_TYPE.NO_SHOW_SPIKE);
    });

    it('does not repeat an alert within its cooldown', async () => {
      await noShowHistory({ recentNoShows: 4, recentDone: 4, baselineDone: 20 });

      await briefBusiness(deps, await fresh(), midweek);
      // A day later, the condition is still true and still not news.
      await briefBusiness(deps, await fresh(), at(13));
      await briefBusiness(deps, await fresh(), new Date(midweek.getTime() + DAY_MS));

      const alerts = (await briefings()).filter((row) => row.kind === BRIEFING_KIND.ALERT);
      expect(alerts).toHaveLength(1);
    });

    it('does not interrupt at night', async () => {
      await noShowHistory({ recentNoShows: 4, recentDone: 4, baselineDone: 20 });

      // 23:00 local: past the daily briefing, outside waking hours.
      await briefBusiness(deps, await fresh(), at(23));
      expect(await briefings()).toHaveLength(0);
    });

    /**
     * A Monday could otherwise fire the daily briefing, the weekly summary and an
     * alert inside one tick — three notifications in a second, which is how an
     * owner decides this is noise.
     */
    it('does not pile an alert on top of a briefing it just sent', async () => {
      await noShowHistory({ recentNoShows: 4, recentDone: 4, baselineDone: 20 });

      const sent = await briefBusiness(deps, await fresh(), at(7));

      expect(sent.filter((r) => r.sent)).toHaveLength(1);
      expect((await briefings())[0]!.kind).toBe(BRIEFING_KIND.DAILY);
    });
  });

  /* ============================================== phrasing and the record */

  describe('phrasing', () => {
    /**
     * The whole agent has to work with no API key, and this is the test that says
     * so: no Gemini configured, and the briefing still goes out with every figure
     * in it. SPEC §11.3 — never block the briefing on the LLM.
     */
    it('writes a complete briefing with no LLM at all', async () => {
      await booking({ startsAt: WEDNESDAY.set({ hour: 10 }).toJSDate(), priceMinor: 750_000 });

      await briefBusiness(deps, await fresh(), at(7));

      const row = (await briefings())[0]!;
      expect(row.phrasedBy).toBe(PHRASED_BY.TEMPLATE);
      expect(row.body).toContain('1 appointment');
      expect(row.body).toContain('7,500');
    });

    /**
     * The one error an owner would act on is a figure that changed in the
     * rewrite, so the check is mechanical rather than a polite instruction.
     */
    it('accepts a rewrite that only moves the words', () => {
      expect(
        sameNumbers(
          '3 appointments today, worth Rs 12,500. 1 not confirmed yet.',
          'You have 1 unconfirmed booking among 3 appointments today, worth Rs 12500.',
        ),
      ).toBe(true);
    });

    it('rejects a rewrite that changed a figure', () => {
      expect(
        sameNumbers('3 appointments today, worth Rs 12,500.', '4 appointments today, worth Rs 12,500.'),
      ).toBe(false);
      // Reusing a number that appears elsewhere must not pass either.
      expect(sameNumbers('3 appointments, 1 no-show.', '3 appointments, 3 no-shows.')).toBe(false);
    });

    it('treats 3.0 and 3 as the same figure', () => {
      expect(sameNumbers('3.0 hours free', '3 hours free')).toBe(true);
    });
  });

  describe('the record', () => {
    it('stores the facts beside the prose', async () => {
      await booking({ startsAt: WEDNESDAY.set({ hour: 10 }).toJSDate(), priceMinor: 750_000 });

      await briefBusiness(deps, await fresh(), at(7));

      const facts = (await briefings())[0]!.facts as DailyFacts;
      // Recomputing this later is not possible: the numbers describe a morning
      // that has passed. The evaluation chapter needs them as they were.
      expect(facts.kind).toBe(BRIEFING_KIND.DAILY);
      expect(facts.appointments).toBe(1);
      expect(facts.expectedRevenueMinor).toBe(750_000);
      expect(facts.date).toBe(WEDNESDAY.toISODate());
    });

    it('starts unread', async () => {
      await briefBusiness(deps, await fresh(), at(7));
      expect((await briefings())[0]!.readAt).toBeNull();
    });

    it("keeps one business out of another's feed", async () => {
      const other = await Business.findOneAndUpdate(
        { slug: 'agent-test-other' },
        { slug: 'agent-test-other', name: 'Someone Else', category: 'gym', timezone: TZ },
        { upsert: true, new: true, setDefaultsOnInsert: true },
      );

      // Staffed, or its day would be a closed day with nothing to brief.
      await Staff.create({
        businessId: String(other!._id),
        name: 'Someone',
        workingHours: [{ dayOfWeek: WEDNESDAY.weekday === 7 ? 0 : WEDNESDAY.weekday, opensAt: '09:00', closesAt: '18:00' }],
      });

      try {
        await briefBusiness(deps, await fresh(), at(7));
        await briefBusiness(deps, other!, at(7));

        expect(await briefings()).toHaveLength(1);
        expect(await Briefing.countDocuments({ businessId: String(other!._id) })).toBe(1);
      } finally {
        await Briefing.deleteMany({ businessId: String(other!._id) });
        await Staff.deleteMany({ businessId: String(other!._id) });
        await Business.deleteOne({ _id: other!._id });
      }
    });
  });

  describe('the optional WhatsApp copy', () => {
    it('sends nothing over WhatsApp by default', async () => {
      await briefBusiness(deps, await fresh(), at(7));
      expect(provider.sent).toHaveLength(0);
    });

    /**
     * And when a number IS configured, the copy must not invite a reply: an
     * inbound message from that number reaches the customer FSM, which would
     * answer a business owner with a booking menu.
     */
    it('copies to a configured number without asking for a reply', async () => {
      await Business.updateOne({ _id: businessId }, { $set: { 'agent.whatsappTo': '923009998888' } });

      await briefBusiness(deps, await fresh(), at(7));

      expect(provider.sent).toHaveLength(1);
      expect(provider.sent[0]!.to).toBe('923009998888');
      expect(provider.sent[0]!.text).toContain('Open Scalivo');
      expect(provider.sent[0]!.text.toLowerCase()).not.toContain('reply');
    });
  });
});
