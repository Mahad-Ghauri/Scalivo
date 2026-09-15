import mongoose from 'mongoose';
import { Redis } from 'ioredis';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  BOOKING_STATUS,
  type MessagingProvider,
  SESSION_STATUS,
  type SendResult,
} from '@scalivo/shared';
import { BlockedTime } from '../src/models/BlockedTime.js';
import { Booking } from '../src/models/Booking.js';
import { Business } from '../src/models/Business.js';
import { Client } from '../src/models/Client.js';
import { ClientProfile } from '../src/models/ClientProfile.js';
import { Service } from '../src/models/Service.js';
import { SlotOccupancy } from '../src/models/SlotOccupancy.js';
import { Staff } from '../src/models/Staff.js';
import { cancelBooking, createBooking, holdSlot } from '../src/bookings/create.js';
import { setBookingOutcome } from '../src/bookings/outcome.js';
import { withinRoster } from '../src/bookings/availability.js';
import { getCalendar } from '../src/calendar/view.js';
import { rescheduleBooking } from '../src/calendar/reschedule.js';
import { createWalkIn } from '../src/calendar/walkin.js';
import { normalisePhone } from '../src/lib/phone.js';
import { wallClockToUtc } from '../src/lib/time.js';
import { assertFailed, assertOk, infraReady } from './infra.js';

/**
 * Phase 1.7 — the owner's calendar.
 *
 * The pure block runs anywhere. The rest needs a MongoDB REPLICA SET, because
 * the claim under test in the reschedule section is about what a transaction
 * does when a booking collides with ITSELF, and a mock of a transaction would
 * only prove that the mock agrees with me.
 *
 * `docker compose up -d mongo redis` from the repo root. A skip here is not a
 * pass; CI must run them.
 */

const TZ = 'Asia/Karachi';

/**
 * This suite's own LID, deliberately NOT the one conversation.test.ts uses.
 *
 * `Client` is global — it carries no businessId — and that suite cleans up with
 * `deleteMany({ lids: LID })`. Sharing the constant meant both files created and
 * deleted the same row, and vitest runs files in parallel: each suite passed
 * alone and they failed each other together.
 */
const LID = '1770000000777@lid';

/**
 * A fixture phone number that cannot collide.
 *
 * `Date.now() % 10_000_000` is not enough on its own: two suites running in
 * parallel hit the same millisecond, and the value wraps every ~2.8 hours, so a
 * run can also collide with leftovers from an earlier one. The random tail
 * removes both. The prefix keeps this suite out of concurrency.test.ts's 92300
 * range entirely.
 */
function uniquePhone(prefix: string): string {
  const tail = String(Math.floor(Math.random() * 1_000_000)).padStart(6, '0');
  return `${prefix}${String(Date.now() % 100_000).padStart(5, '0')}${tail}`.slice(0, 15);
}

function nextTuesday(): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + ((9 - d.getUTCDay()) % 7 || 7));
  return d.toISOString().slice(0, 10);
}

function addDays(isoDate: string, days: number): string {
  return new Date(Date.parse(`${isoDate}T00:00:00Z`) + days * 86_400_000)
    .toISOString()
    .slice(0, 10);
}


/* ------------------------------------------------------------------ *
 * Pure — no database, no Redis.
 * ------------------------------------------------------------------ */

describe('normalising an owner-typed phone number', () => {
  /**
   * THE case. WhatsApp reports 923209263011; the owner reads 0320 926 3011 off
   * a card. Store the second verbatim and the regular standing at the desk gets
   * a brand-new client row, a second CRM profile, and a visit history split in
   * half — with no error anywhere to say it happened.
   */
  it('turns the Pakistani national form into the form WhatsApp uses', () => {
    expect(normalisePhone('0320 926 3011')).toBe('923209263011');
    expect(normalisePhone('0320-926-3011')).toBe('923209263011');
    expect(normalisePhone('03209263011')).toBe('923209263011');
  });

  it('handles the trunk zero already dropped', () => {
    expect(normalisePhone('3209263011')).toBe('923209263011');
  });

  it('leaves an international number alone apart from its punctuation', () => {
    expect(normalisePhone('+92 320 926 3011')).toBe('923209263011');
    expect(normalisePhone('923209263011')).toBe('923209263011');
    expect(normalisePhone('+44 7700 900123')).toBe('447700900123');
  });

  it('refuses anything too short to be a number rather than storing a stub', () => {
    expect(normalisePhone('123')).toBeNull();
    expect(normalisePhone('')).toBeNull();
    expect(normalisePhone('n/a')).toBeNull();
  });
});

describe('working-hours arithmetic', () => {
  const ctx = {
    timezone: TZ,
    incrementMinutes: 15,
    minNoticeMinutes: 60,
    bookingHorizonDays: 30,
    durationMinutes: 45,
    bufferMinutes: 0,
    spanMinutes: 45,
    priceMinor: 800_000,
  };

  // 2026-09-15 is a Tuesday. Luxon weekday 2, so dayOfWeek 2 in our 0=Sunday form.
  const roster = [
    { dayOfWeek: 2, opensAt: '09:00', closesAt: '18:00', breaks: [{ startsAt: '13:00', endsAt: '14:00' }] },
  ];
  const at = (hhmm: string) => wallClockToUtc(`2026-09-15T${hhmm}`, TZ);
  const span = (hhmm: string) => ({ start: at(hhmm), end: new Date(at(hhmm).getTime() + 45 * 60_000) });

  it('accepts an appointment inside the roster', () => {
    expect(withinRoster(roster, span('10:00'), ctx)).toBe(true);
  });

  it('refuses one that would straddle the break', () => {
    expect(withinRoster(roster, span('12:30'), ctx)).toBe(false); // runs to 13:15
    expect(withinRoster(roster, span('12:15'), ctx)).toBe(true); // ends exactly at 13:00
  });

  it('refuses one that would run past closing', () => {
    expect(withinRoster(roster, span('17:30'), ctx)).toBe(false); // would end 18:15
    expect(withinRoster(roster, span('17:15'), ctx)).toBe(true);
  });

  it('refuses a day with no roster entry at all', () => {
    const sunday = wallClockToUtc('2026-09-13T10:00', TZ);
    expect(withinRoster(roster, { start: sunday, end: new Date(sunday.getTime() + 45 * 60_000) }, ctx)).toBe(
      false,
    );
  });
});

/* ------------------------------------------------------------------ *
 * Infrastructure-backed.
 * ------------------------------------------------------------------ */


const infraUp = await infraReady({ replicaSet: true, redis: true });

/** Records what the customer was told, and never touches a network. */
class FakeProvider implements MessagingProvider {
  readonly name = 'fake';
  sent: { to: string; text: string }[] = [];
  /** Set to make every send throw, the way a dead session does. */
  down = false;

  async sendText(_sessionId: string, to: string, text: string): Promise<SendResult> {
    if (this.down) throw new Error('session is not connected');
    this.sent.push({ to, text });
    return { providerMessageId: `m${this.sent.length}`, acceptedAt: new Date() };
  }
  async getSessionStatus() {
    return SESSION_STATUS.READY;
  }
  async startSession() {
    return { status: SESSION_STATUS.READY };
  }
  async provisionSession() {
    return { sessionId: 'fake-session', status: SESSION_STATUS.READY };
  }
  async registerWebhook() {
    /* the calendar never provisions */
  }
  async getSessionPhone() {
    return '923001234567';
  }
  async resolveContactPhone() {
    return null;
  }
  parseWebhook() {
    return [];
  }
}

describe.skipIf(!infraUp)('the calendar', () => {
  let redis: Redis;
  let provider: FakeProvider;
  let businessId: string;
  let clientId: string;
  let staffA: string;
  let staffB: string;
  let hydrafacial: string; // 45 min
  let laser: string; // 20 min
  let date: string;

  /**
   * Clients this suite invented by hand.
   *
   * Client is GLOBAL — it carries no businessId — so a blanket deleteMany here
   * would wipe rows another suite is using, and leaving them behind collides on
   * the unique phone index the next run. Walk-in clients are found via their
   * bookings instead; these are the ones with no booking to find them by.
   */
  const madeClients: string[] = [];

  const at = (hhmm: string, onDate = date) => wallClockToUtc(`${onDate}T${hhmm}`, TZ);

  beforeAll(async () => {
    // Its own Redis database: vitest runs files in parallel and every suite
    // flushdb()s. dbs 1–3 are taken by concurrency, conversation and session-health.
    redis = new Redis(process.env.REDIS_URL!, { db: 4 });
    date = nextTuesday();
    await SlotOccupancy.syncIndexes();
  });

  afterAll(async () => {
    await Promise.all([mongoose.disconnect(), redis.quit()]);
  });

  beforeEach(async () => {
    provider = new FakeProvider();

    const business = await Business.findOneAndUpdate(
      { slug: 'calendar-test' },
      {
        slug: 'calendar-test',
        name: 'Calendar Test Clinic',
        category: 'clinic',
        timezone: TZ,
        slotIncrementMinutes: 15,
        minNoticeMinutes: 60,
        bookingHorizonDays: 30,
        'whatsapp.sessionId': 'calendar-test-session',
      },
      { upsert: true, new: true, setDefaultsOnInsert: true },
    );
    businessId = String(business._id);

    // Collected BEFORE the bookings are deleted — they are the only link back to
    // the clients this suite created, walk-ins included.
    const previous = await Booking.distinct('clientId', { businessId });
    await Client.deleteMany({ _id: { $in: [...previous, ...madeClients] } });
    madeClients.length = 0;

    await Promise.all([
      SlotOccupancy.deleteMany({ businessId }),
      Booking.deleteMany({ businessId }),
      Service.deleteMany({ businessId }),
      Staff.deleteMany({ businessId }),
      BlockedTime.deleteMany({ businessId }),
      ClientProfile.deleteMany({ businessId }),
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

    const client = await Client.create({
      phone: uniquePhone('92301'),
      lids: [LID],
      displayName: 'Sana Khan',
    });
    clientId = String(client._id);
  });

  /** Book the way the API would: hold, then convert. */
  async function book(staffId: string, serviceId: string, startsAt: Date) {
    const held = await holdSlot(redis, {
      businessId,
      serviceId,
      startsAt,
      staffId,
      source: 'web',
    });
    assertOk(held, 'the hold');
    const result = await createBooking(redis, {
      businessId,
      staffId: held.hold.staffId,
      clientId,
      serviceId,
      startsAt,
      source: 'web',
      holdToken: held.hold.token,
    });
    assertOk(result, 'the booking');
    return result.booking;
  }

  const move = (bookingId: string, startsAt: Date, extra: Record<string, unknown> = {}) =>
    rescheduleBooking(
      { redis, provider },
      { businessId, bookingId, startsAt, ...extra },
    );

  describe('reading the diary', () => {
    it('resolves names so one screen is not forty round trips', async () => {
      await book(staffA, hydrafacial, at('16:00'));

      const view = await getCalendar({ businessId, from: date, to: date });
      const entry = view!.days[0]!.entries[0]!;

      expect(entry.serviceName).toBe('Hydrafacial');
      expect(entry.staffName).toBe('Dr. Ayesha');
      expect(entry.clientName).toBe('Sana Khan');
      // The SERVICE end, not the buffered end — drawing the turnaround as busy
      // would tell the owner the room is occupied when it is being tidied.
      expect(entry.endsAt.getTime()).toBe(at('16:45').getTime());
    });

    /**
     * A Karachi day starts at 19:00 UTC the day before. Splitting on UTC
     * midnight puts everything before 05:00 local on the previous page — and it
     * looks right, because most appointments are in the afternoon.
     */
    it('buckets by the business-local day, not the UTC day', async () => {
      // 23:00 local on `date` is 18:00 UTC on the SAME calendar date, so a naive
      // UTC bucketing would agree. 02:00 local the next morning is 21:00 UTC on
      // `date` — that is the one that moves.
      const early = at('02:00', addDays(date, 1));
      const walkIn = await createWalkIn(redis, {
        businessId,
        serviceId: laser,
        staffId: staffA,
        startsAt: early,
        name: 'Night Owl',
      });
      assertOk(walkIn, 'the 2am walk-in');

      const view = await getCalendar({
        businessId,
        from: date,
        to: addDays(date, 1),
      });

      expect(view!.days[0]!.entries).toHaveLength(0);
      expect(view!.days[1]!.entries.map((e) => e.id)).toContain(walkIn.booking.id);
      expect(view!.days[1]!.date).toBe(addDays(date, 1));
    });

    /**
     * The appointment that starts before the range and finishes inside it. A
     * query filtered on startsAt alone drops it from the view while the grid
     * still holds the time — the owner sees a free hour nobody can book, and
     * nothing on screen explains why.
     */
    it('includes an appointment that began before the range and runs into it', async () => {
      const tomorrow = addDays(date, 1);
      // 23:45 local, 45 minutes long: finishes at 00:30 the next morning.
      const spillover = await createWalkIn(redis, {
        businessId,
        serviceId: hydrafacial,
        staffId: staffA,
        startsAt: at('23:45'),
        name: 'Late Finish',
      });
      assertOk(spillover, 'the late walk-in');

      const view = await getCalendar({ businessId, from: tomorrow, to: tomorrow });

      expect(view!.days[0]!.entries.map((e) => e.id)).toContain(spillover.booking.id);
    });

    it('emits empty days rather than skipping them', async () => {
      const view = await getCalendar({ businessId, from: date, to: addDays(date, 6) });

      expect(view!.days).toHaveLength(7);
      expect(view!.days.map((d) => d.date)).toEqual(
        Array.from({ length: 7 }, (_, i) => addDays(date, i)),
      );
    });

    it('hides a cancelled appointment, because its time is free again', async () => {
      const booking = await book(staffA, hydrafacial, at('16:00'));
      await setBookingOutcome(booking.id, businessId, BOOKING_STATUS.CANCELLED);

      const hidden = await getCalendar({ businessId, from: date, to: date });
      expect(hidden!.days[0]!.entries).toHaveLength(0);

      const shown = await getCalendar({ businessId, from: date, to: date, includeCancelled: true });
      expect(shown!.days[0]!.entries).toHaveLength(1);
    });

    it('still shows a no-show, because its time was consumed', async () => {
      const booking = await book(staffA, hydrafacial, at('16:00'));
      await setBookingOutcome(booking.id, businessId, BOOKING_STATUS.NO_SHOW);

      const view = await getCalendar({ businessId, from: date, to: date });
      expect(view!.days[0]!.entries).toHaveLength(1);
    });

    it('lists every active staff member so an empty column still renders', async () => {
      const view = await getCalendar({ businessId, from: date, to: date });
      expect(view!.staff.map((s) => s.id).sort()).toEqual([staffA, staffB].sort());
    });
  });

  describe('cancelling', () => {
    /**
     * The two halves of the ordering fix, tested where they ARE observable.
     *
     * The bug was that cancellation freed the grid before flipping the status,
     * leaving a window in which the booking was still CONFIRMED with its hour
     * free — a reschedule landing inside it claimed the new time and committed,
     * and the cancellation's status write then landed on top, leaving a
     * cancelled appointment holding an hour nobody was coming to.
     *
     * **That interleaving is not deterministically testable from here.** The two
     * cancel writes are adjacent with one await between them, so in a single
     * process a concurrent reschedule never lands between them; a racing test
     * passes under both orderings and proves nothing. Hitting it would need a
     * delay hook in production code, which is a worse trade than this pair of
     * tests plus the structural fix — cancellation now has ONE implementation,
     * so the two orderings cannot drift apart again.
     *
     * What these two do pin down is the property the fix depends on: the status
     * is authoritative first, and freeing by bookingId is correct afterwards
     * whichever operation got there first.
     */
    it('refuses to move a booking once it has been cancelled', async () => {
      const booking = await book(staffA, hydrafacial, at('16:00'));
      expect(await cancelBooking(booking.id, businessId)).toBe(true);

      const result = await move(booking.id, at('10:00'));
      assertFailed(result, 'moving a cancelled booking');
      expect(result.reason).toBe('already_terminal');

      // And the hour it used to hold is genuinely free again.
      expect(await SlotOccupancy.countDocuments({ bookingId: booking.id })).toBe(0);
      await expect(book(staffA, hydrafacial, at('16:00'))).resolves.toBeTruthy();
    });

    it('frees the NEW slot when a booking is cancelled after being moved', async () => {
      const booking = await book(staffA, hydrafacial, at('16:00'));
      assertOk(await move(booking.id, at('10:00')), 'the move');

      expect(await cancelBooking(booking.id, businessId)).toBe(true);

      // Freeing by bookingId rather than by remembered time is what makes this
      // work: the rows it deletes are wherever the booking ended up.
      expect(await SlotOccupancy.countDocuments({ bookingId: booking.id })).toBe(0);
      await expect(book(staffA, hydrafacial, at('10:00'))).resolves.toBeTruthy();
    });

    it('reports an already-cancelled booking as already terminal, not as missing', async () => {
      const booking = await book(staffA, hydrafacial, at('16:00'));

      expect(await cancelBooking(booking.id, businessId)).toBe(true);
      // Still true — a repeat cancel is a stale screen, not an error. But the
      // richer call can tell the app which of the two it was.
      expect(await cancelBooking(booking.id, businessId)).toBe(true);

      const repeat = await setBookingOutcome(booking.id, businessId, BOOKING_STATUS.CANCELLED);
      assertFailed(repeat, 'the repeat cancel');
      expect(repeat.reason).toBe('already_terminal');
    });

    it('counts a double cancellation once against the client record', async () => {
      const booking = await book(staffA, hydrafacial, at('16:00'));

      await Promise.all([
        cancelBooking(booking.id, businessId),
        cancelBooking(booking.id, businessId),
      ]);

      const profile = await ClientProfile.findOne({ businessId, clientId });
      expect(profile!.cancellations).toBe(1);
    });
  });

  describe('rescheduling', () => {
    /**
     * THE test of this phase.
     *
     * A 45-minute booking at 16:00 owns 16:00, 16:15 and 16:30. Moving it to
     * 16:15 asks for 16:15, 16:30 and 16:45 — two of which it is already sitting
     * on. Claim before release and the unique index rejects the booking for
     * overlapping itself, and the owner is told a slot they already own is
     * taken. The delete comes first, inside the transaction.
     */
    it('moves an appointment onto a time it already partly occupies', async () => {
      const booking = await book(staffA, hydrafacial, at('16:00'));

      const moved = await move(booking.id, at('16:15'));
      assertOk(moved, 'the overlapping move');

      expect(moved.booking.startsAt.getTime()).toBe(at('16:15').getTime());

      const rows = await SlotOccupancy.find({ businessId, bookingId: booking.id }).sort({
        slotStart: 1,
      });
      expect(rows.map((r) => r.slotStart.getTime())).toEqual([
        at('16:15').getTime(),
        at('16:30').getTime(),
        at('16:45').getTime(),
      ]);
    });

    it('frees the time it left behind', async () => {
      const booking = await book(staffA, hydrafacial, at('16:00'));
      assertOk(await move(booking.id, at('10:00')), 'the move');

      // 16:00 is bookable again, which it would not be if the old rows survived.
      await expect(book(staffA, hydrafacial, at('16:00'))).resolves.toBeTruthy();
      expect(await SlotOccupancy.countDocuments({ businessId, staffId: staffA })).toBe(6);
    });

    /**
     * Losing the race must change NOTHING. A reschedule that frees the old time
     * and then fails to claim the new one leaves an appointment with no
     * occupancy at all — and the grid will resell the hour it is sitting in.
     */
    it('leaves the original booking untouched when the new slot is taken', async () => {
      const mine = await book(staffA, hydrafacial, at('16:00'));
      await book(staffA, laser, at('11:00'));

      const result = await move(mine.id, at('11:00'));
      assertFailed(result, 'the move onto a taken slot');
      expect(result.reason).toBe('slot_taken');

      const unchanged = await Booking.findById(mine.id);
      expect(unchanged!.startsAt.getTime()).toBe(at('16:00').getTime());

      const rows = await SlotOccupancy.find({ businessId, bookingId: mine.id }).sort({
        slotStart: 1,
      });
      expect(rows.map((r) => r.slotStart.getTime())).toEqual([
        at('16:00').getTime(),
        at('16:15').getTime(),
        at('16:30').getTime(),
      ]);
    });

    it('moves an appointment to a different staff member', async () => {
      const booking = await book(staffA, hydrafacial, at('16:00'));

      const moved = await move(booking.id, at('16:00'), { staffId: staffB });
      assertOk(moved, 'the staff move');

      expect(moved.booking.staffId).toBe(staffB);
      expect(await SlotOccupancy.countDocuments({ businessId, staffId: staffA })).toBe(0);
      expect(await SlotOccupancy.countDocuments({ businessId, staffId: staffB })).toBe(3);
    });

    it('refuses to move a booking that has already been completed', async () => {
      const booking = await book(staffA, hydrafacial, at('16:00'));
      await setBookingOutcome(booking.id, businessId, BOOKING_STATUS.COMPLETED);

      const result = await move(booking.id, at('10:00'));
      assertFailed(result, 'moving a completed booking');
      expect(result.reason).toBe('already_terminal');
    });

    /** Saying so, rather than succeeding, is what stops a pointless message. */
    it('reports a no-op move rather than announcing it to the customer', async () => {
      const booking = await book(staffA, hydrafacial, at('16:00'));

      const result = await move(booking.id, at('16:00'));
      assertFailed(result, 'the no-op move');
      expect(result.reason).toBe('unchanged');
      expect(provider.sent).toHaveLength(0);
    });

    it('keeps the appointment its original length when the service has since been edited', async () => {
      const booking = await book(staffA, hydrafacial, at('16:00')); // 45 min
      await Service.updateOne({ _id: hydrafacial }, { $set: { durationMinutes: 90 } });

      const moved = await move(booking.id, at('10:00'));
      assertOk(moved, 'the move after a service edit');

      // Still 45 minutes, still three grid rows. Re-deriving from the service
      // would silently resize an appointment the customer was already told about.
      expect(moved.booking.durationMinutes).toBe(45);
      expect(await SlotOccupancy.countDocuments({ businessId, bookingId: booking.id })).toBe(3);
    });

    describe('the owner override', () => {
      it('refuses a time outside working hours without it', async () => {
        const booking = await book(staffA, hydrafacial, at('16:00'));

        const result = await move(booking.id, at('19:00')); // after an 18:00 close
        assertFailed(result, 'the after-hours move');
        expect(result.reason).toBe('outside_hours');
      });

      it('allows it with the override, because the owner may work late', async () => {
        const booking = await book(staffA, hydrafacial, at('16:00'));

        const moved = await move(booking.id, at('19:00'), { override: true });
        assertOk(moved, 'the overridden after-hours move');
        expect(moved.booking.startsAt.getTime()).toBe(at('19:00').getTime());
      });

      /**
       * The negative control on the override's scope. Blocked time is the
       * owner's own explicit statement that they are not there; an override that
       * walked through it would make the feature pointless. If they change their
       * mind, they delete the block.
       */
      it('never walks through blocked time, even with the override', async () => {
        const booking = await book(staffA, hydrafacial, at('16:00'));
        await BlockedTime.create({
          businessId,
          staffId: staffA,
          startsAt: at('10:00'),
          endsAt: at('12:00'),
          reason: 'Training',
        });

        const result = await move(booking.id, at('10:30'), { override: true });
        assertFailed(result, 'the move into blocked time');
        expect(result.reason).toBe('outside_hours');
      });

      /** The grid is correctness, not policy. Nothing overrides it. */
      it('never double-books with the override', async () => {
        const mine = await book(staffA, hydrafacial, at('16:00'));
        await book(staffA, laser, at('11:00'));

        const result = await move(mine.id, at('11:00'), { override: true });
        assertFailed(result, 'the overridden double-book');
        expect(result.reason).toBe('slot_taken');
      });
    });

    describe('telling the customer', () => {
      it('messages them with the new time in the business timezone', async () => {
        const booking = await book(staffA, hydrafacial, at('16:00'));

        const moved = await move(booking.id, at('10:00'));
        assertOk(moved, 'the move');

        expect(moved.notified).toBe(true);
        expect(provider.sent).toHaveLength(1);
        // Addressed to the LID, the only identifier every message carries.
        expect(provider.sent[0]!.to).toBe(LID);
        // formatLocal's default is the format customers already see in
        // confirmations — 'Tue 15 Sep, 10:00 AM'. Asserting the whole rendered
        // time rather than the hour alone is what makes this a timezone test:
        // the same instant is 05:00 in UTC, and a server-local format would
        // print that instead.
        expect(provider.sent[0]!.text).toContain('10:00 AM');
        expect(provider.sent[0]!.text).toContain('Hydrafacial');
      });

      /**
       * The booking has moved either way. Reporting the send failure separately
       * is what lets the owner know to pick up the phone, instead of assuming it
       * was handled.
       */
      it('still moves the booking when the session is down, and queues the message', async () => {
        const booking = await book(staffA, hydrafacial, at('16:00'));
        provider.down = true;

        const moved = await move(booking.id, at('10:00'));
        assertOk(moved, 'the move during an outage');

        expect(moved.notified).toBe(false);
        expect(moved.booking.startsAt.getTime()).toBe(at('10:00').getTime());
        expect(await redis.llen(`outbox:${businessId}`)).toBe(1);
      });
    });
  });

  describe('walk-ins', () => {
    it('books on the same path, writing occupancy rows the grid can see', async () => {
      const result = await createWalkIn(redis, {
        businessId,
        serviceId: hydrafacial,
        staffId: staffA,
        startsAt: at('16:00'),
        name: 'Walk In',
      });
      assertOk(result, 'the walk-in');

      expect(result.booking.source).toBe('owner');
      // Straight to confirmed: there is nobody left to hear from.
      expect(result.booking.status).toBe(BOOKING_STATUS.CONFIRMED);

      // THE point of routing through createBooking. Without these rows WhatsApp
      // would cheerfully sell the same hour to somebody else.
      expect(await SlotOccupancy.countDocuments({ businessId, bookingId: result.booking.id })).toBe(3);

      const stored = await Booking.findById(result.booking.id);
      expect(stored!.status).toBe(BOOKING_STATUS.CONFIRMED);
    });

    /**
     * THE walk-in test. The owner types the number off a card in national form;
     * WhatsApp reported it in international form months ago. If these do not
     * collapse to one client, the regular in front of them looks like a stranger
     * and their visit history silently splits in two.
     */
    it('matches an existing customer whose number the owner typed differently', async () => {
      // Built as a round trip rather than hand-converted: `national` is what the
      // owner reads off a card, `international` is what WhatsApp reported months
      // ago. Generated per run so a leftover row from a previous run cannot
      // collide on the unique phone index — Client is global, so this suite's
      // cleanup is scoped to the clients it made.
      const national = `0333${uniquePhone('').slice(0, 7)}`;
      const international = `92${national.slice(1)}`;

      const known = await Client.create({ phone: international, displayName: 'Ayesha Malik' });
      madeClients.push(String(known._id));

      const result = await createWalkIn(redis, {
        businessId,
        serviceId: laser,
        staffId: staffA,
        startsAt: at('16:00'),
        phone: national.replace(/(\d{4})(\d{3})(\d{4})/, '$1 $2 $3'),
      });
      assertOk(result, 'the walk-in');

      expect(result.clientId).toBe(String(known._id));
      // One row, not two. Two would mean the regular at the desk looks like a
      // stranger and their history has silently split.
      expect(await Client.countDocuments({ phone: international })).toBe(1);
    });

    it('creates a phone-less client for someone who will not give a number', async () => {
      const first = await createWalkIn(redis, {
        businessId,
        serviceId: laser,
        staffId: staffA,
        startsAt: at('16:00'),
        name: 'No Number',
      });
      assertOk(first, 'the first phone-less walk-in');

      const second = await createWalkIn(redis, {
        businessId,
        serviceId: laser,
        staffId: staffA,
        startsAt: at('17:00'),
        name: 'Also No Number',
      });
      // Two phone-less clients coexisting is what the PARTIAL unique index buys.
      // A sparse index would have rejected the second one.
      assertOk(second, 'the second phone-less walk-in');
      expect(second.clientId).not.toBe(first.clientId);
    });

    it('refuses a walk-in with neither a name nor a number', async () => {
      const result = await createWalkIn(redis, {
        businessId,
        serviceId: laser,
        staffId: staffA,
        startsAt: at('16:00'),
      });
      assertFailed(result, 'the anonymous walk-in');
      expect(result.reason).toBe('no_client');
    });

    /**
     * The notice period exists to stop customers ambushing the diary. A walk-in
     * is a person standing at the desk; refusing to book them because it is less
     * than an hour away is the system arguing with reality.
     */
    it('books someone who is standing there now, despite the notice period', async () => {
      const business = await Business.findById(businessId);
      const now = at('16:00');

      const result = await createWalkIn(redis, {
        businessId,
        serviceId: laser,
        staffId: staffA,
        startsAt: at('16:00'),
        name: 'Right Now',
        // 60 minutes' notice is configured; this is zero.
        now: new Date(now.getTime() - 60_000),
      });
      assertOk(result, 'the immediate walk-in');
      expect(business!.minNoticeMinutes).toBe(60);
    });

    it('refuses to double-book even for the owner', async () => {
      await book(staffA, hydrafacial, at('16:00'));

      const result = await createWalkIn(redis, {
        businessId,
        serviceId: laser,
        staffId: staffA,
        startsAt: at('16:15'),
        name: 'Too Late',
      });
      assertFailed(result, 'the overlapping walk-in');
      expect(result.reason).toBe('slot_taken');
    });

    it('feeds the CRM like any other booking', async () => {
      const result = await createWalkIn(redis, {
        businessId,
        serviceId: hydrafacial,
        staffId: staffA,
        startsAt: at('16:00'),
        name: 'New Face',
      });
      assertOk(result, 'the walk-in');

      const profile = await ClientProfile.findOne({ businessId, clientId: result.clientId });
      expect(profile).not.toBeNull();
      expect(profile!.lastBookingAt).not.toBeNull();
    });
  });
});
