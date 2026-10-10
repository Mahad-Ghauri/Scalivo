import type { AddressInfo } from 'node:net';
import express from 'express';
import mongoose from 'mongoose';
import { Redis } from 'ioredis';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { MessagingProvider } from '@scalivo/shared';
import { createBookingRouter } from '../src/bookings/routes.js';
import { Business } from '../src/models/Business.js';
import { Booking } from '../src/models/Booking.js';
import { signToken } from '../src/auth/jwt.js';
import { infraReady } from './infra.js';
const ready = await infraReady({ redis: true, replicaSet: true });
describe.skipIf(!ready)('owner appointment parity boundaries', () => {
  let businessId: string, base: string, token: string;
  let redis: Redis;
  let server: ReturnType<express.Express['listen']>;
  const request = (path: string, bearer: string | null = token, body?: object) =>
    fetch(`${base}/businesses/${businessId}${path}`, {
      method: body ? 'POST' : 'GET',
      headers: {
        ...(bearer ? { Authorization: `Bearer ${bearer}` } : {}),
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(5000),
    });
  beforeAll(async () => {
    const business = await Business.create({
      name: 'Owner parity test',
      slug: `owner-parity-${Date.now()}`,
      category: 'salon',
      agent: { briefings: false },
    });
    businessId = String(business._id);
    token = signToken({ userId: 'owner', role: 'owner', businessIds: [businessId] });
    redis = new Redis(process.env.REDIS_URL!, { connectTimeout: 5000, commandTimeout: 5000 });
    const app = express();
    app.use('/businesses', createBookingRouter(redis, {} as MessagingProvider));
    server = app.listen(0);
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  beforeEach(async () => {
    await Booking.deleteMany({ businessId });
  });
  afterAll(async () => {
    await Booking.deleteMany({ businessId });
    await Business.deleteOne({ _id: businessId });
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await redis.quit();
    await mongoose.disconnect();
  });
  it('refuses oversized, unknown and invalid date filters before database work', async () => {
    for (const query of [
      'q=' + 'a'.repeat(121),
      'skip=100001',
      'status=unknown',
      'from=2026-02-30',
      'from=2026-10-20&to=2026-10-10',
      'limit=101',
      'staffId=' + 'a'.repeat(81),
    ]) {
      expect((await request('/bookings?' + query)).status).toBe(400);
    }
    expect((await request('/bookings?limit=20&status=confirmed')).status).toBe(200);
  });
  it('requires owner authentication and tenant membership for list and availability', async () => {
    for (const path of [
      '/bookings?limit=20',
      '/availability?serviceId=service&staffId=staff&date=2026-10-10',
    ]) {
      expect((await request(path, null)).status).toBe(401);
      expect(
        (await request(path, signToken({ userId: 'other', role: 'owner', businessIds: ['other'] })))
          .status,
      ).toBe(404);
      expect(
        (
          await request(
            path,
            signToken({ userId: 'staff', role: 'staff', businessIds: [businessId] }),
          )
        ).status,
      ).toBe(404);
    }
  });
  it('future, pending and settled bookings cannot be marked complete or no-show', async () => {
    for (const [status, startsAt, code] of [
      ['confirmed', new Date(Date.now() + 86400000), 400],
      ['pending', new Date(Date.now() - 86400000), 400],
      ['completed', new Date(Date.now() - 86400000), 409],
    ] as const) {
      const row = await Booking.create({
        businessId,
        clientId: 'client',
        serviceId: 'service',
        staffId: 'staff',
        startsAt,
        durationMinutes: 30,
        priceMinor: 10000,
        status,
        source: 'owner',
      });
      for (const outcome of ['completed', 'no_show']) {
        expect((await request(`/bookings/${row._id}/outcome`, token, { outcome })).status).toBe(
          code,
        );
      }
      expect((await Booking.findById(row._id))?.status).toBe(status);
    }
  });
});
