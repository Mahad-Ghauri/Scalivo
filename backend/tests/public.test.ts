import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import express from 'express';
import mongoose from 'mongoose';
import { Redis } from 'ioredis';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  BOOKING_STATUS,
  SESSION_STATUS,
  type MessagingProvider,
  type SendResult,
} from '@scalivo/shared';
import { Booking } from '../src/models/Booking.js';
import { Business } from '../src/models/Business.js';
import { Client } from '../src/models/Client.js';
import { ClientProfile } from '../src/models/ClientProfile.js';
import { Notification } from '../src/models/Notification.js';
import { Review } from '../src/models/Review.js';
import { Service } from '../src/models/Service.js';
import { SlotOccupancy } from '../src/models/SlotOccupancy.js';
import { Staff } from '../src/models/Staff.js';
import { holdSlot } from '../src/bookings/create.js';
import { wallClockToUtc } from '../src/lib/time.js';
import { createPublicRouter } from '../src/public/routes.js';
import { businessHours } from '../src/public/profiles.js';
import { infraReady } from './infra.js';

/**
 * The anonymous surface. Two claims matter more than the rest:
 *
 *   1. It never shows a stranger anything unpublished or internal — an
 *      unpublished business is a 404 everywhere, and the WhatsApp session never
 *      appears in a response.
 *   2. A web booking and a WhatsApp booking cannot take the same time. Not
 *      because the channels coordinate, but because the web goes through the
 *      same hold and the same occupancy transaction.
 */

const TZ = 'Asia/Karachi';

/** A weekday well inside the horizon, so notice and horizon never bite. */
function nextTuesday(): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + ((9 - d.getUTCDay()) % 7 || 7));
  return d.toISOString().slice(0, 10);
}

class FakeProvider implements MessagingProvider {
  readonly name = 'fake';
  sent: { to: string; text: string }[] = [];
  private readonly prefix = `pub-${Math.random().toString(36).slice(2, 10)}`;
  async sendText(_sessionId: string, to: string, text: string): Promise<SendResult> {
    this.sent.push({ to, text });
    return { providerMessageId: `${this.prefix}-${this.sent.length}`, acceptedAt: new Date() };
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
    return { sessionId: 'fake', status: SESSION_STATUS.READY };
  }
  async registerWebhook() {}
  async getSessionPhone() {
    return null;
  }
  async resolveContactPhone() {
    return null;
  }
  parseWebhook() {
    return [];
  }
}

describe('business hours envelope', () => {
  const shift = (opensAt: string, closesAt: string, breaks: { startsAt: string; endsAt: string }[] = []) => ({
    dayOfWeek: 1,
    opensAt,
    closesAt,
    breaks,
  });

  it('spans earliest opening to latest closing', () => {
    const hours = businessHours([
      { workingHours: [shift('10:00', '16:00')] },
      { workingHours: [shift('09:00', '14:00')] },
    ] as never);
    expect(hours).toEqual([{ dayOfWeek: 1, opensAt: '09:00', closesAt: '16:00', breaks: [] }]);
  });

  it('publishes a break only when everyone takes it', () => {
    const lunch = { startsAt: '13:00', endsAt: '14:00' };
    const both = businessHours([
      { workingHours: [shift('09:00', '18:00', [lunch])] },
      { workingHours: [shift('09:00', '18:00', [lunch])] },
    ] as never);
    expect(both[0]!.breaks).toEqual([lunch]);

    const one = businessHours([
      { workingHours: [shift('09:00', '18:00', [lunch])] },
      { workingHours: [shift('09:00', '18:00')] },
    ] as never);
    expect(one[0]!.breaks).toEqual([]);
  });

  it('omits days nobody works', () => {
    expect(businessHours([{ workingHours: [] }] as never)).toEqual([]);
  });
});

const infraUp = await infraReady({ replicaSet: true, redis: true });

describe.skipIf(!infraUp)('public marketplace and web booking', () => {
  let redis: Redis;
  let server: Server;
  let base: string;
  let provider: FakeProvider;
  let businessId: string;
  let hiddenId: string;
  let hydrafacial: string; // 45 min
  let staffA: string;
  let date: string;
  const madePhones: string[] = [];

  const at = (hhmm: string) => wallClockToUtc(`${date}T${hhmm}`, TZ);
  const phone = () => {
    const value = `0301${String(Math.floor(Math.random() * 10_000_000)).padStart(7, '0')}`;
    madePhones.push(`92${value.slice(1)}`);
    return value;
  };

  /** Responses read loosely — the shapes are what these tests assert, not what they assume. */
  type Loose = Omit<Response, 'json'> & { json(): Promise<any> };
  const get = (path: string) => fetch(`${base}${path}`) as Promise<Loose>;
  const post = (path: string, body: unknown) =>
    fetch(`${base}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }) as Promise<Loose>;

  beforeAll(async () => {
    // db 6 — 1–5 belong to the other infrastructure suites.
    redis = new Redis(process.env.REDIS_URL!, { db: 6 });
    date = nextTuesday();
    await Promise.all([SlotOccupancy.syncIndexes(), Review.syncIndexes()]);

    provider = new FakeProvider();
    const app = express();
    app.use('/public', createPublicRouter(redis, provider));
    server = app.listen(0);
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/public`;
  });

  afterAll(async () => {
    server.close();
    await Client.deleteMany({ phone: { $in: madePhones } });
    await Promise.all([mongoose.disconnect(), redis.quit()]);
  });

  beforeEach(async () => {
    provider.sent.length = 0;

    const business = await Business.findOneAndUpdate(
      { slug: 'public-test' },
      {
        slug: 'public-test',
        name: 'Public Test Clinic',
        category: 'clinic',
        city: 'Testabad',
        timezone: TZ,
        slotIncrementMinutes: 15,
        minNoticeMinutes: 60,
        bookingHorizonDays: 30,
        published: true,
        'whatsapp.sessionId': 'public-test-session',
        'whatsapp.apiKeyRef': 'secret-ref-must-not-leak',
        'profile.tagline': 'Skin, done properly.',
        'profile.coverUrl': 'https://example.com/cover.jpg',
      },
      { upsert: true, new: true, setDefaultsOnInsert: true },
    );
    businessId = String(business._id);

    const hidden = await Business.findOneAndUpdate(
      { slug: 'public-test-hidden' },
      { slug: 'public-test-hidden', name: 'Hidden Clinic', category: 'hiddencat', city: 'Hiddenville', published: false },
      { upsert: true, new: true, setDefaultsOnInsert: true },
    );
    hiddenId = String(hidden._id);

    const ids = [businessId, hiddenId];
    await Promise.all([
      SlotOccupancy.deleteMany({ businessId: { $in: ids } }),
      Booking.deleteMany({ businessId: { $in: ids } }),
      Notification.deleteMany({ businessId: { $in: ids } }),
      Service.deleteMany({ businessId: { $in: ids } }),
      Staff.deleteMany({ businessId: { $in: ids } }),
      Review.deleteMany({ businessId: { $in: ids } }),
      ClientProfile.deleteMany({ businessId: { $in: ids } }),
      redis.flushdb(),
    ]);

    const [hydra, retired] = await Service.insertMany([
      { businessId, name: 'Hydrafacial', durationMinutes: 45, priceMinor: 800_000, displayOrder: 1 },
      { businessId, name: 'Retired peel', durationMinutes: 30, priceMinor: 100_000, active: false },
      { businessId: hiddenId, name: 'Secret facial', durationMinutes: 30, priceMinor: 100_000 },
    ]);
    hydrafacial = String(hydra!._id);

    const hours = [0, 1, 2, 3, 4, 5, 6].map((dayOfWeek) => ({
      dayOfWeek,
      opensAt: '09:00',
      closesAt: '18:00',
      breaks: [{ startsAt: '13:00', endsAt: '14:00' }],
    }));
    const [a] = await Staff.insertMany([
      { businessId, name: 'Dr. Ayesha', role: 'Aesthetic physician', serviceIds: [hydrafacial, String(retired!._id)], workingHours: hours },
      { businessId: hiddenId, name: 'Hidden Staff', serviceIds: [], workingHours: hours },
    ]);
    staffA = String(a!._id);

    await Review.insertMany([
      { businessId, authorName: 'Sana', rating: 5, comment: 'Lovely', published: true },
      { businessId, authorName: 'Hina', rating: 4, comment: 'Good', published: true },
      // Neither of these may ever reach a stranger.
      { businessId, authorName: 'Angry', rating: 2, comment: 'PRIVATE-LOW', published: true },
      { businessId, authorName: 'Draft', rating: 5, comment: 'PRIVATE-UNPUBLISHED', published: false },
      { businessId: hiddenId, authorName: 'Ghost', rating: 5, comment: 'PRIVATE-HIDDEN-BIZ', published: true },
    ]);
  });

  describe('reads', () => {
    it('serves a published profile without any internal field', async () => {
      const res = await get('/businesses/public-test');
      expect(res.status).toBe(200);
      const text = await res.text();

      for (const secret of ['whatsapp', 'apiKeyRef', 'sessionId', 'secret-ref-must-not-leak', 'workingHours', 'PRIVATE-']) {
        expect(text).not.toContain(secret);
      }

      const body = JSON.parse(text);
      expect(body.tagline).toBe('Skin, done properly.');
      expect(body.services.map((s: { name: string }) => s.name)).toEqual(['Hydrafacial']);
      // The retired service is not something Dr. Ayesha can be booked for.
      expect(body.staff[0].serviceIds).toEqual([hydrafacial]);
      expect(body.hours).toHaveLength(7);
      expect(body.hours[0].breaks).toEqual([{ startsAt: '13:00', endsAt: '14:00' }]);
      expect(body.reviewCount).toBe(2);
      expect(body.rating).toBe(4.5);
    });

    it('404s an unpublished business everywhere', async () => {
      expect((await get('/businesses/public-test-hidden')).status).toBe(404);
      // Mapped to slugs first: the endpoint returns {slug, updatedAt} rows, and
      // `not.toContain` against a string would pass on ANY array of objects —
      // including one that leaked the hidden business.
      const slugs = await (await get('/businesses/slugs')).json();
      expect(slugs.map((row: { slug: string }) => row.slug)).not.toContain('public-test-hidden');

      const list = await (await get('/businesses?q=clinic')).json();
      expect(list.map((b: { slug: string }) => b.slug)).not.toContain('public-test-hidden');

      const { categories, cities } = await (await get('/facets')).json();
      expect(categories.map((c: { value: string }) => c.value)).not.toContain('hiddencat');
      expect(cities.map((c: { value: string }) => c.value)).not.toContain('Hiddenville');

      const reviews = await (await get('/reviews?limit=24')).text();
      expect(reviews).not.toContain('PRIVATE-');

      const service = String((await Service.findOne({ businessId: hiddenId }))!._id);
      expect((await get(`/businesses/public-test-hidden/availability?serviceId=${service}&date=${date}`)).status).toBe(404);
      expect(
        (await post('/businesses/public-test-hidden/holds', { serviceId: service, startsAt: at('10:00').toISOString() })).status,
      ).toBe(404);
    });

    it('searches across services, and requires every word', async () => {
      const hit = await (await get('/businesses?q=hydrafacial%20testabad')).json();
      expect(hit.map((b: { slug: string }) => b.slug)).toContain('public-test');

      const miss = await (await get('/businesses?q=hydrafacial%20lahore')).json();
      expect(miss.map((b: { slug: string }) => b.slug)).not.toContain('public-test');
    });

    it('answers a malformed id with 400, not a 500', async () => {
      const res = await get(`/businesses/public-test/availability?serviceId=nope&date=${date}`);
      expect(res.status).toBe(400);
    });
  });

  describe('web booking', () => {
    async function holdAt(hhmm: string, staffId = 'any') {
      return post('/businesses/public-test/holds', {
        serviceId: hydrafacial,
        staffId,
        startsAt: at(hhmm).toISOString(),
      });
    }

    it('books end to end: availability → hold → booking, confirmed and messaged', async () => {
      const { slots } = await (await get(`/businesses/public-test/availability?serviceId=${hydrafacial}&date=${date}`)).json();
      expect(slots.map((s: { startsAt: string }) => s.startsAt)).toContain(at('10:00').toISOString());

      const holdRes = await holdAt('10:00');
      expect(holdRes.status).toBe(201);
      const hold = await holdRes.json();
      expect(hold.staffId).toBe(staffA);
      // The web's two minutes, not WhatsApp's five.
      expect(new Date(hold.expiresAt).getTime() - Date.now()).toBeLessThanOrEqual(120_000);

      const res = await post('/businesses/public-test/bookings', {
        serviceId: hydrafacial,
        staffId: hold.staffId,
        startsAt: hold.startsAt,
        holdToken: hold.token,
        name: 'Web Customer',
        phone: phone(),
      });
      expect(res.status).toBe(201);
      const receipt = await res.json();
      expect(receipt).toMatchObject({ serviceName: 'Hydrafacial', staffName: 'Dr. Ayesha', status: BOOKING_STATUS.CONFIRMED });
      expect(receipt).not.toHaveProperty('clientId');

      const booking = await Booking.findById(receipt.id);
      expect(booking!.source).toBe('web');
      // 45 minutes on a 15-minute grid: three rows, the same shape as any booking.
      expect(await SlotOccupancy.countDocuments({ bookingId: receipt.id })).toBe(3);
      expect(provider.sent).toHaveLength(1);
    });

    it('hides a time WhatsApp is holding, and refuses to hold it', async () => {
      const held = await holdSlot(redis, {
        businessId,
        serviceId: hydrafacial,
        staffId: staffA,
        startsAt: at('11:00'),
        source: 'whatsapp',
      });
      expect(held.ok).toBe(true);

      const { slots } = await (await get(`/businesses/public-test/availability?serviceId=${hydrafacial}&date=${date}`)).json();
      const starts = slots.map((s: { startsAt: string }) => s.startsAt);
      expect(starts).not.toContain(at('11:00').toISOString());
      // 10:30 would run into the held 11:00 — every increment must be free.
      expect(starts).not.toContain(at('10:30').toISOString());

      expect((await holdAt('11:00')).status).toBe(409);
    });

    it('stops WhatsApp overlapping a web booking', async () => {
      const hold = await (await holdAt('15:00')).json();
      const res = await post('/businesses/public-test/bookings', {
        serviceId: hydrafacial,
        staffId: hold.staffId,
        startsAt: hold.startsAt,
        holdToken: hold.token,
        name: 'Web Customer',
        phone: phone(),
      });
      expect(res.status).toBe(201);

      // 15:15 overlaps the 15:00–15:45 web booking.
      const overlap = await holdSlot(redis, {
        businessId,
        serviceId: hydrafacial,
        staffId: staffA,
        startsAt: at('15:15'),
        source: 'whatsapp',
      });
      expect(overlap).toEqual({ ok: false, reason: 'slot_taken' });
    });

    it('refuses a booking with no valid hold', async () => {
      const res = await post('/businesses/public-test/bookings', {
        serviceId: hydrafacial,
        staffId: staffA,
        startsAt: at('16:00').toISOString(),
        holdToken: '00000000-0000-4000-8000-000000000000',
        name: 'Chancer',
        phone: phone(),
      });
      expect(res.status).toBe(409);
      expect((await res.json()).reason).toBe('hold_expired');
      expect(await Booking.countDocuments({ businessId })).toBe(0);
    });

    it('refuses a phone number nobody could be messaged on', async () => {
      const hold = await (await holdAt('16:00')).json();
      const res = await post('/businesses/public-test/bookings', {
        serviceId: hydrafacial,
        staffId: hold.staffId,
        startsAt: hold.startsAt,
        holdToken: hold.token,
        name: 'Typo',
        phone: '12-34-5',
      });
      expect(res.status).toBe(400);
      expect(await Booking.countDocuments({ businessId })).toBe(0);
    });

    it('releases a hold early, and only with the right token', async () => {
      const hold = await (await holdAt('12:00')).json();
      const offered = async () =>
        ((await (await get(`/businesses/public-test/availability?serviceId=${hydrafacial}&date=${date}`)).json()).slots as {
          startsAt: string;
        }[]).map((s) => s.startsAt);

      expect(await offered()).not.toContain(hold.startsAt);

      const release = (token: string) =>
        post('/businesses/public-test/holds/release', {
          token,
          serviceId: hydrafacial,
          staffId: hold.staffId,
          startsAt: hold.startsAt,
        });

      await release('00000000-0000-4000-8000-000000000000');
      expect(await offered()).not.toContain(hold.startsAt);

      await release(hold.token);
      expect(await offered()).toContain(hold.startsAt);
    });
  });
});
