import mongoose from 'mongoose';
import { Redis } from 'ioredis';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ANY_STAFF, BOOKING_STATUS } from '@scalivo/shared';
import { Booking } from '../src/models/Booking.js';
import { Business } from '../src/models/Business.js';
import { Client } from '../src/models/Client.js';
import { Service } from '../src/models/Service.js';
import { SlotOccupancy } from '../src/models/SlotOccupancy.js';
import { Staff } from '../src/models/Staff.js';
import { BlockedTime } from '../src/models/BlockedTime.js';
import { cancelBooking, createBooking, holdSlot } from '../src/bookings/create.js';
import { getAvailability } from '../src/bookings/availability.js';
import { acquireHold } from '../src/bookings/holds.js';
import { wallClockToUtc } from '../src/lib/time.js';
import { assertFailed, assertOk, infraReady } from './infra.js';

/**
 * The tests that justify the whole slot-grid design.
 *
 * These need real infrastructure — a MongoDB REPLICA SET (transactions) and a
 * real Redis (the hold scripts are Lua). A mock cannot prove any of it: the
 * claim under test is that MongoDB's unique index rejects the second writer,
 * and a fake index that we wrote would only prove we can write a fake index.
 *
 * Start them with `docker compose up -d mongo redis` from the repo root. Without
 * them the suite skips rather than fails, so `pnpm test` still runs on a laptop
 * with nothing booted — but a skip here is NOT a pass, and CI must run them.
 */

const TZ = 'Asia/Karachi';

/** A weekday well inside the booking horizon, so notice and horizon never bite. */
function nextTuesday(): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + ((9 - d.getUTCDay()) % 7 || 7));
  return d.toISOString().slice(0, 10);
}


const infraUp = await infraReady({ replicaSet: true, redis: true });


describe.skipIf(!infraUp)('booking concurrency', () => {
  let redis: Redis;
  let businessId: string;
  let clientId: string;
  let staffA: string;
  let staffB: string;
  let hydrafacial: string; // 45 min
  let laser: string; // 20 min
  let date: string;

  const at = (hhmm: string) => wallClockToUtc(`${date}T${hhmm}`, TZ);

  beforeAll(async () => {
    // Its OWN Redis database — see the same note in conversation.test.ts. Both
    // suites flushdb(), and vitest runs files in parallel.
    redis = new Redis(process.env.REDIS_URL!, { db: 1 });
    date = nextTuesday();

    // The unique index IS the guard. createIndex is a no-op when an index of the
    // same name exists with different options, so sync rather than create —
    // otherwise a stale non-unique index would let every test here pass falsely.
    await SlotOccupancy.syncIndexes();
  });

  afterAll(async () => {
    await Promise.all([mongoose.disconnect(), redis.quit()]);
  });

  beforeEach(async () => {
    const business = await Business.findOneAndUpdate(
      { slug: 'concurrency-test' },
      {
        slug: 'concurrency-test',
        name: 'Concurrency Test Clinic',
        category: 'clinic',
        timezone: TZ,
        slotIncrementMinutes: 15,
        minNoticeMinutes: 60,
        bookingHorizonDays: 30,
      },
      { upsert: true, new: true, setDefaultsOnInsert: true },
    );
    businessId = String(business._id);

    await Promise.all([
      SlotOccupancy.deleteMany({ businessId }),
      Booking.deleteMany({ businessId }),
      Service.deleteMany({ businessId }),
      Staff.deleteMany({ businessId }),
      BlockedTime.deleteMany({ businessId }),
      redis.flushdb(),
    ]);

    const [a, b] = await Service.insertMany([
      { businessId, name: 'Hydrafacial', durationMinutes: 45, priceMinor: 800_000 },
      { businessId, name: 'Laser', durationMinutes: 20, priceMinor: 500_000 },
    ]);
    hydrafacial = String(a!._id);
    laser = String(b!._id);

    const hours = [0, 1, 2, 3, 4, 5, 6].map((dayOfWeek) => ({
      dayOfWeek,
      opensAt: '09:00',
      closesAt: '18:00',
      breaks: [{ startsAt: '13:00', endsAt: '14:00' }],
    }));

    const [sa, sb] = await Staff.insertMany([
      { businessId, name: 'Dr. Ayesha', serviceIds: [hydrafacial, laser], workingHours: hours },
      { businessId, name: 'Dr. Sana', serviceIds: [hydrafacial, laser], workingHours: hours },
    ]);
    staffA = String(sa!._id);
    staffB = String(sb!._id);

    // Random tail, not just the clock. Client is global and this suite never
    // deletes its rows, so a time-only value collides with its own leftovers
    // every time `Date.now() % 10_000_000` wraps — and with any other suite that
    // happens to build a fixture phone in the same millisecond.
    const unique = `${Date.now() % 100_000}${Math.floor(Math.random() * 1_000_000)}`;
    const client = await Client.create({ phone: `92300${unique}`, displayName: 'Test Client' });
    clientId = String(client._id);
  });

  /** Book directly, bypassing the hold dance the API would do. */
  async function book(staffId: string, serviceId: string, startsAt: Date, source = 'web' as const) {
    const held = await holdSlot(redis, { businessId, serviceId, startsAt, staffId, source });
    if (!held.ok) return { ok: false as const, reason: held.reason };
    return createBooking(redis, {
      businessId,
      staffId: held.hold.staffId,
      clientId,
      serviceId,
      startsAt,
      source,
      holdToken: held.hold.token,
    });
  }

  it('lets exactly one of two identical-slot bookings win', async () => {
    const startsAt = at('16:00');

    // Both hold-then-book at once. The hold layer may already separate them —
    // that is fine and expected — but the assertion is about the outcome, and
    // the transaction is what makes it true even if both got that far.
    const [first, second] = await Promise.all([
      book(staffA, hydrafacial, startsAt),
      book(staffA, hydrafacial, startsAt),
    ]);

    const winners = [first, second].filter((r) => r.ok);
    expect(winners).toHaveLength(1);

    const loser = [first, second].find((r) => !r.ok)!;
    assertFailed(loser, 'the losing booking');
    expect(['slot_taken', 'outside_hours']).toContain(loser.reason);

    expect(await Booking.countDocuments({ businessId, startsAt })).toBe(1);
  });

  /**
   * THE test. A 45-min at 16:00 and a 20-min at 16:15 have DIFFERENT startsAt,
   * so the unique index the planning docs specified —
   * {businessId, staffId, startsAt} — would accept both and produce a double
   * booking nothing ever detected. The grid catches it on the 16:15 row.
   */
  it('rejects an overlapping booking of a different duration and start time', async () => {
    const long = await book(staffA, hydrafacial, at('16:00')); // 16:00–16:45
    expect(long.ok).toBe(true);

    const overlapping = await book(staffA, laser, at('16:15')); // 16:15–16:35
    expect(overlapping.ok).toBe(false);

    expect(await Booking.countDocuments({ businessId, staffId: staffA })).toBe(1);
  });

  /**
   * The tests above route through holdSlot, which checks occupancy before
   * spending a hold — so they can pass on the pre-check alone and never reach
   * the transaction. That would leave the actual arbiter unproven.
   *
   * These two reach it deliberately. Both start from a VALID hold, so
   * verifyHold passes and createBooking runs straight into the write.
   */
  describe('the transaction, reached directly', () => {
    /** Same token, twice, at once — both pass every check before the write. */
    it('lets exactly one of two concurrent writers commit', async () => {
      const startsAt = at('16:00');
      const held = await holdSlot(redis, {
        businessId,
        serviceId: hydrafacial,
        startsAt,
        staffId: staffA,
        source: 'web',
      });
      assertOk(held, 'the hold');
      const holdToken = held.hold.token;

      const request = {
        businessId,
        staffId: staffA,
        clientId,
        serviceId: hydrafacial,
        startsAt,
        source: 'web' as const,
        holdToken,
      };

      const [first, second] = await Promise.all([
        createBooking(redis, request),
        createBooking(redis, request),
      ]);

      expect([first, second].filter((r) => r.ok)).toHaveLength(1);

      const loser = [first, second].find((r) => !r.ok)!;
      assertFailed(loser, 'the second writer');
      expect(loser.reason).toBe('slot_taken');

      expect(await Booking.countDocuments({ businessId })).toBe(1);
      // 45 min on a 15-min grid: exactly three rows, not six.
      expect(await SlotOccupancy.countDocuments({ businessId })).toBe(3);
    });

    /**
     * The overlapping-duration case with the hold pre-check taken out of the
     * picture. Flushing Redis lets the second booking hold a span that is
     * already occupied — so the ONLY thing that can reject it is the unique
     * index inside the transaction. This is the case the planning docs'
     * {businessId, staffId, startsAt} index would have accepted.
     */
    it('rejects an overlapping duration on the unique index alone', async () => {
      expect((await book(staffA, hydrafacial, at('16:00'))).ok).toBe(true); // 16:00–16:45

      await redis.flushdb();

      const held = await holdSlot(redis, {
        businessId,
        serviceId: laser,
        startsAt: at('16:15'),
        staffId: staffA,
        source: 'web',
      });
      // holdSlot still refuses on its occupancy pre-check, so take the hold the
      // way a caller with a stale offer would: straight against Redis.
      const token = held.ok
        ? held.hold.token
        : (await acquireHold(redis, businessId, staffA, [at('16:15'), at('16:30')], 60))!.token;

      const result = await createBooking(redis, {
        businessId,
        staffId: staffA,
        clientId,
        serviceId: laser,
        startsAt: at('16:15'),
        source: 'web',
        holdToken: token,
      });

      assertFailed(result, 'the overlapping booking');
      expect(result.reason).toBe('slot_taken');
      expect(await Booking.countDocuments({ businessId })).toBe(1);
      expect(await SlotOccupancy.countDocuments({ businessId })).toBe(3);

      // And it hands the customer somewhere to go instead of a dead end.
      if (result.reason !== 'slot_taken') throw new Error('narrowed above');
      expect(result.alternatives.length).toBeGreaterThan(0);
    });
  });

  it('allows the same overlapping time for a different staff member', async () => {
    expect((await book(staffA, hydrafacial, at('16:00'))).ok).toBe(true);
    expect((await book(staffB, laser, at('16:15'))).ok).toBe(true);
    expect(await Booking.countDocuments({ businessId })).toBe(2);
  });

  it('leaves no partial occupancy behind when a booking loses', async () => {
    await book(staffA, hydrafacial, at('16:00')); // claims 16:00, 16:15, 16:30

    const before = await SlotOccupancy.countDocuments({ businessId, staffId: staffA });
    const loser = await book(staffA, hydrafacial, at('16:30')); // would claim 16:30–17:15
    expect(loser.ok).toBe(false);

    // The transaction rolled back, so the 16:45 and 17:00 rows the loser would
    // have written are gone too. A non-transactional insertMany would have left
    // them and blocked a 16:45 booking that should still be free.
    expect(await SlotOccupancy.countDocuments({ businessId, staffId: staffA })).toBe(before);
    expect((await book(staffA, laser, at('16:45'))).ok).toBe(true);
  });

  it('frees the grid when a booking is cancelled', async () => {
    const created = await book(staffA, hydrafacial, at('16:00'));
    assertOk(created, 'the booking');

    // `.id`, not `._id` — the shared Booking contract names it id, and
    // createBooking maps the Mongoose document onto that contract.
    const bookingId = created.booking.id;
    expect(await cancelBooking(bookingId, businessId)).toBe(true);

    expect(await SlotOccupancy.countDocuments({ bookingId })).toBe(0);
    expect((await book(staffA, hydrafacial, at('16:00'))).ok).toBe(true);

    const cancelled = await Booking.findById(bookingId);
    expect(cancelled?.status).toBe(BOOKING_STATUS.CANCELLED);
  });

  it('refuses a booking whose hold has expired', async () => {
    const startsAt = at('16:00');
    const held = await holdSlot(redis, {
      businessId,
      serviceId: hydrafacial,
      startsAt,
      staffId: staffA,
      source: 'web',
    });
    assertOk(held, 'the hold');

    await redis.flushdb(); // the hold's TTL, fast-forwarded

    const result = await createBooking(redis, {
      businessId,
      staffId: staffA,
      clientId,
      serviceId: hydrafacial,
      startsAt,
      source: 'web',
      holdToken: held.hold.token,
    });

    expect(result).toMatchObject({ ok: false, reason: 'hold_expired' });
    expect(await Booking.countDocuments({ businessId })).toBe(0);
  });

  it('resolves ANY_STAFF to a real person and never holds "anyone"', async () => {
    const held = await holdSlot(redis, {
      businessId,
      serviceId: hydrafacial,
      startsAt: at('16:00'),
      staffId: ANY_STAFF,
      source: 'whatsapp',
    });

    assertOk(held, 'the any-staff hold');
    expect([staffA, staffB]).toContain(held.hold.staffId);
  });

  describe('availability', () => {
    it('hides every increment a booking spans, not just its start', async () => {
      await book(staffA, hydrafacial, at('16:00')); // 16:00–16:45

      const slots = await getAvailability(redis, {
        businessId,
        serviceId: laser,
        date,
        staffId: staffA,
      });
      const times = slots.map((s) => s.startsAt.getTime());

      expect(times).not.toContain(at('16:00').getTime());
      expect(times).not.toContain(at('16:15').getTime());
      expect(times).not.toContain(at('16:30').getTime());
      expect(times).toContain(at('16:45').getTime());
    });

    it('will not offer a service that would straddle the lunch break', async () => {
      const slots = await getAvailability(redis, {
        businessId,
        serviceId: hydrafacial,
        date,
        staffId: staffA,
      });
      const times = slots.map((s) => s.startsAt.getTime());

      // 12:30 + 45 min runs to 13:15, into the 13:00 break.
      expect(times).not.toContain(at('12:30').getTime());
      expect(times).toContain(at('12:15').getTime()); // ends exactly at 13:00
      expect(times).toContain(at('14:00').getTime());
    });

    it('will not offer a service that would run past closing', async () => {
      const slots = await getAvailability(redis, {
        businessId,
        serviceId: hydrafacial,
        date,
        staffId: staffA,
      });
      const times = slots.map((s) => s.startsAt.getTime());

      expect(times).toContain(at('17:15').getTime()); // ends 18:00
      expect(times).not.toContain(at('17:30').getTime()); // would end 18:15
    });

    it('subtracts blocked time even though it writes no occupancy rows', async () => {
      await BlockedTime.create({
        businessId,
        staffId: staffA,
        startsAt: at('15:00'),
        endsAt: at('17:00'),
        reason: 'Training',
      });

      const slots = await getAvailability(redis, {
        businessId,
        serviceId: laser,
        date,
        staffId: staffA,
      });
      const times = slots.map((s) => s.startsAt.getTime());

      expect(times).not.toContain(at('15:30').getTime());
      expect(times).toContain(at('17:00').getTime());

      // And the booking path must refuse it independently — availability is an
      // offer, not a gate, and the FSM can call createBooking with anything.
      expect((await book(staffA, laser, at('15:30'))).ok).toBe(false);
    });

    it('hides a held slot from everyone else', async () => {
      const startsAt = at('16:00');
      await holdSlot(redis, {
        businessId,
        serviceId: hydrafacial,
        startsAt,
        staffId: staffA,
        source: 'whatsapp',
      });

      const slots = await getAvailability(redis, {
        businessId,
        serviceId: hydrafacial,
        date,
        staffId: staffA,
      });
      expect(slots.map((s) => s.startsAt.getTime())).not.toContain(startsAt.getTime());
    });

    it('honours the buffer by holding the grid past the appointment', async () => {
      await Service.updateOne({ _id: laser }, { $set: { bufferMinutes: 15 } });

      await book(staffA, laser, at('16:00')); // 20 min service + 15 buffer = 16:00–16:35

      // occupiedSlots rounds up: 35 minutes on a 15-min grid is 16:00, 16:15, 16:30.
      expect(await SlotOccupancy.countDocuments({ businessId, staffId: staffA })).toBe(3);

      const slots = await getAvailability(redis, {
        businessId,
        serviceId: laser,
        date,
        staffId: staffA,
      });
      const times = slots.map((s) => s.startsAt.getTime());
      expect(times).not.toContain(at('16:30').getTime());
      expect(times).toContain(at('16:45').getTime());
    });
  });
});
