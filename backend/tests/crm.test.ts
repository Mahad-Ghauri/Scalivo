import { CapacityOccupancy } from '../src/models/CapacityOccupancy.js';
import mongoose from 'mongoose';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { BOOKING_STATUS, CLIENT_TAG } from '@scalivo/shared';
import { Booking } from '../src/models/Booking.js';
import { Business } from '../src/models/Business.js';
import { Client } from '../src/models/Client.js';
import { ClientProfile } from '../src/models/ClientProfile.js';
import { SlotOccupancy } from '../src/models/SlotOccupancy.js';
import { averageGapDays, computeTags, nextExpectedVisitAt } from '../src/crm/tags.js';
import { loadProfile, recomputeProfile } from '../src/crm/profile.js';
import { setBookingOutcome } from '../src/bookings/outcome.js';
import { infraReady } from './infra.js';

/**
 * The self-populating CRM.
 *
 * Two things this file is really testing.
 *
 * First, that a counter moves exactly once per real event. The counters are a
 * cache of the Booking collection, and the only thing keeping them honest is
 * that every writer guards on the status TRANSITION rather than on the request.
 * A double-tapped "Complete" giving a customer two visits is the bug, and it is
 * invisible until someone reads a profile months later.
 *
 * Second, that tags are computed and not stored. LAPSED is a function of
 * elapsed time and nothing fires when a customer stops coming — so every tag
 * test pins `now` rather than waiting, which is only possible because nothing
 * is written.
 *
 * The tag block needs no infrastructure. The rest needs Mongo.
 */

const DAY = 86_400_000;
const PKR = 100; // paisa per rupee

// ── Tags: pure, and the thresholds are the product decision ───────────────

describe('client tags', () => {
  const profile = (over: Partial<Parameters<typeof computeTags>[0]> = {}) => ({
    totalVisits: 0,
    lifetimeSpendMinor: 0,
    firstVisitAt: null,
    lastVisitAt: null,
    lastBookingAt: null,
    ...over,
  });

  const settled = { hasUpcomingBooking: false };

  it('tags a first-time customer NEW', () => {
    expect(computeTags(profile({ totalVisits: 1 }), settled)).toContain(CLIENT_TAG.NEW);
  });

  it('stops calling them NEW once they have come back', () => {
    expect(computeTags(profile({ totalVisits: 2 }), settled)).not.toContain(CLIENT_TAG.NEW);
  });

  it('tags VIP on visit count', () => {
    expect(computeTags(profile({ totalVisits: 5 }), settled)).toContain(CLIENT_TAG.VIP);
  });

  /**
   * Someone whose FIRST appointment was a large package is both new and
   * valuable. Treating them as merely new is how a business loses them.
   */
  it('tags VIP on spend alone, even on a first visit', () => {
    const tags = computeTags(
      profile({ totalVisits: 1, lifetimeSpendMinor: 60_000 * PKR }),
      settled,
    );
    expect(tags).toContain(CLIENT_TAG.VIP);
    expect(tags).toContain(CLIENT_TAG.NEW);
  });

  it('tags LAPSED after 90 days away', () => {
    const now = new Date();
    const tags = computeTags(
      profile({ totalVisits: 3, lastVisitAt: new Date(now.getTime() - 100 * DAY) }),
      { hasUpcomingBooking: false, now },
    );
    expect(tags).toContain(CLIENT_TAG.LAPSED);
  });

  /**
   * AT_RISK measures someone against THEIR OWN cadence, not a fixed number of
   * days. A monthly client at 50 days is slipping; an annual one is early.
   */
  it('tags AT_RISK against the customer own rhythm, not a fixed interval', () => {
    const now = new Date();
    // Four visits, 30 days apart: a 30-day habit, last seen 50 days ago.
    const monthly = profile({
      totalVisits: 4,
      firstVisitAt: new Date(now.getTime() - 140 * DAY),
      lastVisitAt: new Date(now.getTime() - 50 * DAY),
    });
    expect(computeTags(monthly, { hasUpcomingBooking: false, now })).toContain(CLIENT_TAG.AT_RISK);

    // Same 50 days, but this customer comes once a year. Not late at all.
    const annual = profile({
      totalVisits: 4,
      firstVisitAt: new Date(now.getTime() - 1145 * DAY),
      lastVisitAt: new Date(now.getTime() - 50 * DAY),
    });
    expect(computeTags(annual, { hasUpcomingBooking: false, now })).not.toContain(
      CLIENT_TAG.AT_RISK,
    );
  });

  it('never tags both AT_RISK and LAPSED', () => {
    const now = new Date();
    const tags = computeTags(
      profile({
        totalVisits: 5,
        firstVisitAt: new Date(now.getTime() - 200 * DAY),
        lastVisitAt: new Date(now.getTime() - 120 * DAY),
      }),
      { hasUpcomingBooking: false, now },
    );
    expect(tags).toContain(CLIENT_TAG.LAPSED);
    expect(tags).not.toContain(CLIENT_TAG.AT_RISK);
  });

  /**
   * Chasing someone who is booked for Thursday reads as a business that does
   * not know its own diary — and in Phase 2 it would be a real message sent.
   */
  it('never chases someone with an appointment already booked', () => {
    const now = new Date();
    const long_gone = profile({
      totalVisits: 3,
      firstVisitAt: new Date(now.getTime() - 300 * DAY),
      lastVisitAt: new Date(now.getTime() - 200 * DAY),
    });

    expect(computeTags(long_gone, { hasUpcomingBooking: true, now })).not.toContain(
      CLIENT_TAG.LAPSED,
    );
  });

  it('does not call someone lapsed before they have ever visited', () => {
    expect(computeTags(profile({ totalVisits: 0 }), settled)).not.toContain(CLIENT_TAG.LAPSED);
  });

  it('refuses to guess a cadence from a single interval', () => {
    const now = new Date();
    // Two visits is one gap, which is a coincidence rather than a pattern.
    expect(
      averageGapDays({
        totalVisits: 2,
        lifetimeSpendMinor: 0,
        firstVisitAt: new Date(now.getTime() - 60 * DAY),
        lastVisitAt: now,
        lastBookingAt: null,
      }),
    ).toBeNull();
  });

  it('computes the mean gap and the next expected visit', () => {
    const now = new Date();
    const taggable = {
      totalVisits: 4,
      lifetimeSpendMinor: 0,
      firstVisitAt: new Date(now.getTime() - 90 * DAY),
      lastVisitAt: now,
      lastBookingAt: null,
    };

    // 90 days spanning 3 gaps.
    expect(averageGapDays(taggable)).toBeCloseTo(30, 5);
    expect(nextExpectedVisitAt(taggable)?.getTime()).toBeCloseTo(now.getTime() + 30 * DAY, -4);
  });
});

const infraUp = await infraReady();

describe.skipIf(!infraUp)('client profiles', () => {
  let businessId: string;
  let clientId: string;

  const profile = () => ClientProfile.findOne({ businessId, clientId });

  afterAll(async () => {
    await mongoose.disconnect();
  });

  /** A booking in the past, so it can be completed without fighting the clock. */
  async function pastBooking(over: Record<string, unknown> = {}) {
    return Booking.create({
      businessId,
      staffId: 'staff-1',
      clientId,
      serviceId: 'service-1',
      startsAt: new Date(Date.now() - 2 * DAY),
      durationMinutes: 45,
      status: BOOKING_STATUS.CONFIRMED,
      priceMinor: 8000 * PKR,
      source: 'whatsapp',
      ...over,
    });
  }

  beforeEach(async () => {
    const business = await Business.findOneAndUpdate(
      { slug: 'crm-test' },
      { slug: 'crm-test', name: 'CRM Test Salon', category: 'salon' },
      { upsert: true, new: true, setDefaultsOnInsert: true },
    );
    businessId = String(business._id);

    const client = await Client.findOneAndUpdate(
      { phone: '923009999001' },
      { phone: '923009999001', displayName: 'Sana Khan', lids: ['crm-test@lid'] },
      { upsert: true, new: true, setDefaultsOnInsert: true },
    );
    clientId = String(client._id);

    await Promise.all([
      Booking.deleteMany({ businessId }),
      ClientProfile.deleteMany({ businessId }),
      SlotOccupancy.deleteMany({ businessId }),
      CapacityOccupancy.deleteMany({ businessId }),
    ]);
  });

  describe('counters', () => {
    it('records a visit and its spend when a booking is completed', async () => {
      const booking = await pastBooking();

      const result = await setBookingOutcome(String(booking._id), businessId, 'completed');

      expect(result).toMatchObject({ ok: true });
      const after = await profile();
      expect(after?.totalVisits).toBe(1);
      expect(after?.lifetimeSpendMinor).toBe(8000 * PKR);
      expect(after?.lastVisitAt).toEqual(booking.startsAt);
    });

    /**
     * THE test in this file.
     *
     * Two owners on two phones, or one owner double-tapping a slow button. The
     * status is the guard in the update filter, so the second call matches
     * nothing and counts nothing. Checking first and then incrementing is the
     * same check-then-write race the booking grid exists to avoid.
     */
    it('counts one visit however many times Complete is tapped', async () => {
      const booking = await pastBooking();

      const [first, second, third] = await Promise.all([
        setBookingOutcome(String(booking._id), businessId, 'completed'),
        setBookingOutcome(String(booking._id), businessId, 'completed'),
        setBookingOutcome(String(booking._id), businessId, 'completed'),
      ]);

      const outcomes = [first, second, third];
      expect(outcomes.filter((r) => r.ok)).toHaveLength(1);
      expect((await profile())?.totalVisits).toBe(1);
    });

    it('reports an already-marked booking as such, not as missing', async () => {
      const booking = await pastBooking();
      await setBookingOutcome(String(booking._id), businessId, 'completed');

      const again = await setBookingOutcome(String(booking._id), businessId, 'no_show');
      expect(again).toEqual({ ok: false, reason: 'already_terminal' });
      // And it did NOT reopen a settled booking.
      expect((await Booking.findById(booking._id))?.status).toBe(BOOKING_STATUS.COMPLETED);
    });

    it('counts a no-show without counting it as a visit or as revenue', async () => {
      const booking = await pastBooking();

      await setBookingOutcome(String(booking._id), businessId, 'no_show');

      const after = await profile();
      expect(after?.noShows).toBe(1);
      expect(after?.totalVisits).toBe(0);
      expect(after?.lifetimeSpendMinor).toBe(0);
    });

    /**
     * The slot was consumed whether or not anyone turned up. Reopening it would
     * let the grid sell an hour the staff member has already spent waiting.
     */
    it('keeps a no-show occupying its slot', async () => {
      const booking = await pastBooking();
      await SlotOccupancy.create({
        businessId,
        staffId: 'staff-1',
        slotStart: booking.startsAt,
        bookingId: String(booking._id),
      });

      await setBookingOutcome(String(booking._id), businessId, 'no_show');

      expect(await SlotOccupancy.countDocuments({ bookingId: String(booking._id) })).toBe(1);
    });

    it('frees the slot on a cancellation', async () => {
      const booking = await pastBooking();
      await SlotOccupancy.create({
        businessId,
        staffId: 'staff-1',
        slotStart: booking.startsAt,
        bookingId: String(booking._id),
      });

      await setBookingOutcome(String(booking._id), businessId, 'cancelled');

      expect(await SlotOccupancy.countDocuments({ bookingId: String(booking._id) })).toBe(0);
      expect((await profile())?.cancellations).toBe(1);
    });

    /**
     * An owner catching up on Monday marks Saturday complete after Sunday. A
     * plain $set would drag firstVisitAt forwards and destroy the cadence every
     * retention decision is built on.
     */
    it('keeps first and last visit correct whichever order outcomes arrive in', async () => {
      // BOTH orders, deliberately. The chronological one is the case a plain
      // $set breaks — the later booking lands last and drags firstVisitAt
      // forwards with it — and testing only the reversed order would pass
      // against exactly that bug.
      for (const chronological of [true, false]) {
        await Promise.all([
          Booking.deleteMany({ businessId }),
          ClientProfile.deleteMany({ businessId }),
        ]);

        const earlier = await pastBooking({ startsAt: new Date(Date.now() - 40 * DAY) });
        const later = await pastBooking({ startsAt: new Date(Date.now() - 2 * DAY) });
        const order = chronological ? [earlier, later] : [later, earlier];

        for (const booking of order) {
          await setBookingOutcome(String(booking._id), businessId, 'completed');
        }

        const after = await profile();
        expect(after?.firstVisitAt, `chronological=${chronological}`).toEqual(earlier.startsAt);
        expect(after?.lastVisitAt, `chronological=${chronological}`).toEqual(later.startsAt);
      }
    });

    it('remembers the usual service and the preferred staff member', async () => {
      const a = await pastBooking({ serviceId: 'facial', staffId: 'ayesha' });
      const b = await pastBooking({ serviceId: 'facial', staffId: 'ayesha' });
      const c = await pastBooking({ serviceId: 'laser', staffId: 'bilal' });

      for (const booking of [a, b, c]) {
        await setBookingOutcome(String(booking._id), businessId, 'completed');
      }

      const view = await loadProfile(businessId, clientId);
      expect(view?.mostBookedServiceId).toBe('facial');
      expect(view?.preferredStaffId).toBe('ayesha');
    });
  });

  describe('the counters are a cache', () => {
    /**
     * The claim that drift is survivable has to be demonstrable, or it is just
     * a hope written in a comment. This corrupts a profile deliberately and
     * rebuilds it from the bookings.
     */
    it('rebuilds a profile from the bookings after drift', async () => {
      const booking = await pastBooking();
      await setBookingOutcome(String(booking._id), businessId, 'completed');

      await ClientProfile.updateOne(
        { businessId, clientId },
        { $set: { totalVisits: 99, lifetimeSpendMinor: 0, notes: 'allergic to retinol' } },
      );

      await recomputeProfile(businessId, clientId);

      const after = await profile();
      expect(after?.totalVisits).toBe(1);
      expect(after?.lifetimeSpendMinor).toBe(8000 * PKR);
      // Notes are an input, not a derivation — a rebuild must not eat them.
      expect(after?.notes).toBe('allergic to retinol');
    });
  });

  describe('the profile view', () => {
    it('computes tags rather than reading them', async () => {
      const booking = await pastBooking({ startsAt: new Date(Date.now() - 200 * DAY) });
      await setBookingOutcome(String(booking._id), businessId, 'completed');

      const view = await loadProfile(businessId, clientId);

      expect(view?.tags).toContain(CLIENT_TAG.LAPSED);
      // Nothing wrote it: the stored document has no tags field at all.
      expect((await profile())?.toObject()).not.toHaveProperty('tags');
    });

    it('drops the lapsed tag the moment they book again, with no recompute', async () => {
      const old = await pastBooking({ startsAt: new Date(Date.now() - 200 * DAY) });
      await setBookingOutcome(String(old._id), businessId, 'completed');
      expect((await loadProfile(businessId, clientId))?.tags).toContain(CLIENT_TAG.LAPSED);

      await pastBooking({ startsAt: new Date(Date.now() + 3 * DAY) });

      const view = await loadProfile(businessId, clientId);
      expect(view?.tags).not.toContain(CLIENT_TAG.LAPSED);
      expect(view?.hasUpcomingBooking).toBe(true);
    });

    it('returns nothing for a client of another business', async () => {
      await pastBooking();
      expect(await loadProfile(String(new mongoose.Types.ObjectId()), clientId)).toBeNull();
    });
  });
});
