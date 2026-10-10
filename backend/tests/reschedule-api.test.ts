import { CapacityOccupancy } from '../src/models/CapacityOccupancy.js';
import type { AddressInfo } from 'node:net';
import express from 'express';
import mongoose from 'mongoose';
import { Redis } from 'ioredis';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { BOOKING_STATUS, type MessagingProvider } from '@scalivo/shared';
import { Business } from '../src/models/Business.js';
import { ClientProfile } from '../src/models/ClientProfile.js';
import { Client } from '../src/models/Client.js';
import { Service } from '../src/models/Service.js';
import { Staff } from '../src/models/Staff.js';
import { SlotOccupancy } from '../src/models/SlotOccupancy.js';
import { Booking } from '../src/models/Booking.js';
import { createBookingRouter } from '../src/bookings/routes.js';
import { createCalendarRouter } from '../src/calendar/routes.js';
import { signToken } from '../src/auth/jwt.js';
import { infraReady } from './infra.js';
import { wallClockToUtc } from '../src/lib/time.js';

const infraUp = await infraReady({ replicaSet: true, redis: true });

const TZ = 'Asia/Karachi';

/** Response bodies are asserted field by field; typing each shape adds nothing. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const json = (res: Response): Promise<any> => res.json();

function nextTuesday(): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + ((9 - d.getUTCDay()) % 7 || 7));
  return d.toISOString().slice(0, 10);
}

describe.skipIf(!infraUp)('Booking Reschedule & Cancel API (Phase 3e)', () => {
  let redis: Redis;
  let businessId: string;
  let wrongBusinessId: string;
  let clientId: string;
  let staffId: string;
  let serviceId: string;
  let date: string;
  let token: string;
  let serverUrl: string;
  let server: ReturnType<express.Express['listen']>;

  const at = (hhmm: string) => wallClockToUtc(`${date}T${hhmm}`, TZ).toISOString();

  beforeAll(async () => {
    redis = new Redis(process.env.REDIS_URL!, { db: 1 });
    date = nextTuesday();

    const app = express();
    const provider = {} as unknown as MessagingProvider;
    app.use('/businesses', createBookingRouter(redis, provider));
    // Rescheduling lives on the calendar router, the one path that also tells the customer.
    app.use('/businesses', createCalendarRouter(redis, provider));

    app.use(
      (
        _err: unknown,
        _req: express.Request,
        res: express.Response,
        _next: express.NextFunction,
      ) => {
        res.status(500).json({ error: 'internal server error' });
      },
    );

    server = app.listen(0);
    const { port } = server.address() as AddressInfo;
    serverUrl = `http://127.0.0.1:${port}`;
  });

  afterAll(async () => {
    if (server) server.close();
    await Promise.all([mongoose.disconnect(), redis.quit()]);
  });

  beforeEach(async () => {
    const business = await Business.findOneAndUpdate(
      { slug: 'reschedule-api-test' },
      {
        name: 'Reschedule API Test Clinic',
        slug: 'reschedule-api-test',
        category: 'clinic',
        timezone: TZ,
        slotIncrementMinutes: 15,
        minNoticeMinutes: 60,
        bookingHorizonDays: 30,
      },
      { upsert: true, new: true, setDefaultsOnInsert: true },
    );
    businessId = String(business!._id);
    token = signToken({ userId: 'owner1', role: 'owner', businessIds: [businessId] });

    const wrongBusiness = await Business.findOneAndUpdate(
      { slug: 'reschedule-wrong' },
      {
        name: 'Wrong Clinic',
        slug: 'reschedule-wrong',
        category: 'clinic',
        timezone: TZ,
        slotIncrementMinutes: 15,
        minNoticeMinutes: 60,
        bookingHorizonDays: 30,
      },
      { upsert: true, new: true, setDefaultsOnInsert: true },
    );
    wrongBusinessId = String(wrongBusiness!._id);

    await Promise.all([
      SlotOccupancy.deleteMany({ businessId }),
      CapacityOccupancy.deleteMany({ businessId }),
      Booking.deleteMany({ businessId }),
      ClientProfile.deleteMany({ businessId }),
      Service.deleteMany({ businessId }),
      Staff.deleteMany({ businessId }),
      redis.flushdb(),
    ]);

    const service = await Service.create({
      businessId,
      name: 'Test Service',
      durationMinutes: 45,
      priceMinor: 500_000,
      active: true,
    });
    serviceId = String(service._id);

    const hours = [0, 1, 2, 3, 4, 5, 6].map((dayOfWeek) => ({
      dayOfWeek,
      opensAt: '09:00',
      closesAt: '18:00',
      breaks: [],
    }));

    const staff = await Staff.create({
      businessId,
      name: 'Dr. Test',
      serviceIds: [serviceId],
      workingHours: hours,
      active: true,
    });
    staffId = String(staff._id);

    const unique = `${Date.now() % 100_000}${Math.floor(Math.random() * 1_000_000)}`;
    const client = await Client.create({ phone: `92300${unique}`, displayName: 'Test Client' });
    clientId = String(client._id);
    await ClientProfile.create({ businessId, clientId });
  });

  async function hold(startsAt: string) {
    const res = await fetch(`${serverUrl}/businesses/${businessId}/holds`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ serviceId, staffId, startsAt, source: 'owner' }),
    });
    return res;
  }

  async function createTestBooking(startsAt: string) {
    const holdRes = await hold(startsAt);
    const holdData = await json(holdRes);
    const bookRes = await fetch(`${serverUrl}/businesses/${businessId}/bookings`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({
        serviceId,
        staffId,
        clientId,
        startsAt,
        source: 'owner',
        holdToken: holdData.token,
      }),
    });
    expect(bookRes.status).toBe(201);
    return json(bookRes);
  }

  describe('Cancel', () => {
    it('A valid cancel succeeds and frees slots', async () => {
      const startsAt = at('10:00');
      const booking = await createTestBooking(startsAt);

      expect(await SlotOccupancy.countDocuments({ bookingId: booking.id })).toBe(3);

      const res = await fetch(
        `${serverUrl}/businesses/${businessId}/bookings/${booking.id}/cancel`,
        {
          method: 'POST',
          headers: { Authorization: `Bearer ${token}` },
        },
      );
      expect(res.status).toBe(204);

      const dbBooking = await Booking.findById(booking.id);
      expect(dbBooking!.status).toBe(BOOKING_STATUS.CANCELLED);
      expect(await SlotOccupancy.countDocuments({ bookingId: booking.id })).toBe(0);

      // Verify slot is bookable again
      const holdRes = await hold(startsAt);
      expect(holdRes.status).toBe(201);
    });

    it('Cancelling an already-CANCELLED booking is rejected', async () => {
      const startsAt = at('11:00');
      const booking = await createTestBooking(startsAt);

      await fetch(`${serverUrl}/businesses/${businessId}/bookings/${booking.id}/cancel`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
      });

      const res2 = await fetch(
        `${serverUrl}/businesses/${businessId}/bookings/${booking.id}/cancel`,
        {
          method: 'POST',
          headers: { Authorization: `Bearer ${token}` },
        },
      );
      expect(res2.status).toBe(409);
      const data = await json(res2);
      expect(data.reason).toBe('already_terminal');
    });

    it('Tenant isolation: cannot cancel another business booking', async () => {
      const startsAt = at('12:00');
      const booking = await createTestBooking(startsAt);

      const res = await fetch(
        `${serverUrl}/businesses/${wrongBusinessId}/bookings/${booking.id}/cancel`,
        {
          method: 'POST',
          headers: { Authorization: `Bearer ${token}` },
        },
      );
      // wrongBusinessId should trigger 404 because token only works for businessId
      expect(res.status).toBe(404);
    });
  });

  describe('Reschedule', () => {
    it('A valid reschedule succeeds, swapping old slots for new slots', async () => {
      const oldStartsAt = at('13:00');
      const newStartsAt = at('14:00');
      const booking = await createTestBooking(oldStartsAt);

      const res = await fetch(
        `${serverUrl}/businesses/${businessId}/bookings/${booking.id}/reschedule`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
          body: JSON.stringify({ startsAt: newStartsAt, staffId }),
        },
      );

      expect(res.status).toBe(200);
      const { booking: updatedBooking } = await json(res);
      expect(updatedBooking.startsAt).toBe(newStartsAt);

      // Check occupancies
      const occupancies = await SlotOccupancy.find({ bookingId: booking.id });
      expect(occupancies).toHaveLength(3);
      expect(occupancies[0]!.slotStart.toISOString()).toBe(newStartsAt);

      // Check old slot is free
      const oldHoldRes = await hold(oldStartsAt);
      expect(oldHoldRes.status).toBe(201);
    });

    it('Rescheduling an already-terminal booking is rejected', async () => {
      const oldStartsAt = at('14:30');
      const newStartsAt = at('15:30');
      const booking = await createTestBooking(oldStartsAt);

      // Cancel it first
      await fetch(`${serverUrl}/businesses/${businessId}/bookings/${booking.id}/cancel`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
      });

      const res = await fetch(
        `${serverUrl}/businesses/${businessId}/bookings/${booking.id}/reschedule`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
          body: JSON.stringify({ startsAt: newStartsAt, staffId }),
        },
      );
      expect(res.status).toBe(409);
      const data = await json(res);
      expect(data.reason).toBe('already_terminal');
    });

    it('Rescheduling into an occupied slot fails cleanly, leaving old booking intact', async () => {
      const oldStartsAt = at('16:00');
      const conflictStartsAt = at('17:00');

      const booking1 = await createTestBooking(oldStartsAt);
      const booking2 = await createTestBooking(conflictStartsAt);
      expect(booking2.startsAt).toBe(conflictStartsAt);

      // booking2 already sits on 17:00, so the occupancy index must refuse the move.
      const res = await fetch(
        `${serverUrl}/businesses/${businessId}/bookings/${booking1.id}/reschedule`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
          body: JSON.stringify({ startsAt: conflictStartsAt, staffId }),
        },
      );

      expect(res.status).toBe(409);
      const data = await json(res);
      expect(data.reason).toBe('slot_taken');

      // 4. Assert old booking is exactly as it was
      const dbBooking1 = await Booking.findById(booking1.id);
      expect(dbBooking1!.startsAt.toISOString()).toBe(oldStartsAt);

      const occupancies = await SlotOccupancy.find({ bookingId: booking1.id });
      expect(occupancies).toHaveLength(3); // The original slots are intact
      expect(occupancies[0]!.slotStart.toISOString()).toBe(oldStartsAt);
    });

    it('Concurrency: two simultaneous reschedule attempts for the exact same destination slot', async () => {
      const booking1 = await createTestBooking(at('09:00'));
      const booking2 = await createTestBooking(at('10:00'));
      const destination = at('11:00');

      const [res1, res2] = await Promise.all([
        fetch(`${serverUrl}/businesses/${businessId}/bookings/${booking1.id}/reschedule`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
          body: JSON.stringify({ startsAt: destination, staffId }),
        }),
        fetch(`${serverUrl}/businesses/${businessId}/bookings/${booking2.id}/reschedule`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
          body: JSON.stringify({ startsAt: destination, staffId }),
        }),
      ]);

      const statuses = [res1.status, res2.status];
      expect(statuses).toContain(200);
      expect(statuses).toContain(409);

      const winnerId = res1.status === 200 ? booking1.id : booking2.id;
      const loserId = res1.status === 200 ? booking2.id : booking1.id;

      const dbWinner = await Booking.findById(winnerId);
      expect(dbWinner!.startsAt.toISOString()).toBe(destination);

      const dbLoser = await Booking.findById(loserId);
      expect(dbLoser!.startsAt.toISOString()).not.toBe(destination);

      expect(
        await SlotOccupancy.countDocuments({ businessId, slotStart: new Date(destination) }),
      ).toBe(1);
    });
  });

  describe('Outcome (Complete / No-Show)', () => {
    it('successfully marks a past booking as COMPLETED and NO_SHOW', async () => {
      // Create past booking by manually inserting into DB
      const startsAt = new Date(Date.now() - 3600000); // 1 hour ago
      const b1 = await Booking.create({
        businessId,
        serviceId,
        staffId,
        clientId,
        startsAt,
        durationMinutes: 45,
        status: BOOKING_STATUS.CONFIRMED,
        source: 'owner',
        priceMinor: 5000,
      });
      const b2 = await Booking.create({
        businessId,
        serviceId,
        staffId,
        clientId,
        startsAt,
        durationMinutes: 45,
        status: BOOKING_STATUS.CONFIRMED,
        source: 'owner',
        priceMinor: 5000,
      });

      const res1 = await fetch(`${serverUrl}/businesses/${businessId}/bookings/${b1.id}/outcome`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ outcome: 'completed' }),
      });
      expect(res1.status).toBe(204);

      const res2 = await fetch(`${serverUrl}/businesses/${businessId}/bookings/${b2.id}/outcome`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ outcome: 'no_show' }),
      });
      expect(res2.status).toBe(204);

      const updated1 = await Booking.findById(b1.id);
      expect(updated1!.status).toBe(BOOKING_STATUS.COMPLETED);

      const updated2 = await Booking.findById(b2.id);
      expect(updated2!.status).toBe(BOOKING_STATUS.NO_SHOW);
    });

    it('rejects a booking that is not CONFIRMED', async () => {
      const startsAt = new Date(Date.now() - 3600000);
      const b = await Booking.create({
        businessId,
        serviceId,
        staffId,
        clientId,
        startsAt,
        durationMinutes: 45,
        status: BOOKING_STATUS.PENDING,
        source: 'web',
        priceMinor: 5000,
      });

      const res = await fetch(`${serverUrl}/businesses/${businessId}/bookings/${b.id}/outcome`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ outcome: 'completed' }),
      });
      expect(res.status).toBe(400);
      const data = await json(res);
      expect(data.reason).toBe('invalid_status');
    });

    it('rejects an already-terminal booking', async () => {
      const startsAt = new Date(Date.now() - 3600000);
      const b = await Booking.create({
        businessId,
        serviceId,
        staffId,
        clientId,
        startsAt,
        durationMinutes: 45,
        status: BOOKING_STATUS.CANCELLED,
        source: 'owner',
        priceMinor: 5000,
      });

      const res = await fetch(`${serverUrl}/businesses/${businessId}/bookings/${b.id}/outcome`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ outcome: 'completed' }),
      });
      // terminal is checked first
      expect(res.status).toBe(409);
      const data = await json(res);
      expect(data.reason).toBe('already_terminal');
    });

    it('rejects a booking that is in the future', async () => {
      const startsAt = new Date(Date.now() + 3600000); // 1 hour in future
      const b = await Booking.create({
        businessId,
        serviceId,
        staffId,
        clientId,
        startsAt,
        durationMinutes: 45,
        status: BOOKING_STATUS.CONFIRMED,
        source: 'owner',
        priceMinor: 5000,
      });

      const res = await fetch(`${serverUrl}/businesses/${businessId}/bookings/${b.id}/outcome`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ outcome: 'completed' }),
      });
      expect(res.status).toBe(400);
      const data = await json(res);
      expect(data.reason).toBe('not_yet_occurred');
    });
  });
});
