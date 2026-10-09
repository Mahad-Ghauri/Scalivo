import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import express from 'express';
import mongoose from 'mongoose';
import { Redis } from 'ioredis';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  BOOKING_STATUS,
  BOOST_DAYS,
  DEPOSIT_STATUS,
  SESSION_STATUS,
  type MessagingProvider,
  type SendResult,
} from '@scalivo/shared';
import { Booking } from '../src/models/Booking.js';
import { Business } from '../src/models/Business.js';
import { Client } from '../src/models/Client.js';
import { FunnelDay } from '../src/models/FunnelDay.js';
import { Service } from '../src/models/Service.js';
import { SlotOccupancy } from '../src/models/SlotOccupancy.js';
import { Staff } from '../src/models/Staff.js';
import { wallClockToUtc } from '../src/lib/time.js';
import { createPublicRouter } from '../src/public/routes.js';
import { createGrowRouter } from '../src/grow/routes.js';
import { signToken } from '../src/auth/jwt.js';
import { infraReady } from './infra.js';

/**
 * Grow — SPEC §10. What these hold the system to:
 *
 *   - A reload is not a second visitor. The funnel's first two steps come from
 *     anonymous beacons, and a funnel that counts every refresh tells an owner
 *     their profile is ten times as popular as it is.
 *   - The last step comes from real bookings, by the channel they came in on,
 *     and a deposit hold that was never paid is not one.
 *   - Days are the business's days. An evening booking in Karachi is that day's,
 *     not the next UTC day's.
 *   - A boost buys position, never relevance, and never invisibility: it cannot
 *     be switched on for an unpublished business, and it always shows as
 *     "featured" to the customer.
 */

const TZ = 'Asia/Karachi';

const provider = {
  name: 'fake',
  sendText: async (): Promise<SendResult> => ({ providerMessageId: `grow-${Math.random()}`, acceptedAt: new Date() }),
  getSessionStatus: async () => SESSION_STATUS.READY,
} as unknown as MessagingProvider;

const infraUp = await infraReady({ replicaSet: true, redis: true });

describe.skipIf(!infraUp)('grow: funnel and boost', () => {
  let redis: Redis;
  let server: Server;
  let base: string;
  let businessId: string;
  let otherId: string;
  let token: string;
  const madePhones: string[] = [];

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  type Loose = Omit<Response, 'json'> & { json(): Promise<any> };

  const beacon = (body: unknown, slug = 'grow-test', headers: Record<string, string> = {}) =>
    fetch(`${base}/public/businesses/${slug}/events`, {
      method: 'POST',
      headers: { 'content-type': 'text/plain', ...headers },
      body: typeof body === 'string' ? body : JSON.stringify(body),
    }) as Promise<Loose>;

  const owner = (path: string, method = 'GET', as = token) =>
    fetch(`${base}/businesses/${businessId}${path}`, {
      method,
      headers: { Authorization: `Bearer ${as}` },
    }) as Promise<Loose>;

  const visitor = () => `v${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`;

  /** Today in Karachi, as the report's range expects it. */
  const today = () => new Intl.DateTimeFormat('en-CA', { timeZone: TZ }).format(new Date());

  /** A raw booking row, written with an exact createdAt — Mongoose timestamps would overwrite it. */
  async function booking(fields: Record<string, unknown>) {
    await Booking.collection.insertOne({
      businessId,
      staffId: 'staff',
      clientId: 'client',
      serviceId: 'service',
      startsAt: new Date(Date.now() + 86_400_000),
      durationMinutes: 30,
      status: BOOKING_STATUS.CONFIRMED,
      priceMinor: 100_000,
      source: 'web',
      channel: null,
      depositStatus: null,
      createdAt: new Date(),
      updatedAt: new Date(),
      ...fields,
    });
  }

  beforeAll(async () => {
    // db 7 — 1–6 belong to the other infrastructure suites.
    redis = new Redis(process.env.REDIS_URL!, { db: 7 });
    await Promise.all([FunnelDay.syncIndexes(), SlotOccupancy.syncIndexes(), Booking.syncIndexes()]);

    const app = express();
    app.use('/public', createPublicRouter(redis, provider));
    app.use('/businesses', createGrowRouter());
    server = app.listen(0);
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    server.close();
    await Client.deleteMany({ phone: { $in: madePhones } });
    await Promise.all([mongoose.disconnect(), redis.quit()]);
  });

  beforeEach(async () => {
    await redis.flushdb();

    const seed = (slug: string, name: string, extra: Record<string, unknown>) =>
      Business.findOneAndReplace(
        { slug },
        { slug, name, category: 'growcat', city: 'Growabad', timezone: TZ, published: true, ...extra },
        { upsert: true, new: true },
      );
    const business = await seed('grow-test', 'Grow Test Salon', {});
    const other = await seed('grow-other', 'Grow Other Salon', {});
    await seed('grow-hidden', 'Grow Hidden', { published: false });
    businessId = String(business!._id);
    otherId = String(other!._id);
    token = signToken({ userId: 'owner-grow', role: 'owner', businessIds: [businessId] });

    await Promise.all([
      FunnelDay.deleteMany({ businessId: { $in: [businessId, otherId] } }),
      Booking.deleteMany({ businessId: { $in: [businessId, otherId] } }),
      Service.deleteMany({ businessId: { $in: [businessId, otherId] } }),
      Staff.deleteMany({ businessId: { $in: [businessId, otherId] } }),
      SlotOccupancy.deleteMany({ businessId }),
    ]);
  });

  /* ------------------------------------------------------------ beacons */

  it('counts a visitor once per day however often they reload', async () => {
    const me = visitor();
    for (let i = 0; i < 3; i++) {
      expect((await beacon({ type: 'view', channel: 'qr', visitorId: me })).status).toBe(204);
    }
    await beacon({ type: 'view', channel: 'qr', visitorId: visitor() });
    await beacon({ type: 'start', channel: 'qr', visitorId: me });
    await beacon({ type: 'start', channel: 'qr', visitorId: me });

    const row = await FunnelDay.findOne({ businessId, channel: 'qr' });
    expect(row?.views).toBe(2);
    expect(row?.starts).toBe(1);
    expect(row?.day).toBe(today());
  });

  it('files an unknown channel under direct rather than inventing one', async () => {
    await beacon({ type: 'view', channel: 'tiktok-ad-7', visitorId: visitor() });
    const rows = await FunnelDay.find({ businessId });
    expect(rows.map((r) => r.channel)).toEqual(['direct']);
  });

  it('refuses a malformed beacon and never counts an unpublished business', async () => {
    expect((await beacon({ type: 'view', channel: 'qr', visitorId: 'x' })).status).toBe(400);
    expect((await beacon({ type: 'purchase', channel: 'qr', visitorId: visitor() })).status).toBe(400);
    expect((await beacon('not json')).status).toBe(400);
    expect((await beacon({ type: 'view', channel: 'qr', visitorId: visitor() }, 'grow-hidden')).status).toBe(404);
    expect(await FunnelDay.countDocuments({ businessId })).toBe(0);
  });

  it('ignores crawlers that run scripts', async () => {
    const res = await beacon({ type: 'view', channel: 'direct', visitorId: visitor() }, 'grow-test', {
      'user-agent': 'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)',
    });
    expect(res.status).toBe(204);
    expect(await FunnelDay.countDocuments({ businessId })).toBe(0);
  });

  /* ------------------------------------------------------------- report */

  it('reports views, starts and bookings by channel, busiest first', async () => {
    for (let i = 0; i < 4; i++) await beacon({ type: 'view', channel: 'instagram', visitorId: visitor() });
    const starter = visitor();
    await beacon({ type: 'view', channel: 'qr', visitorId: starter });
    await beacon({ type: 'start', channel: 'qr', visitorId: starter });

    await booking({ channel: 'qr' });
    await booking({ channel: 'instagram' });
    await booking({ channel: 'instagram' });
    await booking({ channel: null }); // made before channels were recorded
    await booking({ source: 'whatsapp' });
    await booking({ source: 'owner' }); // a walk-in is nobody's funnel

    const res = await owner(`/grow/funnel?from=${today()}&to=${today()}`);
    expect(res.status).toBe(200);
    const report = await res.json();

    expect(report.totals).toEqual({ views: 5, starts: 1, bookings: 4 });
    expect(report.whatsappBookings).toBe(1);
    expect(report.byChannel.map((r: { channel: string }) => r.channel)).toEqual(['instagram', 'qr', 'direct']);
    expect(report.byChannel[0]).toEqual({ channel: 'instagram', views: 4, starts: 0, bookings: 2 });
  });

  it('does not count a deposit hold as a booking until it is paid', async () => {
    await booking({ channel: 'qr', status: BOOKING_STATUS.AWAITING_DEPOSIT, depositStatus: DEPOSIT_STATUS.AWAITING });
    await booking({ channel: 'qr', status: BOOKING_STATUS.CANCELLED, depositStatus: DEPOSIT_STATUS.EXPIRED });
    await booking({ channel: 'qr', status: BOOKING_STATUS.CONFIRMED, depositStatus: DEPOSIT_STATUS.PAID });
    // Cancelled later, by the customer: the channel still brought them in.
    await booking({ channel: 'qr', status: BOOKING_STATUS.CANCELLED });

    const report = await (await owner(`/grow/funnel?from=${today()}&to=${today()}`)).json();
    expect(report.totals.bookings).toBe(2);
  });

  it('dates bookings by the business’s day, not the server’s', async () => {
    // 21:00 UTC on the 9th is 02:00 on the 10th in Karachi.
    await booking({ channel: 'link', createdAt: new Date('2026-03-09T21:00:00Z') });

    const ninth = await (await owner('/grow/funnel?from=2026-03-09&to=2026-03-09')).json();
    const tenth = await (await owner('/grow/funnel?from=2026-03-10&to=2026-03-10')).json();
    expect(ninth.totals.bookings).toBe(0);
    expect(tenth.totals.bookings).toBe(1);
  });

  it('keeps one business’s funnel away from another’s owner', async () => {
    const stranger = signToken({ userId: 'someone', role: 'owner', businessIds: [otherId] });
    expect((await owner(`/grow/funnel?from=${today()}&to=${today()}`, 'GET', stranger)).status).toBe(404);
    expect((await owner('/grow/boost', 'POST', stranger)).status).toBe(404);
  });

  it('refuses a range that ends before it starts or runs past a year', async () => {
    expect((await owner('/grow/funnel?from=2026-03-10&to=2026-03-09')).status).toBe(400);
    expect((await owner('/grow/funnel?from=2024-01-01&to=2026-03-09')).status).toBe(400);
    expect((await owner('/grow/funnel?from=2026-02-30&to=2026-03-09')).status).toBe(400);
    expect((await owner('/grow/funnel?from=2026-03-09&to=2026-13-01')).status).toBe(400);
  });

  /* -------------------------------------------------------- web booking */

  it('records the channel a web booking came in on', async () => {
    const service = await Service.create({ businessId, name: 'Cut', durationMinutes: 30, priceMinor: 150_000, displayOrder: 1 });
    const staff = await Staff.create({
      businessId,
      name: 'Hina',
      serviceIds: [String(service._id)],
      workingHours: [0, 1, 2, 3, 4, 5, 6].map((dayOfWeek) => ({ dayOfWeek, opensAt: '09:00', closesAt: '21:00', breaks: [] })),
    });

    // Two days out at 11:00 — clear of the notice period, inside the horizon.
    const day = new Intl.DateTimeFormat('en-CA', { timeZone: TZ }).format(new Date(Date.now() + 2 * 86_400_000));
    const startsAt = wallClockToUtc(`${day}T11:00`, TZ).toISOString();
    const post = (path: string, body: unknown) =>
      fetch(`${base}/public/businesses/grow-test${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      }) as Promise<Loose>;

    const hold = await post('/holds', { serviceId: String(service._id), staffId: String(staff._id), startsAt });
    expect(hold.status).toBe(201);
    const { token: holdToken } = await hold.json();

    const phone = `0301${String(Math.floor(Math.random() * 10_000_000)).padStart(7, '0')}`;
    madePhones.push(`92${phone.slice(1)}`);
    const made = await post('/bookings', {
      serviceId: String(service._id),
      staffId: String(staff._id),
      startsAt,
      holdToken,
      name: 'Grow Customer',
      phone,
      channel: 'qr',
    });
    expect(made.status).toBe(201);

    const saved = await Booking.findById((await made.json()).id);
    expect(saved?.channel).toBe('qr');
  });

  /* -------------------------------------------------------------- boost */

  it('boosts for a week, sorts the business first, and labels it', async () => {
    await Business.updateOne({ _id: otherId }, { $set: { 'boost.until': null } });

    const res = await owner('/grow/boost', 'POST');
    expect(res.status).toBe(200);
    const boost = await res.json();
    expect(boost.active).toBe(true);
    const days = (new Date(boost.until).getTime() - Date.now()) / 86_400_000;
    expect(days).toBeGreaterThan(BOOST_DAYS - 0.01);
    expect(days).toBeLessThanOrEqual(BOOST_DAYS);

    const cards = await (await fetch(`${base}/public/businesses?category=growcat`)).json();
    expect(cards.map((c: { slug: string }) => c.slug)).toEqual(['grow-test', 'grow-other']);
    expect(cards[0].featured).toBe(true);
    expect(cards[1].featured).toBe(false);
  });

  it('never lifts a business above one that matched and it did not', async () => {
    await owner('/grow/boost', 'POST');
    await Service.create({ businessId: otherId, name: 'Keratin', durationMinutes: 60, priceMinor: 500_000, displayOrder: 1 });

    const cards = await (await fetch(`${base}/public/businesses?q=keratin`)).json();
    expect(cards.map((c: { slug: string }) => c.slug)).toEqual(['grow-other']);
  });

  it('refuses to boost an unpublished listing', async () => {
    await Business.updateOne({ _id: businessId }, { $set: { published: false } });
    const res = await owner('/grow/boost', 'POST');
    expect(res.status).toBe(409);
    expect((await res.json()).reason).toBe('not_published');
    expect((await Business.findById(businessId))?.boost?.until).toBeNull();
  });

  it('ends on its own, and stops on request', async () => {
    await Business.updateOne({ _id: businessId }, { $set: { 'boost.until': new Date(Date.now() - 1000) } });
    let cards = await (await fetch(`${base}/public/businesses?category=growcat`)).json();
    expect(cards.every((c: { featured: boolean }) => !c.featured)).toBe(true);
    expect((await (await owner('/grow/boost')).json()).active).toBe(false);

    await owner('/grow/boost', 'POST');
    const stopped = await (await owner('/grow/boost', 'DELETE')).json();
    expect(stopped).toEqual({ active: false, until: null });
    cards = await (await fetch(`${base}/public/businesses?category=growcat`)).json();
    expect(cards.every((c: { featured: boolean }) => !c.featured)).toBe(true);
  });
});
