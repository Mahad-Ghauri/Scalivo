import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import express from 'express';
import mongoose from 'mongoose';
import { Redis } from 'ioredis';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  BOOKING_STATUS,
  DEPOSIT_STATUS,
  LOYALTY_MINOR_PER_POINT,
  SESSION_STATUS,
  type MessagingProvider,
  type SendResult,
  loyaltyPoints,
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
import { ME_TOKEN_PATTERN, meTokenFor, resolveMeToken } from '../src/me/token.js';
import { meView } from '../src/me/view.js';
import { createPublicRouter } from '../src/public/routes.js';
import { confirmBooking } from '../src/notifications/confirm.js';
import { wallClockToUtc } from '../src/lib/time.js';
import { infraReady } from './infra.js';

/**
 * The customer's own page — milestone 3.3.
 *
 * Two claims carry the feature, and most of what is below exists to hold one of
 * them down:
 *
 *   1. **The token is the whole identity, and it reaches exactly one
 *      relationship.** Nothing a caller sends names a business, a customer or a
 *      booking. A token minted for one salon cannot read, book or rate at
 *      another, and the tests prove that by trying.
 *
 *   2. **It does not depend on the marketplace.** `Business.published` defaults
 *      to false, so the ordinary tenant — a salon taking WhatsApp bookings with
 *      no public listing — is unpublished. Every test here runs against an
 *      UNPUBLISHED business on purpose: if the page ever inherits the public
 *      router's published gate, this suite goes red rather than the pilot
 *      discovering it.
 */

const TZ = 'Asia/Karachi';

function nextTuesday(): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + ((9 - d.getUTCDay()) % 7 || 7));
  return d.toISOString().slice(0, 10);
}

class FakeProvider implements MessagingProvider {
  readonly name = 'fake';
  sent: { to: string; text: string }[] = [];
  private readonly prefix = `me-${Math.random().toString(36).slice(2, 10)}`;
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

describe('loyalty points', () => {
  /**
   * The balance is a pure function of completed spend — no ledger, nothing to
   * drift. These run without any infrastructure because that is the point: if
   * points ever need a database to be right, the design has gone wrong.
   */
  it('gives a point per Rs 100 of completed spend, rounded down', () => {
    expect(loyaltyPoints(0)).toBe(0);
    expect(loyaltyPoints(LOYALTY_MINOR_PER_POINT - 1)).toBe(0);
    expect(loyaltyPoints(LOYALTY_MINOR_PER_POINT)).toBe(1);
    // Rs 8,000 — one hydrafacial.
    expect(loyaltyPoints(800_000)).toBe(80);
  });

  it('never returns a negative balance', () => {
    expect(loyaltyPoints(-500)).toBe(0);
  });
});

const infraUp = await infraReady({ replicaSet: true, redis: true });

describe.skipIf(!infraUp)("a customer's own page", () => {
  let redis: Redis;
  let server: Server;
  let base: string;
  let provider: FakeProvider;

  let businessId: string;
  let otherId: string;
  let clientId: string;
  let strangerId: string;
  let hydrafacial: string;
  let retired: string;
  let otherService: string;
  let ayesha: string;
  let sana: string;
  let otherStaff: string;
  let date: string;

  const at = (hhmm: string) => wallClockToUtc(`${date}T${hhmm}`, TZ);

  /** Responses read loosely — the shapes are what these tests assert, not what they assume. */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  type Loose = Omit<Response, 'json'> & { json(): Promise<any> };
  const get = (path: string) => fetch(`${base}${path}`) as Promise<Loose>;
  const post = (path: string, body: unknown) =>
    fetch(`${base}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }) as Promise<Loose>;

  /** The token for the main relationship, minted the way production mints it. */
  const token = async () => {
    const value = await meTokenFor(businessId, clientId);
    if (!value) throw new Error('expected a token for the seeded relationship');
    return value;
  };

  beforeAll(async () => {
    // db 11 — 1–10 belong to the other infrastructure suites.
    redis = new Redis(process.env.REDIS_URL!, { db: 11 });
    date = nextTuesday();
    await Promise.all([SlotOccupancy.syncIndexes(), Review.syncIndexes(), ClientProfile.syncIndexes()]);

    provider = new FakeProvider();
    const app = express();
    app.use('/public', createPublicRouter(redis, provider));
    server = app.listen(0);
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/public`;
  });

  afterAll(async () => {
    server.close();
    await Promise.all([mongoose.disconnect(), redis.quit()]);
  });

  beforeEach(async () => {
    provider.sent.length = 0;

    /**
     * UNPUBLISHED, deliberately — see the suite's header. A salon that never
     * filled in a marketplace category still has customers with appointments.
     */
    const business = await Business.findOneAndUpdate(
      { slug: 'me-test' },
      {
        slug: 'me-test',
        name: 'Me Test Clinic',
        category: 'clinic',
        city: 'Testabad',
        timezone: TZ,
        slotIncrementMinutes: 15,
        minNoticeMinutes: 60,
        bookingHorizonDays: 30,
        published: false,
      },
      { upsert: true, new: true, setDefaultsOnInsert: true },
    );
    businessId = String(business._id);

    const other = await Business.findOneAndUpdate(
      { slug: 'me-test-other' },
      { slug: 'me-test-other', name: 'Other Clinic', timezone: TZ, published: false },
      { upsert: true, new: true, setDefaultsOnInsert: true },
    );
    otherId = String(other._id);

    const ids = [businessId, otherId];
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

    const [hydra, dead, elsewhere] = await Service.insertMany([
      { businessId, name: 'Hydrafacial', durationMinutes: 45, priceMinor: 800_000, displayOrder: 1 },
      { businessId, name: 'Retired peel', durationMinutes: 30, priceMinor: 100_000, active: false },
      { businessId: otherId, name: 'Massage', durationMinutes: 60, priceMinor: 500_000 },
    ]);
    hydrafacial = String(hydra!._id);
    retired = String(dead!._id);
    otherService = String(elsewhere!._id);

    const hours = [0, 1, 2, 3, 4, 5, 6].map((dayOfWeek) => ({
      dayOfWeek,
      opensAt: '09:00',
      closesAt: '18:00',
      breaks: [],
    }));
    const [a, s, o] = await Staff.insertMany([
      { businessId, name: 'Dr. Ayesha', serviceIds: [hydrafacial], workingHours: hours },
      // Qualified for the retired service only — never eligible for the usual.
      { businessId, name: 'Dr. Sana', serviceIds: [retired], workingHours: hours },
      { businessId: otherId, name: 'Masseur', serviceIds: [otherService], workingHours: hours },
    ]);
    ayesha = String(a!._id);
    sana = String(s!._id);
    otherStaff = String(o!._id);

    const [customer, stranger] = await Client.insertMany([
      { phone: null, displayName: 'Hina Raza', lids: [`me-test-${Date.now()}`] },
      { phone: null, displayName: 'Nobody', lids: [`me-other-${Date.now()}`] },
    ]);
    clientId = String(customer!._id);
    strangerId = String(stranger!._id);

    await ClientProfile.insertMany([
      {
        businessId,
        clientId,
        totalVisits: 3,
        lifetimeSpendMinor: 2_400_000, // Rs 24,000 → 240 points
        firstVisitAt: new Date('2026-01-10T09:00:00Z'),
        lastVisitAt: new Date('2026-08-01T09:00:00Z'),
        serviceCounts: { [hydrafacial]: 3 },
        staffCounts: { [ayesha]: 3 },
      },
      { businessId: otherId, clientId: strangerId, totalVisits: 1, lifetimeSpendMinor: 500_000 },
    ]);
  });

  /* ------------------------------------------------------------------ token */

  describe('the token', () => {
    it('is minted once and stays the same afterwards', async () => {
      const first = await meTokenFor(businessId, clientId);
      const second = await meTokenFor(businessId, clientId);

      expect(first).toMatch(ME_TOKEN_PATTERN);
      expect(second).toBe(first);
    });

    it('survives concurrent minting with one winner', async () => {
      const minted = await Promise.all(
        Array.from({ length: 5 }, () => meTokenFor(businessId, clientId)),
      );

      // Whoever wrote it first, everybody must be handed the same one — a second
      // token would mean a second live URL for the same relationship.
      expect(new Set(minted).size).toBe(1);
      expect(minted[0]).toMatch(ME_TOKEN_PATTERN);
    });

    it('is a key to ONE relationship, not to a person', async () => {
      // Same person, second business.
      await ClientProfile.create({ businessId: otherId, clientId, totalVisits: 0 });

      const here = await meTokenFor(businessId, clientId);
      const there = await meTokenFor(otherId, clientId);

      expect(there).not.toBe(here);
      expect(await resolveMeToken(here!)).toEqual({ businessId, clientId });
      expect(await resolveMeToken(there!)).toEqual({ businessId: otherId, clientId });
    });

    it('is not minted for somebody who has never booked here', async () => {
      expect(await meTokenFor(businessId, strangerId)).toBeNull();
    });

    it('resolves nothing for a malformed token, without querying', async () => {
      expect(await resolveMeToken('short')).toBeNull();
      expect(await resolveMeToken('../../etc/passwd')).toBeNull();
      // Right shape, never issued.
      expect(await resolveMeToken('a'.repeat(32))).toBeNull();
    });
  });

  /* ------------------------------------------------------------------- view */

  describe('what the page shows', () => {
    it('separates what is coming from what has happened', async () => {
      await Booking.insertMany([
        {
          businessId,
          clientId,
          serviceId: hydrafacial,
          staffId: ayesha,
          startsAt: at('10:00'),
          durationMinutes: 45,
          priceMinor: 800_000,
          status: BOOKING_STATUS.CONFIRMED,
          source: 'whatsapp',
        },
        {
          businessId,
          clientId,
          serviceId: hydrafacial,
          staffId: ayesha,
          startsAt: new Date('2026-01-10T09:00:00Z'),
          durationMinutes: 45,
          priceMinor: 800_000,
          status: BOOKING_STATUS.COMPLETED,
          completedAt: new Date('2026-01-10T10:00:00Z'),
          source: 'whatsapp',
        },
        // Called off: belongs in neither list.
        {
          businessId,
          clientId,
          serviceId: hydrafacial,
          staffId: ayesha,
          startsAt: at('16:00'),
          durationMinutes: 45,
          priceMinor: 800_000,
          status: BOOKING_STATUS.CANCELLED,
          source: 'whatsapp',
        },
      ]);

      const view = await meView(businessId, clientId);

      expect(view!.upcoming).toHaveLength(1);
      expect(view!.upcoming[0]!.serviceName).toBe('Hydrafacial');
      expect(view!.upcoming[0]!.staffName).toBe('Dr. Ayesha');
      expect(view!.past).toHaveLength(1);
      expect(view!.past[0]!.status).toBe(BOOKING_STATUS.COMPLETED);
    });

    it('offers the payment link only while the deposit is actually owed', async () => {
      const [owed, settled] = await Booking.insertMany([
        {
          businessId,
          clientId,
          serviceId: hydrafacial,
          staffId: ayesha,
          startsAt: at('10:00'),
          durationMinutes: 45,
          priceMinor: 800_000,
          status: BOOKING_STATUS.AWAITING_DEPOSIT,
          source: 'whatsapp',
          depositMinor: 200_000,
          depositStatus: DEPOSIT_STATUS.AWAITING,
          depositToken: 'owed-token',
        },
        {
          businessId,
          clientId,
          serviceId: hydrafacial,
          staffId: ayesha,
          startsAt: at('12:00'),
          durationMinutes: 45,
          priceMinor: 800_000,
          status: BOOKING_STATUS.CONFIRMED,
          source: 'whatsapp',
          depositMinor: 200_000,
          depositStatus: DEPOSIT_STATUS.PAID,
          depositToken: 'paid-token',
        },
      ]);

      const view = await meView(businessId, clientId);
      const byId = new Map(view!.upcoming.map((a) => [a.id, a.depositToken]));

      expect(byId.get(String(owed!._id))).toBe('owed-token');
      // Paid. A live link here would invite them to pay twice.
      expect(byId.get(String(settled!._id))).toBeNull();
    });

    it('derives points from completed spend', async () => {
      const view = await meView(businessId, clientId);

      expect(view!.loyalty.points).toBe(240);
      expect(view!.loyalty.visits).toBe(3);
      expect(view!.loyalty.memberSince).toBe(new Date('2026-01-10T09:00:00Z').toISOString());
    });

    it('proposes their usual service, with their usual person', async () => {
      const view = await meView(businessId, clientId);

      expect(view!.usual).toMatchObject({
        serviceId: hydrafacial,
        serviceName: 'Hydrafacial',
        staffId: ayesha,
        staffName: 'Dr. Ayesha',
      });
    });

    it('drops a staff preference the service cannot honour, and keeps the service', async () => {
      // Their most-seen person is Sana, who does not perform a Hydrafacial.
      await ClientProfile.updateOne(
        { businessId, clientId },
        { $set: { staffCounts: { [sana]: 9, [ayesha]: 1 } } },
      );

      const view = await meView(businessId, clientId);

      // Ayesha can, so she is offered — losing a stylist is not a reason to stop
      // offering the treatment.
      expect(view!.usual!.serviceId).toBe(hydrafacial);
      expect(view!.usual!.staffId).toBe(ayesha);
    });

    it('offers nothing to rebook when their usual service has been retired', async () => {
      await ClientProfile.updateOne(
        { businessId, clientId },
        { $set: { serviceCounts: { [retired]: 5 } } },
      );

      expect((await meView(businessId, clientId))!.usual).toBeNull();
    });

    it('asks about the latest unrated visit, and only that one', async () => {
      const [older, newer] = await Booking.insertMany([
        {
          businessId,
          clientId,
          serviceId: hydrafacial,
          staffId: ayesha,
          startsAt: new Date('2026-01-10T09:00:00Z'),
          durationMinutes: 45,
          priceMinor: 800_000,
          status: BOOKING_STATUS.COMPLETED,
          completedAt: new Date('2026-01-10T10:00:00Z'),
          source: 'whatsapp',
        },
        {
          businessId,
          clientId,
          serviceId: hydrafacial,
          staffId: ayesha,
          startsAt: new Date('2026-02-10T09:00:00Z'),
          durationMinutes: 45,
          priceMinor: 800_000,
          status: BOOKING_STATUS.COMPLETED,
          completedAt: new Date('2026-02-10T10:00:00Z'),
          source: 'whatsapp',
        },
      ]);

      expect((await meView(businessId, clientId))!.pendingReview!.bookingId).toBe(String(newer!._id));

      await Review.create({
        businessId,
        bookingId: String(newer!._id),
        clientId,
        authorName: 'Hina',
        rating: 5,
        published: true,
      });

      // Falls back to the older unrated one, not to nothing.
      expect((await meView(businessId, clientId))!.pendingReview!.bookingId).toBe(String(older!._id));

      await Review.create({
        businessId,
        bookingId: String(older!._id),
        clientId,
        authorName: 'Hina',
        rating: 4,
        published: true,
      });

      expect((await meView(businessId, clientId))!.pendingReview).toBeNull();
    });
  });

  /* ----------------------------------------------------------------- routes */

  describe('the surface', () => {
    it('serves the page for an UNPUBLISHED business', async () => {
      const res = await get(`/me/${await token()}`);

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.businessName).toBe('Me Test Clinic');
      expect(body.firstName).toBe('Hina');
    });

    it('404s an unknown token rather than saying it is wrong', async () => {
      const res = await get(`/me/${'z'.repeat(32)}`);

      expect(res.status).toBe(404);
      expect((await res.json()).error).toBe('not found');
    });

    it('never returns another customer, a phone number or an internal id', async () => {
      await Booking.create({
        businessId,
        clientId,
        serviceId: hydrafacial,
        staffId: ayesha,
        startsAt: at('10:00'),
        durationMinutes: 45,
        priceMinor: 800_000,
        status: BOOKING_STATUS.CONFIRMED,
        source: 'whatsapp',
      });

      const text = await (await get(`/me/${await token()}`)).text();

      for (const leak of [clientId, businessId, 'lids', 'phone', 'Nobody']) {
        expect(text).not.toContain(leak);
      }
    });

    it('books the usual again without a name or a phone number', async () => {
      const mine = await token();

      const slots = await (
        await get(`/me/${mine}/availability?serviceId=${hydrafacial}&staffId=${ayesha}&date=${date}`)
      ).json();
      expect(slots.slots.length).toBeGreaterThan(0);

      const slot = slots.slots[0];
      const hold = await (
        await post(`/me/${mine}/holds`, { serviceId: hydrafacial, staffId: slot.staffId, startsAt: slot.startsAt })
      ).json();

      const res = await post(`/me/${mine}/bookings`, {
        serviceId: hydrafacial,
        staffId: hold.staffId,
        startsAt: hold.startsAt,
        holdToken: hold.token,
      });

      expect(res.status).toBe(201);
      const receipt = await res.json();
      expect(receipt.serviceName).toBe('Hydrafacial');

      // The booking belongs to the token's owner — nothing in the request said so.
      const booking = await Booking.findById(receipt.id);
      expect(booking!.clientId).toBe(clientId);
      expect(booking!.businessId).toBe(businessId);
      expect(booking!.source).toBe('web');
    });

    it('refuses a time somebody else has already taken', async () => {
      const mine = await token();
      const slots = await (
        await get(`/me/${mine}/availability?serviceId=${hydrafacial}&staffId=${ayesha}&date=${date}`)
      ).json();
      const slot = slots.slots[0];

      const hold = await (
        await post(`/me/${mine}/holds`, { serviceId: hydrafacial, staffId: slot.staffId, startsAt: slot.startsAt })
      ).json();

      // A second hold on the same time, while the first is live.
      const second = await post(`/me/${mine}/holds`, {
        serviceId: hydrafacial,
        staffId: slot.staffId,
        startsAt: slot.startsAt,
      });

      expect(second.status).toBe(409);
      expect((await second.json()).reason).toBe('slot_taken');
      expect(hold.token).toBeTruthy();
    });

    it('records a rating, and refuses one for a visit that is not theirs', async () => {
      const mine = await token();
      const visit = await Booking.create({
        businessId,
        clientId,
        serviceId: hydrafacial,
        staffId: ayesha,
        startsAt: new Date('2026-02-10T09:00:00Z'),
        durationMinutes: 45,
        priceMinor: 800_000,
        status: BOOKING_STATUS.COMPLETED,
        completedAt: new Date('2026-02-10T10:00:00Z'),
        source: 'whatsapp',
      });

      const res = await post(`/me/${mine}/reviews`, {
        bookingId: String(visit._id),
        rating: 5,
        comment: 'Genuinely the best facial in town.',
      });

      expect(res.status).toBe(201);
      expect((await res.json()).published).toBe(true);

      const saved = await Review.findOne({ bookingId: String(visit._id) });
      expect(saved!.rating).toBe(5);
      expect(saved!.comment).toBe('Genuinely the best facial in town.');

      // Somebody else's appointment, at another business.
      const theirs = await Booking.create({
        businessId: otherId,
        clientId: strangerId,
        serviceId: otherService,
        staffId: otherStaff,
        startsAt: new Date('2026-02-10T09:00:00Z'),
        durationMinutes: 60,
        priceMinor: 500_000,
        status: BOOKING_STATUS.COMPLETED,
        completedAt: new Date('2026-02-10T10:00:00Z'),
        source: 'whatsapp',
      });

      const refused = await post(`/me/${mine}/reviews`, { bookingId: String(theirs._id), rating: 1 });
      expect(refused.status).toBe(404);
      expect(await Review.findOne({ bookingId: String(theirs._id) })).toBeNull();
    });
  });

  /* --------------------------------------------------------------- tenancy */

  describe('one token, one relationship', () => {
    it('cannot read another business through the token it holds', async () => {
      await ClientProfile.create({ businessId: otherId, clientId, totalVisits: 0 });
      const here = (await meTokenFor(businessId, clientId))!;

      const body = await (await get(`/me/${here}`)).json();

      // The token names its own business. There is no parameter to point elsewhere.
      expect(body.businessName).toBe('Me Test Clinic');
      expect(body.businessSlug).toBe('me-test');
    });

    it('cannot book another business through it either', async () => {
      const here = (await meTokenFor(businessId, clientId))!;

      // A service id from the other tenant, with this tenant's token.
      const slots = await (
        await get(`/me/${here}/availability?serviceId=${otherService}&date=${date}`)
      ).json();
      expect(slots.slots).toEqual([]);

      const hold = await post(`/me/${here}/holds`, {
        serviceId: otherService,
        staffId: otherStaff,
        startsAt: at('10:00').toISOString(),
      });
      expect(hold.status).toBe(400);
      expect((await hold.json()).reason).toBe('invalid_slot');
    });
  });

  /* ------------------------------------------------------------ the link */

  describe('the magic link', () => {
    it('rides out on the confirmation, so a lost link is always recoverable', async () => {
      const booking = await Booking.create({
        businessId,
        clientId,
        serviceId: hydrafacial,
        staffId: ayesha,
        startsAt: at('10:00'),
        durationMinutes: 45,
        priceMinor: 800_000,
        status: BOOKING_STATUS.PENDING,
        source: 'whatsapp',
      });

      await confirmBooking({ redis, provider }, businessId, String(booking._id));

      const profile = await ClientProfile.findOne({ businessId, clientId }).select('meToken');
      expect(profile!.meToken).toMatch(ME_TOKEN_PATTERN);

      const notification = await Notification.findOne({ bookingId: String(booking._id) });
      expect(notification!.text).toContain(`/me/${profile!.meToken}`);
    });

    it('sends the confirmation even when the page cannot be addressed', async () => {
      /**
       * The profile is what carries the token, so a booking whose profile has
       * not been written yet is the case that would lose a confirmation if the
       * link were a hard dependency. It must not be — the confirmation is what
       * the customer is owed; the page is a convenience.
       */
      await ClientProfile.deleteMany({ businessId, clientId });

      const booking = await Booking.create({
        businessId,
        clientId,
        serviceId: hydrafacial,
        staffId: ayesha,
        startsAt: at('11:00'),
        durationMinutes: 45,
        priceMinor: 800_000,
        status: BOOKING_STATUS.PENDING,
        source: 'whatsapp',
      });

      await confirmBooking({ redis, provider }, businessId, String(booking._id));

      const notification = await Notification.findOne({ bookingId: String(booking._id) });
      expect(notification!.text).toContain("You're booked");
      expect(notification!.text).not.toContain('/me/');
    });
  });
});
