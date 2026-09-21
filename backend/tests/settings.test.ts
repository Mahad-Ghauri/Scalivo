import type { AddressInfo } from 'node:net';
import express from 'express';
import mongoose from 'mongoose';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { MessagingProvider, SendResult } from '@scalivo/shared';
import { SESSION_STATUS } from '@scalivo/shared';
import { Business } from '../src/models/Business.js';
import { Service } from '../src/models/Service.js';
import { Staff } from '../src/models/Staff.js';
import { SlotOccupancy } from '../src/models/SlotOccupancy.js';
import { createBusinessRouter } from '../src/businesses/routes.js';
import { signToken } from '../src/auth/jwt.js';
import { infraReady } from './infra.js';

/**
 * Business settings — PATCH /businesses/:id.
 *
 * The form is cosmetic; these rules are not. Three of them protect something
 * an owner cannot see break:
 *
 *   - partial updates must not wipe siblings (a toggle that resets the lead
 *     times, a tagline edit that empties the gallery),
 *   - the slot size cannot change under existing bookings (it would stop two
 *     overlapping bookings from colliding on the unique index),
 *   - a business cannot be published while nobody can be booked (the customer
 *     sees "no times available" and concludes the salon is full).
 *
 * Needs Mongo.
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const json = (res: Response): Promise<any> => res.json();

/** Settings never reach the gateway; every method is a tripwire. */
const provider = {
  name: 'unused',
  sendText: async (): Promise<SendResult> => {
    throw new Error('settings must not send');
  },
  getSessionStatus: async () => SESSION_STATUS.READY,
} as unknown as MessagingProvider;

const infraUp = await infraReady();

describe.skipIf(!infraUp)('business settings', () => {
  let businessId: string;
  let otherBusinessId: string;
  let token: string;
  let serverUrl: string;
  let server: ReturnType<express.Express['listen']>;

  const patch = (body: unknown, id = businessId) =>
    fetch(`${serverUrl}/businesses/${id}`, {
      method: 'PATCH',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

  /** Services, staff, hours and coverage — everything publishing asks for. */
  async function makeBookable() {
    const service = await Service.create({
      businessId,
      name: 'Hydrafacial',
      durationMinutes: 45,
      priceMinor: 100_000,
      displayOrder: 1,
    });
    await Staff.create({
      businessId,
      name: 'Ayesha',
      serviceIds: [String(service._id)],
      workingHours: [{ dayOfWeek: 1, opensAt: '10:00', closesAt: '18:00', breaks: [] }],
    });
  }

  beforeAll(() => {
    const app = express();
    app.use('/businesses', createBusinessRouter(provider));
    server = app.listen(0);
    serverUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    if (server) server.close();
    await mongoose.disconnect();
  });

  beforeEach(async () => {
    const seed = (slug: string, name: string) =>
      Business.findOneAndReplace(
        { slug },
        { slug, name, category: 'salon', city: 'Lahore', timezone: 'Asia/Karachi' },
        { upsert: true, new: true },
      );

    const business = await seed('settings-test', 'Settings Test Salon');
    const other = await seed('settings-other', 'Someone Else');
    businessId = String(business!._id);
    otherBusinessId = String(other!._id);
    token = signToken({ userId: 'owner-settings', role: 'owner', businessIds: [businessId] });

    await Promise.all([
      Service.deleteMany({ businessId }),
      Staff.deleteMany({ businessId }),
      SlotOccupancy.deleteMany({ businessId }),
    ]);
  });

  it('updates the profile without touching fields the form did not send', async () => {
    await Business.updateOne(
      { _id: businessId },
      {
        $set: {
          'profile.about': 'Skin clinic since 2019.',
          'profile.gallery': [{ url: 'https://img.example/a.jpg', alt: 'Treatment room' }],
        },
      },
    );

    const res = await patch({ profile: { tagline: 'Hydrafacials in DHA' } });
    expect(res.status).toBe(200);

    const stored = await Business.findById(businessId);
    expect(stored!.profile!.tagline).toBe('Hydrafacials in DHA');
    expect(stored!.profile!.about).toBe('Skin clinic since 2019.');
    expect(stored!.profile!.gallery).toHaveLength(1);
  });

  it('turning reminders off keeps the lead times', async () => {
    await Business.updateOne({ _id: businessId }, { $set: { 'reminders.leadMinutes': [1440, 120] } });

    expect((await patch({ reminders: { enabled: false } })).status).toBe(200);

    const stored = await Business.findById(businessId);
    expect(stored!.reminders!.enabled).toBe(false);
    expect(stored!.reminders!.leadMinutes).toEqual([1440, 120]);
  });

  it('drops duplicate lead times and orders them earliest reminder first', async () => {
    expect((await patch({ reminders: { leadMinutes: [120, 1440, 120] } })).status).toBe(200);
    const stored = await Business.findById(businessId);
    expect(stored!.reminders!.leadMinutes).toEqual([1440, 120]);
  });

  it('stores a blank optional field as null, not as an empty string', async () => {
    await Business.updateOne({ _id: businessId }, { $set: { 'profile.addressLine': '12 Main Blvd' } });

    expect((await patch({ profile: { addressLine: '   ', logoUrl: '' } })).status).toBe(200);

    const stored = await Business.findById(businessId);
    expect(stored!.profile!.addressLine).toBeNull();
    expect(stored!.profile!.logoUrl).toBeNull();
  });

  it('refuses an image link that is not https', async () => {
    for (const coverUrl of ['http://img.example/a.jpg', 'javascript:alert(1)', 'img.example/a.jpg']) {
      const res = await patch({ profile: { coverUrl } });
      expect(res.status).toBe(400);
      expect((await json(res)).fields['profile.coverUrl']).toBeDefined();
    }
  });

  it('accepts only a strict hex accent colour, normalised to lower case', async () => {
    expect((await patch({ profile: { themeColor: 'red; background:url(x)' } })).status).toBe(400);
    expect((await patch({ profile: { themeColor: '#AA33CC' } })).status).toBe(200);
    expect((await Business.findById(businessId))!.profile!.themeColor).toBe('#aa33cc');
  });

  it('refuses a timezone the runtime does not know', async () => {
    const res = await patch({ timezone: 'Asia/Lahore' });
    expect(res.status).toBe(400);
    expect((await json(res)).fields.timezone).toMatch(/IANA/);
  });

  it('refuses to change the slot size while bookings sit on the old grid', async () => {
    await SlotOccupancy.create({
      businessId,
      staffId: 'staff-1',
      slotStart: new Date(Date.now() + 24 * 60 * 60 * 1000),
      bookingId: 'booking-1',
    });

    const res = await patch({ slotIncrementMinutes: 30 });
    expect(res.status).toBe(409);
    expect((await Business.findById(businessId))!.slotIncrementMinutes).toBe(15);

    // Re-sending the CURRENT value is not a change and must not be refused —
    // the form sends every field on every save.
    expect((await patch({ slotIncrementMinutes: 15 })).status).toBe(200);
  });

  describe('publishing', () => {
    it('refuses while nobody can be booked, and says why', async () => {
      const res = await patch({ published: true, profile: { tagline: 'Skin, done properly' } });
      expect(res.status).toBe(409);

      const body = await json(res);
      expect(body.blockers.join(' ')).toMatch(/service/i);
      expect((await Business.findById(businessId))!.published).toBe(false);
    });

    it('refuses without a tagline, since search has nothing to show under the name', async () => {
      await makeBookable();
      const res = await patch({ published: true });
      expect(res.status).toBe(409);
      expect((await json(res)).blockers.join(' ')).toMatch(/tagline/i);
    });

    it('judges the business as it will be, so the tagline and the switch can go in one save', async () => {
      await makeBookable();
      const res = await patch({ published: true, profile: { tagline: 'Skin, done properly' } });
      expect(res.status).toBe(200);
      expect((await Business.findById(businessId))!.published).toBe(true);
    });

    it('does not require WhatsApp — the marketplace books over the web', async () => {
      await makeBookable();
      await Business.updateOne({ _id: businessId }, { $set: { 'profile.tagline': 'Skin' } });
      expect((await patch({ published: true })).status).toBe(200);
    });

    it('never refuses unpublishing', async () => {
      await Business.updateOne({ _id: businessId }, { $set: { published: true } });
      expect((await patch({ published: false })).status).toBe(200);
      expect((await Business.findById(businessId))!.published).toBe(false);
    });
  });

  it("returns 404 for another business's settings", async () => {
    const res = await patch({ name: 'Hijacked' }, otherBusinessId);
    expect(res.status).toBe(404);
    expect((await Business.findById(otherBusinessId))!.name).toBe('Someone Else');
  });
});
