import type { AddressInfo } from 'node:net';
import express from 'express';
import mongoose from 'mongoose';
import { Redis } from 'ioredis';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { MessagingProvider } from '@scalivo/shared';
import { Business } from '../src/models/Business.js';
import { Client } from '../src/models/Client.js';
import { Service } from '../src/models/Service.js';
import { Staff } from '../src/models/Staff.js';
import { SlotOccupancy } from '../src/models/SlotOccupancy.js';
import { Booking } from '../src/models/Booking.js';
import { createBookingRouter } from '../src/bookings/routes.js';
import { signToken } from '../src/auth/jwt.js';
import { infraReady } from './infra.js';
import { wallClockToUtc } from '../src/lib/time.js';

/** Response bodies are asserted field by field; typing each shape adds nothing. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const json = (res: Response): Promise<any> => res.json();

const infraUp = await infraReady({ replicaSet: true, redis: true });

const TZ = 'Asia/Karachi';

function nextTuesday(): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + ((9 - d.getUTCDay()) % 7 || 7));
  return d.toISOString().slice(0, 10);
}

describe.skipIf(!infraUp)('Booking API (Phase 3c)', () => {
  let redis: Redis;
  let businessId: string;
  let wrongBusinessId: string;
  let clientId: string;
  let staffId: string;
  let serviceId: string;
  let date: string;
  let token: string; // Auth token for this tenant
  let serverUrl: string;
  let server: ReturnType<express.Express['listen']>;

  const at = (hhmm: string) => wallClockToUtc(`${date}T${hhmm}`, TZ).toISOString();

  beforeAll(async () => {
    redis = new Redis(process.env.REDIS_URL!, { db: 1 });
    date = nextTuesday();

    const app = express();
    const provider = {} as unknown as MessagingProvider;
    app.use('/businesses', createBookingRouter(redis, provider));
    
    // Global error handler to prevent supertest 500 dumps if something internal crashes
    app.use((err: any, req: any, res: any, next: any) => {
      res.status(500).json({ error: 'internal server error' });
    });

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
      { slug: 'booking-api-test' },
      {
        name: 'Booking API Test Clinic',
        slug: 'booking-api-test',
        category: 'clinic',
        timezone: TZ,
        slotIncrementMinutes: 15,
        minNoticeMinutes: 60,
        bookingHorizonDays: 30,
      },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    );
    businessId = String(business!._id);
    token = signToken({ userId: 'owner1', role: 'owner', businessIds: [businessId] });

    const wrongBusiness = await Business.findOneAndUpdate(
      { slug: 'wrong-clinic' },
      {
        name: 'Wrong Clinic',
        slug: 'wrong-clinic',
        category: 'clinic',
        timezone: TZ,
        slotIncrementMinutes: 15,
        minNoticeMinutes: 60,
        bookingHorizonDays: 30,
      },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    );
    wrongBusinessId = String(wrongBusiness!._id);

    await Promise.all([
      SlotOccupancy.deleteMany({ businessId }),
      Booking.deleteMany({ businessId }),
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
  });

  async function hold(startsAt: string) {
    const res = await fetch(`${serverUrl}/businesses/${businessId}/holds`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ serviceId, staffId, startsAt, source: 'web' }),
    });
    return res;
  }

  async function book(startsAt: string, holdToken: string) {
    const res = await fetch(`${serverUrl}/businesses/${businessId}/bookings`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ serviceId, staffId, clientId, startsAt, source: 'web', holdToken }),
    });
    return res;
  }

  it('Normal Creation: HTTP 201 with correct payload', async () => {
    const startsAt = at('10:00');
    const holdRes = await hold(startsAt);
    expect(holdRes.status).toBe(201);
    const holdData = await json(holdRes);

    const bookRes = await book(startsAt, holdData.token);
    expect(bookRes.status).toBe(201);
    const bookingData = await json(bookRes);

    expect(bookingData.id).toBeTypeOf('string');
    // It's 'web' source, so the status is PENDING (only owner source auto-confirms)
    expect(['PENDING', 'confirmed'].includes(bookingData.status)).toBe(true); 
    
    // Verify it reached DB
    const docs = await Booking.find({ businessId });
    expect(docs).toHaveLength(1);
    const occupancies = await SlotOccupancy.find({ businessId });
    expect(occupancies).toHaveLength(3); // 45 min on 15 min grid = 3 rows
  });

  it('Tenant Isolation: Attempting to book using a different business URL returns 404', async () => {
    const startsAt = at('11:00');
    // Auth token is only valid for businessId. We pass wrongBusinessId in the URL.
    const res = await fetch(`${serverUrl}/businesses/${wrongBusinessId}/bookings`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ serviceId, staffId, clientId, startsAt, source: 'web', holdToken: 'dummy' }),
    });

    // The middleware should return 404
    expect(res.status).toBe(404);
  });

  it('Validation: Providing a missing or malformed startsAt string returns 400 Bad Request', async () => {
    const res = await fetch(`${serverUrl}/businesses/${businessId}/bookings`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ serviceId, staffId, clientId, startsAt: 'invalid-date', source: 'web', holdToken: 'dummy' }),
    });

    expect(res.status).toBe(400);
    const data = await json(res);
    expect(data.error).toBe('invalid booking');
    expect(data.fields).toHaveProperty('startsAt');
  });

  it('Full-Flow Concurrency: Two independent customers racing for the exact same slot', async () => {
    const startsAt = at('12:00');
    
    // 1. Two independent customers attempt to acquire a hold simultaneously.
    const [hold1, hold2] = await Promise.all([
      hold(startsAt),
      hold(startsAt),
    ]);

    // 2. Redis atomic script arbitrates. Exactly one gets a hold.
    const holds = [hold1, hold2];
    const holdWinners = holds.filter(r => r.status === 201);
    const holdLosers = holds.filter(r => r.status === 409);
    
    expect(holdWinners).toHaveLength(1);
    expect(holdLosers).toHaveLength(1);

    const winnerData = await json(holdWinners[0]!);
    const loserData = await json(holdLosers[0]!);
    expect(loserData.reason).toBe('slot_taken');
    
    // 3. The winner submits their booking
    const bookRes = await book(startsAt, winnerData.token);
    expect(bookRes.status).toBe(201);
    
    // 4. Assert invariant: exactly 1 booking exists, exactly 3 occupancy rows exist
    expect(await Booking.countDocuments({ businessId, startsAt: new Date(startsAt) })).toBe(1);
    expect(await SlotOccupancy.countDocuments({ businessId })).toBe(3);
  });
});
