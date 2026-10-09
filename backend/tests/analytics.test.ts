import type { AddressInfo } from 'node:net';
import express from 'express';
import mongoose from 'mongoose';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { BOOKING_STATUS, type AnalyticsReport, type Granularity } from '@scalivo/shared';
import { Booking } from '../src/models/Booking.js';
import { Business } from '../src/models/Business.js';
import { Client } from '../src/models/Client.js';
import { ClientProfile } from '../src/models/ClientProfile.js';
import { Service } from '../src/models/Service.js';
import { createAnalyticsRouter } from '../src/analytics/routes.js';
import { buildReport } from '../src/analytics/report.js';
import { signToken } from '../src/auth/jwt.js';
import { wallClockToUtc } from '../src/lib/time.js';
import { infraReady } from './infra.js';

/**
 * Revenue and analytics — milestone 2.4, SPEC §7.
 *
 * Two properties, and both fail silently rather than loudly, which is why they
 * are tested rather than eyeballed:
 *
 * 1. **Revenue is completed appointments.** A cancelled booking still has a
 *    price on it. Summing the collection is one word shorter than summing the
 *    completed ones and reports a business that is doing better than it is.
 *
 * 2. **Buckets are business-LOCAL.** Karachi is UTC+5, so an appointment at
 *    01:00 local is 20:00 UTC the PREVIOUS day. A UTC bucket puts it in
 *    yesterday, and nobody notices until a Monday looks dead. Several tests
 *    here deliberately use hours whose UTC date differs from the local one.
 *
 * Needs Mongo. No replica set: nothing here opens a transaction.
 */

const TZ = 'Asia/Karachi';
/** Response bodies are asserted field by field; typing each shape adds nothing. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const json = (res: Response): Promise<any> => res.json();

const infraUp = await infraReady();

describe.skipIf(!infraUp)('analytics', () => {
  let businessId: string;
  let otherBusinessId: string;
  let hydrafacial: string;
  let laser: string;
  let token: string;
  let serverUrl: string;
  let server: ReturnType<express.Express['listen']>;

  /** A booking at a business-local wall clock, in whatever state. */
  async function booking(options: {
    date: string;
    time: string;
    status: string;
    priceMinor?: number;
    serviceId?: string;
    clientId?: string;
  }) {
    return Booking.create({
      businessId,
      staffId: 'staff-1',
      clientId: options.clientId ?? 'client-1',
      serviceId: options.serviceId ?? hydrafacial,
      startsAt: wallClockToUtc(`${options.date}T${options.time}`, TZ),
      durationMinutes: 45,
      status: options.status,
      priceMinor: options.priceMinor ?? 100_000,
      source: 'whatsapp',
    });
  }

  const report = (
    from: string,
    to: string,
    granularity: Granularity = 'day',
    now?: Date,
  ): Promise<AnalyticsReport> =>
    buildReport({ businessId, timezone: TZ, from, to, granularity, ...(now ? { now } : {}) });

  beforeAll(async () => {
    const app = express();
    app.use('/businesses', createAnalyticsRouter());
    server = app.listen(0);
    const { port } = server.address() as AddressInfo;
    serverUrl = `http://127.0.0.1:${port}`;
  });

  afterAll(async () => {
    if (server) server.close();
    await mongoose.disconnect();
  });

  beforeEach(async () => {
    const business = await Business.findOneAndUpdate(
      { slug: 'analytics-test' },
      {
        slug: 'analytics-test',
        name: 'Analytics Test Salon',
        category: 'salon',
        timezone: TZ,
        slotIncrementMinutes: 15,
        minNoticeMinutes: 60,
        bookingHorizonDays: 30,
      },
      { upsert: true, new: true, setDefaultsOnInsert: true },
    );
    businessId = String(business._id);
    token = signToken({ userId: 'owner-analytics', role: 'owner', businessIds: [businessId] });

    const other = await Business.findOneAndUpdate(
      { slug: 'analytics-other' },
      {
        slug: 'analytics-other',
        name: 'Someone Else',
        category: 'salon',
        timezone: TZ,
        slotIncrementMinutes: 15,
        minNoticeMinutes: 60,
        bookingHorizonDays: 30,
      },
      { upsert: true, new: true, setDefaultsOnInsert: true },
    );
    otherBusinessId = String(other._id);

    await Promise.all([
      Booking.deleteMany({ businessId }),
      Booking.deleteMany({ businessId: otherBusinessId }),
      Service.deleteMany({ businessId }),
      ClientProfile.deleteMany({ businessId }),
      Client.deleteMany({ displayName: { $in: ['Hina Raza', 'Sana Khan'] } }),
    ]);

    const [a, b] = await Service.insertMany([
      { businessId, name: 'Hydrafacial', durationMinutes: 45, priceMinor: 100_000, displayOrder: 1 },
      { businessId, name: 'Laser', durationMinutes: 20, priceMinor: 50_000, displayOrder: 2 },
    ]);
    hydrafacial = String(a!._id);
    laser = String(b!._id);
  });

  describe('revenue', () => {
    it('counts completed appointments and nothing else', async () => {
      await booking({ date: '2026-03-10', time: '11:00', status: BOOKING_STATUS.COMPLETED });
      await booking({ date: '2026-03-10', time: '12:00', status: BOOKING_STATUS.COMPLETED });
      // All of these have a price on them, and none of them is money.
      await booking({ date: '2026-03-10', time: '13:00', status: BOOKING_STATUS.CANCELLED });
      await booking({ date: '2026-03-10', time: '14:00', status: BOOKING_STATUS.NO_SHOW });
      await booking({ date: '2026-03-10', time: '15:00', status: BOOKING_STATUS.CONFIRMED });

      const result = await report('2026-03-10', '2026-03-10');

      expect(result.revenueMinor).toBe(200_000);
      expect(result.volume).toEqual({
        total: 5,
        completed: 2,
        noShow: 1,
        cancelled: 1,
        upcoming: 1,
      });
    });

    it('leaves another business out of it entirely', async () => {
      await booking({ date: '2026-03-10', time: '11:00', status: BOOKING_STATUS.COMPLETED });
      await Booking.create({
        businessId: otherBusinessId,
        staffId: 'x',
        clientId: 'y',
        serviceId: 'z',
        startsAt: wallClockToUtc('2026-03-10T11:00', TZ),
        durationMinutes: 45,
        status: BOOKING_STATUS.COMPLETED,
        priceMinor: 999_000,
        source: 'whatsapp',
      });

      expect((await report('2026-03-10', '2026-03-10')).revenueMinor).toBe(100_000);
    });
  });

  describe('business-local day boundaries', () => {
    /**
     * The test the whole timezone rule exists for.
     *
     * 01:00 in Karachi is 20:00 UTC the day before. Bucketed on the stored
     * instant, this appointment lands on the 9th and the 10th looks quiet.
     */
    it('puts a small-hours appointment in its local day, not the UTC one', async () => {
      const early = await booking({
        date: '2026-03-10',
        time: '01:00',
        status: BOOKING_STATUS.COMPLETED,
      });
      expect(early.startsAt.toISOString().slice(0, 10)).toBe('2026-03-09'); // UTC disagrees

      const result = await report('2026-03-10', '2026-03-10');
      expect(result.revenueMinor).toBe(100_000);
      expect(result.series).toEqual([{ period: '2026-03-10', revenueMinor: 100_000, completed: 1 }]);
    });

    it('keeps a late-evening appointment out of tomorrow', async () => {
      await booking({ date: '2026-03-10', time: '23:30', status: BOOKING_STATUS.COMPLETED });

      expect((await report('2026-03-11', '2026-03-11')).revenueMinor).toBe(0);
      expect((await report('2026-03-10', '2026-03-10')).revenueMinor).toBe(100_000);
    });
  });

  describe('the series', () => {
    it('fills the quiet days with zeros rather than skipping them', async () => {
      await booking({ date: '2026-03-10', time: '11:00', status: BOOKING_STATUS.COMPLETED });
      await booking({ date: '2026-03-12', time: '11:00', status: BOOKING_STATUS.COMPLETED });

      const result = await report('2026-03-10', '2026-03-12');

      // Without the gap, a chart draws the 10th and the 12th adjacent and says
      // the opposite of what happened on the 11th.
      expect(result.series).toEqual([
        { period: '2026-03-10', revenueMinor: 100_000, completed: 1 },
        { period: '2026-03-11', revenueMinor: 0, completed: 0 },
        { period: '2026-03-12', revenueMinor: 100_000, completed: 1 },
      ]);
    });

    it('buckets by ISO week when asked', async () => {
      await booking({ date: '2026-03-10', time: '11:00', status: BOOKING_STATUS.COMPLETED });
      await booking({ date: '2026-03-12', time: '11:00', status: BOOKING_STATUS.COMPLETED });
      await booking({ date: '2026-03-17', time: '11:00', status: BOOKING_STATUS.COMPLETED });

      // Mon 9 Mar to Sun 22 Mar: two ISO weeks exactly.
      const result = await report('2026-03-09', '2026-03-22', 'week');

      expect(result.series).toEqual([
        { period: '2026-W11', revenueMinor: 200_000, completed: 2 },
        { period: '2026-W12', revenueMinor: 100_000, completed: 1 },
      ]);
    });

    it('buckets by month when asked', async () => {
      await booking({ date: '2026-03-31', time: '11:00', status: BOOKING_STATUS.COMPLETED });
      await booking({ date: '2026-04-01', time: '11:00', status: BOOKING_STATUS.COMPLETED });

      const result = await report('2026-03-01', '2026-04-30', 'month');

      expect(result.series).toEqual([
        { period: '2026-03', revenueMinor: 100_000, completed: 1 },
        { period: '2026-04', revenueMinor: 100_000, completed: 1 },
      ]);
    });
  });

  describe('no-show rate', () => {
    it('is measured over the appointments that reached their hour', async () => {
      await booking({ date: '2026-03-10', time: '11:00', status: BOOKING_STATUS.COMPLETED });
      await booking({ date: '2026-03-10', time: '12:00', status: BOOKING_STATUS.COMPLETED });
      await booking({ date: '2026-03-10', time: '13:00', status: BOOKING_STATUS.COMPLETED });
      await booking({ date: '2026-03-10', time: '14:00', status: BOOKING_STATUS.NO_SHOW });
      // Cancelled in advance: the slot was freed and could be resold, so it was
      // never a chance to not turn up.
      await booking({ date: '2026-03-10', time: '15:00', status: BOOKING_STATUS.CANCELLED });

      expect((await report('2026-03-10', '2026-03-10')).noShowRate).toBeCloseTo(0.25);
    });

    it('is unknown rather than zero before anything has happened', async () => {
      await booking({ date: '2026-03-10', time: '11:00', status: BOOKING_STATUS.CONFIRMED });

      // 0% would read as a record worth keeping. There is no record yet.
      expect((await report('2026-03-10', '2026-03-10')).noShowRate).toBeNull();
    });
  });

  describe('top lists', () => {
    it('ranks services by revenue and names them', async () => {
      await booking({ date: '2026-03-10', time: '11:00', status: BOOKING_STATUS.COMPLETED });
      await booking({
        date: '2026-03-10',
        time: '12:00',
        status: BOOKING_STATUS.COMPLETED,
        serviceId: laser,
        priceMinor: 50_000,
      });
      await booking({
        date: '2026-03-10',
        time: '13:00',
        status: BOOKING_STATUS.COMPLETED,
        serviceId: laser,
        priceMinor: 50_000,
      });
      await booking({
        date: '2026-03-10',
        time: '14:00',
        status: BOOKING_STATUS.COMPLETED,
        serviceId: laser,
        priceMinor: 50_000,
      });

      const result = await report('2026-03-10', '2026-03-10');

      expect(result.topServices).toEqual([
        { serviceId: laser, name: 'Laser', revenueMinor: 150_000, completed: 3 },
        { serviceId: hydrafacial, name: 'Hydrafacial', revenueMinor: 100_000, completed: 1 },
      ]);
    });

    it('still shows the revenue of a service that has since been deleted', async () => {
      await booking({
        date: '2026-03-10',
        time: '11:00',
        status: BOOKING_STATUS.COMPLETED,
        serviceId: new mongoose.Types.ObjectId().toString(),
      });

      const result = await report('2026-03-10', '2026-03-10');

      // Dropping the row would make the top list disagree with the total above it.
      expect(result.topServices).toHaveLength(1);
      expect(result.topServices[0]?.name).toBe('Removed service');
      expect(result.topServices[0]?.revenueMinor).toBe(result.revenueMinor);
    });

    it('ranks clients by what they have spent here, ever', async () => {
      const [big, small] = await Client.insertMany([
        { phone: '923009990001', displayName: 'Hina Raza' },
        { phone: '923009990002', displayName: 'Sana Khan' },
      ]);

      await ClientProfile.insertMany([
        {
          businessId,
          clientId: String(small!._id),
          totalVisits: 2,
          lifetimeSpendMinor: 200_000,
        },
        {
          businessId,
          clientId: String(big!._id),
          totalVisits: 9,
          lifetimeSpendMinor: 900_000,
        },
        // Nothing spent, so not a "top" client at all.
        { businessId, clientId: 'nobody', totalVisits: 0, lifetimeSpendMinor: 0 },
      ]);

      // Lifetime, so a range with no bookings in it still answers the question.
      const result = await report('2026-03-10', '2026-03-10');

      expect(result.topClients).toEqual([
        { clientId: String(big!._id), name: 'Hina Raza', lifetimeSpendMinor: 900_000, totalVisits: 9 },
        { clientId: String(small!._id), name: 'Sana Khan', lifetimeSpendMinor: 200_000, totalVisits: 2 },
      ]);
    });
  });

  describe('what is on the books', () => {
    it('counts appointments still to come, and only those', async () => {
      const now = wallClockToUtc('2026-03-10T12:00', TZ);

      await booking({ date: '2026-03-10', time: '09:00', status: BOOKING_STATUS.CONFIRMED }); // past
      await booking({ date: '2026-03-10', time: '15:00', status: BOOKING_STATUS.CONFIRMED });
      await booking({ date: '2026-03-14', time: '11:00', status: BOOKING_STATUS.PENDING });
      await booking({ date: '2026-03-14', time: '12:00', status: BOOKING_STATUS.CANCELLED });

      const result = await report('2026-03-10', '2026-03-10', 'day', now);

      expect(result.forecast).toEqual({ revenueMinor: 200_000, bookings: 2 });
    });

    it('is an honest zero for a business with nothing booked', async () => {
      expect((await report('2026-03-10', '2026-03-10')).forecast).toEqual({
        revenueMinor: 0,
        bookings: 0,
      });
    });
  });

  describe('the endpoint', () => {
    const get = (query: string, as = token) =>
      fetch(`${serverUrl}/businesses/${businessId}/analytics?${query}`, {
        headers: { Authorization: `Bearer ${as}` },
      });

    it('serves the report to its own owner', async () => {
      await booking({ date: '2026-03-10', time: '11:00', status: BOOKING_STATUS.COMPLETED });

      const res = await get('from=2026-03-10&to=2026-03-10');
      expect(res.status).toBe(200);

      const body = await json(res);
      expect(body.revenueMinor).toBe(100_000);
      expect(body.range).toEqual({ from: '2026-03-10', to: '2026-03-10', granularity: 'day' });
    });

    it('refuses another business\'s owner', async () => {
      const intruder = signToken({
        userId: 'owner-other',
        role: 'owner',
        businessIds: [otherBusinessId],
      });

      // 404, not 403: a business someone cannot read should not be confirmable
      // by the shape of the refusal. See auth/middleware.ts.
      expect((await get('from=2026-03-10&to=2026-03-10', intruder)).status).toBe(404);
    });

    it('refuses a range that ends before it starts', async () => {
      expect((await get('from=2026-03-20&to=2026-03-10')).status).toBe(400);
    });

    it('refuses a mistyped year rather than scanning the collection', async () => {
      // The failure this prevents is a slow dashboard, which nobody reports.
      expect((await get('from=2020-01-01&to=2026-03-10')).status).toBe(400);
    });

    it('refuses a date that is not a date', async () => {
      expect((await get('from=march&to=2026-03-10')).status).toBe(400);
      expect((await get('from=2026-02-30&to=2026-03-10')).status).toBe(400);
      expect((await get('from=2026-03-10&to=2026-13-01')).status).toBe(400);
    });
  });
});
