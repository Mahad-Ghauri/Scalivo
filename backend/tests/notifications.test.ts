import { CapacityOccupancy } from '../src/models/CapacityOccupancy.js';
import mongoose from 'mongoose';
import { Redis } from 'ioredis';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { MessagingProvider, SendResult } from '@scalivo/shared';
import {
  ACK_STATUS,
  BOOKING_STATUS,
  DELIVERY_STATUS,
  NOTIFICATION_KIND,
  SESSION_STATUS,
} from '@scalivo/shared';
import { Booking } from '../src/models/Booking.js';
import { Business } from '../src/models/Business.js';
import { Client } from '../src/models/Client.js';
import { ClientProfile } from '../src/models/ClientProfile.js';
import { Notification } from '../src/models/Notification.js';
import { Service } from '../src/models/Service.js';
import { SlotOccupancy } from '../src/models/SlotOccupancy.js';
import { Staff } from '../src/models/Staff.js';
import { createBooking, holdSlot } from '../src/bookings/create.js';
import { setBookingOutcome } from '../src/bookings/outcome.js';
import { confirmBooking } from '../src/notifications/confirm.js';
import { handleMessageAck } from '../src/notifications/ack.js';
import { remindBusiness, reminderDueAt, remindersOnce } from '../src/notifications/reminders.js';
import { retryPending } from '../src/notifications/send.js';
import { readPendingPrompt } from '../src/whatsapp/state.js';
import { wallClockToUtc, toBusinessLocal } from '../src/lib/time.js';
import { assertOk, infraReady } from './infra.js';

/**
 * Confirmations and reminders — Phase 1.8.
 *
 * The property under test throughout is **exactly once, and we know whether it
 * arrived**. Both halves are easy to get almost right: a scheduler that sends
 * twice after a restart looks fine in a single-pass test, and a send path that
 * calls `sendText` and logs looks fine until you ask whether WhatsApp actually
 * delivered anything (FINDING #3: it answers 200 either way).
 *
 * So most of these tests run a pass TWICE, or feed an ack out of order, or take
 * the session down mid-flight. A test that only does the happy thing once would
 * pass against an implementation with no idempotency at all.
 *
 * Needs Mongo (replica set, for the booking transaction) and Redis.
 */

const TZ = 'Asia/Karachi';
const SESSION_ID = 'notifications-test-session';
const LID = '1770000000881@lid';

function uniquePhone(prefix: string): string {
  const tail = String(Math.floor(Math.random() * 1_000_000)).padStart(6, '0');
  return `${prefix}${String(Date.now() % 100_000).padStart(5, '0')}${tail}`.slice(0, 15);
}

/** A Tuesday, so a business open every day always has the slot. */
function nextTuesday(): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + ((9 - d.getUTCDay()) % 7 || 7));
  return d.toISOString().slice(0, 10);
}

class FakeProvider implements MessagingProvider {
  readonly name = 'fake';
  sent: { to: string; text: string; id: string }[] = [];
  /** Set to make every send throw, the way a dead session does. */
  down = false;
  private counter = 0;
  /**
   * Globally unique, not `m1`, `m2`.
   *
   * An ack matches on providerMessageId alone — it is WhatsApp's id and carries
   * no tenant — so a counter that restarts at 1 in every test makes the acks
   * here ambiguous the moment any other notification in the database shares an
   * id. That is not hypothetical: one test below drives the real cron, which
   * sends OTHER suites' reminders through this very provider and writes their
   * ids under their own business.
   */
  private readonly prefix = `pm-${Math.random().toString(36).slice(2, 10)}`;

  async sendText(_sessionId: string, to: string, text: string): Promise<SendResult> {
    if (this.down) throw new Error('session is not connected');
    this.counter += 1;
    const id = `${this.prefix}-${this.counter}`;
    this.sent.push({ to, text, id });
    return { providerMessageId: id, acceptedAt: new Date() };
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
    return { sessionId: 'fake-session', status: SESSION_STATUS.READY };
  }
  async registerWebhook() {
    /* notifications never provision */
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

const infraUp = await infraReady({ replicaSet: true, redis: true });

describe.skipIf(!infraUp)('confirmations and reminders', () => {
  let redis: Redis;
  let provider: FakeProvider;
  let deps: { redis: Redis; provider: FakeProvider };
  let businessId: string;
  let clientId: string;
  let staffId: string;
  let hydrafacial: string;
  let date: string;

  /** Clients invented by hand, with no booking to find them by afterwards. */
  const madeClients: string[] = [];

  const at = (hhmm: string, onDate = date) => wallClockToUtc(`${onDate}T${hhmm}`, TZ);

  beforeAll(async () => {
    // db 5 — 1–4 belong to concurrency, conversation, session-health and calendar.
    redis = new Redis(process.env.REDIS_URL!, { db: 5 });
    date = nextTuesday();
    await Promise.all([SlotOccupancy.syncIndexes(), Notification.syncIndexes()]);
  });

  afterAll(async () => {
    await Promise.all([mongoose.disconnect(), redis.quit()]);
  });

  beforeEach(async () => {
    provider = new FakeProvider();
    deps = { redis, provider };

    const business = await Business.findOneAndUpdate(
      { slug: 'notifications-test' },
      {
        slug: 'notifications-test',
        name: 'Reminder Test Salon',
        category: 'salon',
        timezone: TZ,
        slotIncrementMinutes: 15,
        minNoticeMinutes: 60,
        bookingHorizonDays: 30,
        'whatsapp.sessionId': SESSION_ID,
        'reminders.enabled': true,
        'reminders.leadMinutes': [1440],
      },
      { upsert: true, new: true, setDefaultsOnInsert: true },
    );
    businessId = String(business._id);

    // Client is GLOBAL — no businessId — so it is found through the bookings
    // rather than wiped wholesale, which would take other suites' rows with it.
    const previous = await Booking.distinct('clientId', { businessId });
    await Client.deleteMany({ _id: { $in: [...previous, ...madeClients] } });
    madeClients.length = 0;

    await Promise.all([
      SlotOccupancy.deleteMany({ businessId }),
      CapacityOccupancy.deleteMany({ businessId }),
      Booking.deleteMany({ businessId }),
      Notification.deleteMany({ businessId }),
      Service.deleteMany({ businessId }),
      Staff.deleteMany({ businessId }),
      ClientProfile.deleteMany({ businessId }),
      redis.flushdb(),
    ]);

    const service = await Service.create({
      businessId,
      name: 'Hydrafacial',
      durationMinutes: 45,
      priceMinor: 800_000,
    });
    hydrafacial = String(service._id);

    const hours = [0, 1, 2, 3, 4, 5, 6].map((dayOfWeek) => ({
      dayOfWeek,
      opensAt: '09:00',
      closesAt: '18:00',
      breaks: [],
    }));

    const staff = await Staff.create({
      businessId,
      name: 'Ayesha',
      serviceIds: [hydrafacial],
      workingHours: hours,
    });
    staffId = String(staff._id);

    const client = await Client.create({
      phone: uniquePhone('92302'),
      lids: [LID],
      displayName: 'Sana Khan',
    });
    clientId = String(client._id);
    madeClients.push(clientId);
  });

  /** Book the way the API would: hold, then convert. Leaves it PENDING. */
  async function book(startsAt: Date, forClient = clientId) {
    const held = await holdSlot(redis, {
      businessId,
      serviceId: hydrafacial,
      startsAt,
      staffId,
      source: 'web',
    });
    assertOk(held, 'the hold');
    const result = await createBooking(redis, {
      businessId,
      staffId: held.hold.staffId,
      clientId: forClient,
      serviceId: hydrafacial,
      startsAt,
      source: 'web',
      holdToken: held.hold.token,
    });
    assertOk(result, 'the booking');
    return result.booking;
  }

  const rows = (kind?: string) =>
    Notification.find({ businessId, ...(kind ? { kind } : {}) }).sort({ createdAt: 1 });

  /**
   * One reminder tick, for THIS business only.
   *
   * remindersOnce loops every tenant, which is right in production and wrong
   * here: the suites run in parallel against one database, so another suite's
   * bookings come due in the middle of these assertions and surface as sends
   * this test never asked for. One test below drives the global pass on purpose.
   */
  async function tick(now: Date) {
    const business = await Business.findById(businessId);
    await remindBusiness(deps, business!, now);
  }

  /** `now` positioned so a reminder at `lead` minutes before `startsAt` is due. */
  const dueNowForLead = (startsAt: Date, lead: number) =>
    new Date(startsAt.getTime() - lead * 60_000 + 30_000);

  const dueNowFor = (startsAt: Date) => dueNowForLead(startsAt, 1440);

  // ────────────────────────────────────────────────────────────────────────
  describe('confirmations', () => {
    it('marks the booking confirmed and records what was sent', async () => {
      const booking = await book(at('16:00'));
      expect(booking.status).toBe(BOOKING_STATUS.PENDING);

      const result = await confirmBooking(deps, businessId, booking.id);
      assertOk(result, 'the confirmation');
      expect(result.changed).toBe(true);

      // The status change is the point that was missing before this phase: a
      // WhatsApp booking used to stay PENDING forever while the customer was
      // told "you're booked".
      expect((await Booking.findById(booking.id))!.status).toBe(BOOKING_STATUS.CONFIRMED);

      const [row] = await rows(NOTIFICATION_KIND.CONFIRMATION);
      expect(row!.status).toBe(DELIVERY_STATUS.ACCEPTED);
      expect(row!.providerMessageId).toBe(provider.sent[0]!.id);
      expect(row!.text).toContain("You're booked");

      // ACCEPTED, not delivered. Nothing has proved arrival yet (FINDING #3).
      expect(row!.deliveredAt).toBeNull();
    });

    it('sends exactly one confirmation however many times it is asked', async () => {
      const booking = await book(at('16:00'));

      await confirmBooking(deps, businessId, booking.id);
      const second = await confirmBooking(deps, businessId, booking.id);

      assertOk(second, 'the second confirmation');
      // The booking was already confirmed, so nothing moved...
      expect(second.changed).toBe(false);
      // ...and the dedupe claim refused a second message.
      expect(second.delivery).toEqual({ ok: false, reason: 'already_claimed' });
      expect(provider.sent).toHaveLength(1);
      expect(await Notification.countDocuments({ businessId })).toBe(1);
    });

    it('refuses to confirm a cancelled booking, and says nothing to the customer', async () => {
      const booking = await book(at('16:00'));
      await setBookingOutcome(booking.id, businessId, BOOKING_STATUS.CANCELLED);

      const result = await confirmBooking(deps, businessId, booking.id);

      expect(result).toEqual({ ok: false, reason: 'already_terminal' });
      expect(provider.sent).toHaveLength(0);
      // Still cancelled — a late confirmation must not resurrect it.
      expect((await Booking.findById(booking.id))!.status).toBe(BOOKING_STATUS.CANCELLED);
    });

    it('records a walk-in with no phone as skipped rather than failing', async () => {
      const walkIn = await Client.create({ phone: null, displayName: 'Cash customer' });
      madeClients.push(String(walkIn._id));

      const booking = await book(at('16:00'), String(walkIn._id));
      const result = await confirmBooking(deps, businessId, booking.id);

      assertOk(result, 'the confirmation');
      // The booking is still confirmed — being unreachable is not a failure to book.
      expect((await Booking.findById(booking.id))!.status).toBe(BOOKING_STATUS.CONFIRMED);
      expect(provider.sent).toHaveLength(0);

      const [row] = await rows();
      expect(row!.status).toBe(DELIVERY_STATUS.SKIPPED);
      expect(row!.lastError).toBe('no whatsapp address');
    });
  });

  // ────────────────────────────────────────────────────────────────────────
  describe('acks are the only proof of delivery', () => {
    async function confirmed() {
      const booking = await book(at('16:00'));
      await confirmBooking(deps, businessId, booking.id);
      const [row] = await rows();
      return { bookingId: booking.id, row: row!, providerMessageId: row!.providerMessageId! };
    }

    it('moves a notification to delivered when the ack says so', async () => {
      const { row, providerMessageId } = await confirmed();
      const occurredAt = new Date();

      await handleMessageAck({
        providerMessageId,
        sessionId: SESSION_ID,
        status: ACK_STATUS.DELIVERED,
        occurredAt,
      });

      const after = await Notification.findById(row._id);
      expect(after!.status).toBe(DELIVERY_STATUS.DELIVERED);
      expect(after!.deliveredAt?.getTime()).toBe(occurredAt.getTime());
    });

    it('drops a "sent" ack on the floor — it says nothing accepted did not', async () => {
      const { row, providerMessageId } = await confirmed();

      await handleMessageAck({
        providerMessageId,
        sessionId: SESSION_ID,
        status: ACK_STATUS.SENT,
        occurredAt: new Date(),
      });

      expect((await Notification.findById(row._id))!.status).toBe(DELIVERY_STATUS.ACCEPTED);
    });

    it('does not let a late delivered ack undo a read one', async () => {
      const { row, providerMessageId } = await confirmed();
      const arrived = new Date(Date.now() - 60_000);

      // The transport is at-least-once and unordered, so the retry of an EARLIER
      // ack routinely lands after a later one. This is the pair that actually
      // reaches the write — 'sent' and 'pending' are dropped before it, so a
      // test built on those would pass against no guard at all.
      await handleMessageAck({
        providerMessageId,
        sessionId: SESSION_ID,
        status: ACK_STATUS.READ,
        occurredAt: arrived,
      });
      await handleMessageAck({
        providerMessageId,
        sessionId: SESSION_ID,
        status: ACK_STATUS.DELIVERED,
        occurredAt: new Date(),
      });

      const after = await Notification.findById(row._id);
      expect(after!.status).toBe(DELIVERY_STATUS.READ);
      expect(after!.deliveredAt?.getTime()).toBe(arrived.getTime());
    });

    it('keeps the first arrival time when a read ack follows a delivered one', async () => {
      const { row, providerMessageId } = await confirmed();
      const deliveredAt = new Date(Date.now() - 60_000);

      await handleMessageAck({
        providerMessageId,
        sessionId: SESSION_ID,
        status: ACK_STATUS.DELIVERED,
        occurredAt: deliveredAt,
      });
      await handleMessageAck({
        providerMessageId,
        sessionId: SESSION_ID,
        status: ACK_STATUS.READ,
        occurredAt: new Date(),
      });

      const after = await Notification.findById(row._id);
      expect(after!.status).toBe(DELIVERY_STATUS.READ);
      // Read is later news, not a later arrival.
      expect(after!.deliveredAt?.getTime()).toBe(deliveredAt.getTime());
    });

    it('treats a read ack that skips delivered as proof of arrival', async () => {
      const { row, providerMessageId } = await confirmed();
      const occurredAt = new Date();

      // WhatsApp can jump straight to read when the chat is already open.
      await handleMessageAck({
        providerMessageId,
        sessionId: SESSION_ID,
        status: ACK_STATUS.READ,
        occurredAt,
      });

      const after = await Notification.findById(row._id);
      expect(after!.status).toBe(DELIVERY_STATUS.READ);
      expect(after!.deliveredAt?.getTime()).toBe(occurredAt.getTime());
    });

    it('ignores an ack for a message it never tracked', async () => {
      const { row } = await confirmed();

      // Every conversational reply produces acks too, and none of them is tracked.
      await handleMessageAck({
        providerMessageId: 'a-menu-prompt',
        sessionId: SESSION_ID,
        status: ACK_STATUS.DELIVERED,
        occurredAt: new Date(),
      });

      expect((await Notification.findById(row._id))!.status).toBe(DELIVERY_STATUS.ACCEPTED);
    });
  });

  // ────────────────────────────────────────────────────────────────────────
  describe('reminders', () => {
    it('fires once, and stays fired across restarts of the pass', async () => {
      const startsAt = at('16:00');
      const booking = await book(startsAt);
      await confirmBooking(deps, businessId, booking.id);
      provider.sent = [];

      const now = dueNowFor(startsAt);
      await tick(now);
      await tick(now);
      await tick(new Date(now.getTime() + 5 * 60_000));

      expect(provider.sent).toHaveLength(1);
      expect(provider.sent[0]!.text).toContain('Reminder');
      expect(provider.sent[0]!.text).toContain('Hydrafacial');

      const reminders = await rows(NOTIFICATION_KIND.REMINDER);
      expect(reminders).toHaveLength(1);
      expect(reminders[0]!.status).toBe(DELIVERY_STATUS.ACCEPTED);
      expect(reminders[0]!.dedupeKey).toBe(`${booking.id}:reminder:1440`);
    });

    it('asks 1/2/3, arms the reply prompt, and stops asking once confirmed', async () => {
      const startsAt = at('16:00');
      const booking = await book(startsAt);
      await confirmBooking(deps, businessId, booking.id);
      provider.sent = [];

      await tick(dueNowFor(startsAt));
      expect(provider.sent[0]!.text).toContain('Reply 1 to confirm');
      expect(await readPendingPrompt(deps.redis, businessId, booking.clientId)).toEqual({
        kind: 'reminder',
        bookingId: booking.id,
      });

      // A second lead after the customer confirmed: remind, don't re-ask.
      await Booking.updateOne({ _id: booking.id }, { clientConfirmedAt: new Date() });
      await Business.updateOne({ _id: businessId }, { 'reminders.leadMinutes': [1440, 120] });
      provider.sent = [];
      await tick(dueNowForLead(startsAt, 120));
      expect(provider.sent[0]!.text).toContain("You're confirmed");
    });

    it('is reached by the pass over every business, not just by its own', async () => {
      const startsAt = at('16:00');
      const booking = await book(startsAt);
      provider.sent = [];

      // The real cron entry point. Other suites' tenants are live in the same
      // database and may also come due inside this call, so the assertions are
      // on this business's rows rather than on the send count — what is being
      // proved here is that remindersOnce reaches a business at all.
      await remindersOnce(deps, dueNowFor(startsAt));

      const [row] = await rows(NOTIFICATION_KIND.REMINDER);
      expect(row!.dedupeKey).toBe(`${booking.id}:reminder:1440`);
      expect(row!.status).toBe(DELIVERY_STATUS.ACCEPTED);
    });

    it('says nothing before the lead time', async () => {
      const startsAt = at('16:00');
      await book(startsAt);
      provider.sent = [];

      // A minute short of due.
      await tick(new Date(startsAt.getTime() - 1441 * 60_000));

      expect(provider.sent).toHaveLength(0);
      expect(await rows(NOTIFICATION_KIND.REMINDER)).toHaveLength(0);
    });

    it('skips a reminder whose moment passed while we were down', async () => {
      const startsAt = at('16:00');
      const booking = await book(startsAt);
      provider.sent = [];

      // Two hours after the reminder was due — a process that was down over it.
      await tick(new Date(startsAt.getTime() - 1440 * 60_000 + 120 * 60_000));

      expect(provider.sent).toHaveLength(0);

      // Recorded, not forgotten: the claim is what stops the next tick
      // reconsidering it every minute until the appointment.
      const [row] = await rows(NOTIFICATION_KIND.REMINDER);
      expect(row!.status).toBe(DELIVERY_STATUS.SKIPPED);
      expect(row!.dedupeKey).toBe(`${booking.id}:reminder:1440`);
    });

    it('never reminds anyone about an appointment that has already started', async () => {
      // A short lead is where this bites. With a 15-minute lead on an
      // appointment that began ten minutes ago, the send moment was only 25
      // minutes ago — inside the "worth catching up on" window — so nothing but
      // the future-only bound stops a reminder for a haircut in progress.
      await Business.updateOne({ _id: businessId }, { $set: { 'reminders.leadMinutes': [15] } });
      const startsAt = at('16:00');
      await book(startsAt);
      provider.sent = [];

      await tick(new Date(startsAt.getTime() + 10 * 60_000));

      expect(provider.sent).toHaveLength(0);
      expect(await rows(NOTIFICATION_KIND.REMINDER)).toHaveLength(0);
    });

    it('never reminds anyone about an appointment they cancelled', async () => {
      const startsAt = at('16:00');
      const booking = await book(startsAt);
      await setBookingOutcome(booking.id, businessId, BOOKING_STATUS.CANCELLED);
      provider.sent = [];

      await tick(dueNowFor(startsAt));

      expect(provider.sent).toHaveLength(0);
      expect(await rows(NOTIFICATION_KIND.REMINDER)).toHaveLength(0);
    });

    it('fires each configured lead time exactly once', async () => {
      await Business.updateOne(
        { _id: businessId },
        { $set: { 'reminders.leadMinutes': [1440, 120] } },
      );
      const startsAt = at('16:00');
      const booking = await book(startsAt);
      provider.sent = [];

      await tick(dueNowFor(startsAt));
      expect(provider.sent).toHaveLength(1);

      // Two hours out: the second lead comes due, the first is already claimed.
      await tick(new Date(startsAt.getTime() - 119 * 60_000));
      expect(provider.sent).toHaveLength(2);

      const keys = (await rows(NOTIFICATION_KIND.REMINDER)).map((r) => r.dedupeKey).sort();
      expect(keys).toEqual([`${booking.id}:reminder:120`, `${booking.id}:reminder:1440`].sort());
    });

    it('sends nothing when the business has reminders switched off', async () => {
      await Business.updateOne({ _id: businessId }, { $set: { 'reminders.enabled': false } });
      const startsAt = at('16:00');
      await book(startsAt);
      provider.sent = [];

      await tick(dueNowFor(startsAt));

      expect(provider.sent).toHaveLength(0);
      expect(await rows(NOTIFICATION_KIND.REMINDER)).toHaveLength(0);
    });

    describe('waking hours', () => {
      it('leaves a reminder that already lands in the day alone', () => {
        const startsAt = at('16:00');
        const due = reminderDueAt(startsAt, 1440, TZ);
        expect(due.getTime()).toBe(startsAt.getTime() - 1440 * 60_000);
      });

      it('pulls a 5am reminder back to the evening before, never forward', () => {
        // A 7am appointment with a two-hour lead computes to 5am local.
        const startsAt = at('07:00');
        const due = reminderDueAt(startsAt, 120, TZ);

        const local = toBusinessLocal(due, TZ);
        expect(local.hour).toBe(21);
        // Earlier, which is the only direction that cannot overshoot the
        // appointment. 9pm the previous evening.
        expect(due.getTime()).toBeLessThan(startsAt.getTime() - 120 * 60_000);
        expect(local.toISODate()).toBe(
          toBusinessLocal(startsAt, TZ).minus({ days: 1 }).toISODate(),
        );
      });

      it('pulls a late-night reminder back to 9pm the same evening', () => {
        // A 1am appointment is not a thing a salon has, but a 23:30 computed
        // send is — this is the other side of the quiet window.
        const startsAt = at('09:00');
        const due = reminderDueAt(startsAt, 570, TZ); // 09:00 − 9h30 = 23:30 the night before

        const local = toBusinessLocal(due, TZ);
        expect(local.hour).toBe(21);
        expect(local.toISODate()).toBe(
          toBusinessLocal(startsAt, TZ).minus({ days: 1 }).toISODate(),
        );
      });
    });
  });

  // ────────────────────────────────────────────────────────────────────────
  describe('an outage loses nothing', () => {
    it('keeps a confirmation owed when the session is down, and sends it on recovery', async () => {
      const booking = await book(at('16:00'));
      provider.down = true;

      const result = await confirmBooking(deps, businessId, booking.id);

      // The booking is confirmed regardless — the customer said yes, and a dead
      // session is not their problem.
      assertOk(result, 'the confirmation');
      expect((await Booking.findById(booking.id))!.status).toBe(BOOKING_STATUS.CONFIRMED);
      expect(provider.sent).toHaveLength(0);

      const [owed] = await rows();
      expect(owed!.status).toBe(DELIVERY_STATUS.QUEUED);
      expect(owed!.attempts).toBe(1);

      // The session comes back — this is what Session Health calls on `ready`.
      provider.down = false;
      const drained = await retryPending(deps, businessId);

      expect(drained).toEqual({ sent: 1, remaining: 0 });
      expect(provider.sent).toHaveLength(1);
      expect((await Notification.findById(owed!._id))!.status).toBe(DELIVERY_STATUS.ACCEPTED);
    });

    it('does not send a reminder for a booking cancelled during the outage', async () => {
      const startsAt = at('16:00');
      const booking = await book(startsAt);
      provider.down = true;

      await tick(dueNowForLead(startsAt, 1440));
      expect((await rows(NOTIFICATION_KIND.REMINDER))[0]!.status).toBe(DELIVERY_STATUS.QUEUED);

      // The customer rings the salon while the session is dead.
      await setBookingOutcome(booking.id, businessId, BOOKING_STATUS.CANCELLED);

      provider.down = false;
      await retryPending(deps, businessId);

      expect(provider.sent).toHaveLength(0);
      const [row] = await rows(NOTIFICATION_KIND.REMINDER);
      expect(row!.status).toBe(DELIVERY_STATUS.SKIPPED);
      expect(row!.lastError).toContain('cancelled');
    });

    it('stops draining at the first failure rather than burning every attempt', async () => {
      const first = await book(at('16:00'));
      const second = await book(at('11:00'));
      provider.down = true;
      await confirmBooking(deps, businessId, first.id);
      await confirmBooking(deps, businessId, second.id);

      // Still down: one attempt each, and the pass gives up after the first.
      const attempt = await retryPending(deps, businessId);
      expect(attempt).toEqual({ sent: 0, remaining: 2 });

      const attempts = (await rows()).map((r) => r.attempts);
      // The confirm call made one attempt each; the drain made one more on the
      // first row only, then stopped.
      expect(attempts).toEqual([2, 1]);
    });
  });
});
