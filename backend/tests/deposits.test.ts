import type { AddressInfo } from 'node:net';
import express from 'express';
import mongoose from 'mongoose';
import { Redis } from 'ioredis';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  BOOKING_STATUS,
  DEPOSIT_PAYMENT_WINDOW_MINUTES,
  DEPOSIT_RECONCILE_GRACE_MINUTES,
  DEPOSIT_STATUS,
  NOTIFICATION_KIND,
  SESSION_STATUS,
  type MessagingProvider,
  type SendResult,
} from '@scalivo/shared';
import { Booking } from '../src/models/Booking.js';
import { Business } from '../src/models/Business.js';
import { Client } from '../src/models/Client.js';
import { Notification } from '../src/models/Notification.js';
import { Service } from '../src/models/Service.js';
import { SlotOccupancy } from '../src/models/SlotOccupancy.js';
import { Staff } from '../src/models/Staff.js';
import { createBooking, holdSlot } from '../src/bookings/create.js';
import { setBookingOutcome } from '../src/bookings/outcome.js';
import { confirmBooking } from '../src/notifications/confirm.js';
import { buildReport } from '../src/analytics/report.js';
import { postgres } from '../src/config/db.js';
import {
  depositView,
  expireOverdueDeposits,
  handleReturn,
  startCheckout,
  transferDeposit,
} from '../src/payments/deposits.js';
import { ensurePaymentSchema } from '../src/payments/ledger.js';
import { usePaymentProvider } from '../src/payments/registry.js';
import { createDepositRouter } from '../src/payments/routes.js';
import { refundBooking } from '../src/payments/settle.js';
import { SimulatedProvider } from '../src/payments/simulated.js';
import { addMinutes, wallClockToUtc } from '../src/lib/time.js';
import { assertOk, infraReady } from './infra.js';

/**
 * Deposits — milestone 2.6, SPEC §12.
 *
 * "No deposit, no booking", and money is never lost. Most tests here are about
 * the second half, because that is where the silent failures are: a payment
 * racing the deadline, a gateway that never reports back, a replayed return,
 * a refund asked for twice. Each of those either confirms something unpaid or
 * keeps money nobody can account for, and neither shows up on a screen.
 *
 * Needs Mongo (replica set — bookings are transactional), Redis (holds) and
 * Postgres (the ledger). Where a host Postgres owns 5432, run with
 * TEST_POSTGRES_URL=postgres://scalivo:scalivo@localhost:5433/scalivo.
 */

const TZ = 'Asia/Karachi';
const DEPOSIT = 200_000;

class FakeMessaging implements MessagingProvider {
  readonly name = 'fake';
  sent: string[] = [];
  async sendText(_to: string, text: string): Promise<SendResult> {
    this.sent.push(text);
    return { providerMessageId: `m${this.sent.length}`, acceptedAt: new Date() };
  }
  async getSessionStatus() {
    return SESSION_STATUS.READY;
  }
}

const infraUp = await infraReady({ replicaSet: true, redis: true, postgres: true });

/** A Tuesday at least four days out, so "24 hours' notice" is comfortably true by default. */
function tuesdayAhead(): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + 4);
  while (d.getUTCDay() !== 2) d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}

describe.skipIf(!infraUp)('deposits', () => {
  let redis: Redis;
  let gateway: SimulatedProvider;
  let messaging: FakeMessaging;
  let businessId: string;
  let serviceId: string;
  let plainServiceId: string;
  let staffId: string;
  let clientId: string;
  let date: string;

  const deps = () => ({ redis, provider: messaging });
  const at = (hhmm: string) => wallClockToUtc(`${date}T${hhmm}`, TZ);

  async function book(hhmm: string, options: { source?: 'whatsapp' | 'web' | 'owner'; service?: string } = {}) {
    const service = options.service ?? serviceId;
    const source = options.source ?? 'whatsapp';
    const held = await holdSlot(redis, { businessId, serviceId: service, startsAt: at(hhmm), staffId, source });
    assertOk(held, 'hold');
    const made = await createBooking(redis, {
      businessId,
      serviceId: service,
      staffId,
      clientId,
      startsAt: at(hhmm),
      holdToken: held.hold.token,
      source,
    });
    assertOk(made, 'booking');
    return (await Booking.findById(made.booking.id))!;
  }

  /** Book, start a checkout, and return the transaction reference. */
  async function checkout(hhmm = '12:00') {
    const booking = await book(hhmm);
    const started = await startCheckout(booking.depositToken!);
    assertOk(started, 'checkout');
    return { booking, txnRef: started.redirect.fields.txnRef! };
  }

  async function pay(txnRef: string, outcome: 'paid' | 'failed' = 'paid') {
    return handleReturn(deps(), gateway.returnBody(txnRef, outcome));
  }

  const payments = async (bookingId: string) =>
    (await postgres.query(`SELECT * FROM payments WHERE booking_id = $1 ORDER BY id`, [bookingId])).rows;
  const refunds = async () =>
    (await postgres.query(`SELECT r.* FROM refunds r JOIN payments p ON p.id = r.payment_id WHERE p.business_id = $1`, [businessId])).rows;

  beforeAll(async () => {
    redis = new Redis(process.env.REDIS_URL!, { db: 3 });
    await ensurePaymentSchema();
    date = tuesdayAhead();
  });

  afterAll(async () => {
    await Promise.all([mongoose.disconnect(), redis.quit(), postgres.end()]);
  });

  beforeEach(async () => {
    gateway = new SimulatedProvider('test-payment-secret', 'http://api.test');
    usePaymentProvider(gateway);
    messaging = new FakeMessaging();

    const business = await Business.findOneAndUpdate(
      { slug: 'deposit-test' },
      {
        slug: 'deposit-test',
        name: 'Deposit Test Clinic',
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
      Notification.deleteMany({ businessId }),
      redis.flushdb(),
      postgres.query(
        `DELETE FROM refunds WHERE payment_id IN (SELECT id FROM payments WHERE business_id = $1)`,
        [businessId],
      ),
    ]);
    await postgres.query(`DELETE FROM payments WHERE business_id = $1`, [businessId]);

    const [withDeposit, plain] = await Service.insertMany([
      { businessId, name: 'Laser', durationMinutes: 45, priceMinor: 1_500_000, depositRequired: true, depositAmountMinor: DEPOSIT, displayOrder: 1 },
      { businessId, name: 'Consultation', durationMinutes: 30, priceMinor: 300_000, displayOrder: 2 },
    ]);
    serviceId = String(withDeposit!._id);
    plainServiceId = String(plain!._id);

    const staff = await Staff.create({
      businessId,
      name: 'Dr Ayesha',
      serviceIds: [serviceId, plainServiceId],
      workingHours: [{ dayOfWeek: 2, opensAt: '10:00', closesAt: '18:00', breaks: [] }],
    });
    staffId = String(staff._id);

    const client = await Client.findOneAndUpdate(
      { phone: '923008880077' },
      { phone: '923008880077', displayName: 'Hina' },
      { upsert: true, new: true },
    );
    clientId = String(client._id);
  });

  describe('booking', () => {
    it('holds the slot unconfirmed until the deposit is paid', async () => {
      const booking = await book('12:00');

      expect(booking.status).toBe(BOOKING_STATUS.AWAITING_DEPOSIT);
      expect(booking.depositMinor).toBe(DEPOSIT);
      expect(booking.depositStatus).toBe(DEPOSIT_STATUS.AWAITING);
      expect(booking.depositToken).toMatch(/^[\w-]{20,}$/);
      const window = booking.depositDueBy!.getTime() - booking.createdAt!.getTime();
      expect(Math.round(window / 60_000)).toBe(DEPOSIT_PAYMENT_WINDOW_MINUTES);
      // The hour is protected while they pay.
      expect(await SlotOccupancy.countDocuments({ bookingId: String(booking._id) })).toBeGreaterThan(0);
    });

    it('asks nothing of a service without a deposit, or of the owner entering a walk-in', async () => {
      expect((await book('10:00', { service: plainServiceId })).status).toBe(BOOKING_STATUS.PENDING);
      const walkIn = await book('14:00', { source: 'owner' });
      expect(walkIn.status).toBe(BOOKING_STATUS.PENDING);
      expect(walkIn.depositMinor).toBeNull();
    });

    it('sends the payment link instead of "you\'re booked"', async () => {
      const booking = await book('12:00');
      const result = await confirmBooking(deps(), businessId, String(booking._id));

      expect(result.ok && result.awaitingDeposit).toBe(true);
      expect((await Booking.findById(booking._id))!.status).toBe(BOOKING_STATUS.AWAITING_DEPOSIT);
      const notes = await Notification.find({ bookingId: String(booking._id) });
      expect(notes.map((n) => n.kind)).toEqual([NOTIFICATION_KIND.DEPOSIT_REQUEST]);
      // Asserted on the stored text: the test business has no live session, so
      // the message is queued rather than handed to the provider.
      expect(notes[0]!.text).toContain(`/pay/${booking.depositToken}`);
      expect(notes[0]!.text).not.toMatch(/you're booked/i);
    });
  });

  describe('paying', () => {
    it('a paid deposit confirms the booking and sends the confirmation', async () => {
      const { booking, txnRef } = await checkout();
      expect(await pay(txnRef)).toBe(booking.depositToken);

      const after = (await Booking.findById(booking._id))!;
      expect(after.status).toBe(BOOKING_STATUS.CONFIRMED);
      expect(after.depositStatus).toBe(DEPOSIT_STATUS.PAID);
      expect(after.depositDueBy).toBeNull();

      const [row] = await payments(String(booking._id));
      expect(row.status).toBe('paid');
      expect(Number(row.amount_minor)).toBe(DEPOSIT);
      const kinds = (await Notification.find({ bookingId: String(booking._id) })).map((n) => n.kind);
      expect(kinds).toContain(NOTIFICATION_KIND.CONFIRMATION);
    });

    it('a replayed return changes nothing the second time', async () => {
      const { booking, txnRef } = await checkout();
      await pay(txnRef);
      await pay(txnRef);

      expect(await payments(String(booking._id))).toHaveLength(1);
      expect(await refunds()).toHaveLength(0);
      expect(await Notification.countDocuments({ bookingId: String(booking._id), kind: NOTIFICATION_KIND.CONFIRMATION })).toBe(1);
    });

    it('ignores a forged "I paid" and keeps it on record', async () => {
      const { booking, txnRef } = await checkout();
      const forged = { txnRef, outcome: 'paid', signature: 'f'.repeat(64) };

      expect(await handleReturn(deps(), forged)).toBeNull();
      expect((await Booking.findById(booking._id))!.status).toBe(BOOKING_STATUS.AWAITING_DEPOSIT);
      const events = await postgres.query(`SELECT 1 FROM payment_events WHERE kind = 'forged_return' AND txn_ref = $1`, [txnRef]);
      expect(events.rowCount).toBe(1);
    });

    it('a declined payment keeps the slot and lets them try again', async () => {
      const { booking, txnRef } = await checkout();
      await pay(txnRef, 'failed');

      expect((await Booking.findById(booking._id))!.status).toBe(BOOKING_STATUS.AWAITING_DEPOSIT);
      const retry = await startCheckout(booking.depositToken!);
      assertOk(retry, 'second checkout');
      await pay(retry.redirect.fields.txnRef!);

      expect((await Booking.findById(booking._id))!.status).toBe(BOOKING_STATUS.CONFIRMED);
      expect((await payments(String(booking._id))).map((p) => p.status)).toEqual(['failed', 'paid']);
    });

    it('a second successful payment for the same booking is refunded, not kept', async () => {
      const booking = await book('12:00');
      const first = await startCheckout(booking.depositToken!);
      const second = await startCheckout(booking.depositToken!);
      assertOk(first, 'first');
      assertOk(second, 'second');

      await pay(first.redirect.fields.txnRef!);
      await pay(second.redirect.fields.txnRef!);

      expect(await refunds()).toHaveLength(1);
      expect(gateway.refunds).toEqual([{ txnRef: second.redirect.fields.txnRef, amountMinor: DEPOSIT }]);
    });
  });

  describe('when nobody pays', () => {
    const overdue = (bookingId: unknown, minutesAgo: number) =>
      Booking.updateOne({ _id: bookingId }, { $set: { depositDueBy: addMinutes(new Date(), -minutesAgo) } });

    it('releases the slot and tells the customer', async () => {
      const booking = await book('12:00');
      await overdue(booking._id, 1);

      expect(await expireOverdueDeposits(deps())).toBe(1);

      const after = (await Booking.findById(booking._id))!;
      expect(after.status).toBe(BOOKING_STATUS.CANCELLED);
      expect(after.depositStatus).toBe(DEPOSIT_STATUS.EXPIRED);
      expect(await SlotOccupancy.countDocuments({ bookingId: String(booking._id) })).toBe(0);
      expect(await Notification.countDocuments({ bookingId: String(booking._id), kind: NOTIFICATION_KIND.DEPOSIT_EXPIRED })).toBe(1);
    });

    it('asks the gateway before giving up, and confirms a payment whose return was lost', async () => {
      const { booking, txnRef } = await checkout();
      gateway.settled.set(txnRef, 'paid'); // paid at the gateway; the browser never came back
      await overdue(booking._id, 1);

      expect(await expireOverdueDeposits(deps())).toBe(0);
      expect((await Booking.findById(booking._id))!.status).toBe(BOOKING_STATUS.CONFIRMED);
    });

    it('holds a booking with a payment in flight through the grace period, then releases it', async () => {
      const { booking } = await checkout(); // gateway knows nothing: 'pending'

      await overdue(booking._id, 1);
      expect(await expireOverdueDeposits(deps())).toBe(0);
      expect((await Booking.findById(booking._id))!.status).toBe(BOOKING_STATUS.AWAITING_DEPOSIT);

      await overdue(booking._id, DEPOSIT_RECONCILE_GRACE_MINUTES + 1);
      expect(await expireOverdueDeposits(deps())).toBe(1);
      expect((await payments(String(booking._id)))[0].status).toBe('expired');
    });

    it('refunds money that arrives after the slot was released', async () => {
      const { booking, txnRef } = await checkout();
      await overdue(booking._id, DEPOSIT_RECONCILE_GRACE_MINUTES + 1);
      await expireOverdueDeposits(deps());

      await pay(txnRef);

      expect((await Booking.findById(booking._id))!.status).toBe(BOOKING_STATUS.CANCELLED);
      expect((await payments(String(booking._id)))[0].status).toBe('paid');
      expect(await refunds()).toHaveLength(1);
      expect((await depositView(booking.depositToken!))!.refunded).toBe(true);
    });

    it('will not start a checkout once the window has closed', async () => {
      const booking = await book('12:00');
      await overdue(booking._id, 1);
      const result = await startCheckout(booking.depositToken!);
      expect(result.ok ? null : result.reason).toBe('not_payable');
    });
  });

  describe('settling a paid deposit', () => {
    async function paidBooking(hhmm = '12:00') {
      const { booking, txnRef } = await checkout(hhmm);
      await pay(txnRef);
      return String(booking._id);
    }

    it('refunds a customer who cancels with a day\'s notice', async () => {
      const id = await paidBooking();
      await setBookingOutcome(id, businessId, BOOKING_STATUS.CANCELLED, { actor: 'customer' });

      expect((await Booking.findById(id))!.depositStatus).toBe(DEPOSIT_STATUS.REFUNDED);
      expect(await refunds()).toHaveLength(1);
    });

    it('keeps it when the customer cancels late — otherwise the deposit deters nothing', async () => {
      const id = await paidBooking();
      await Booking.updateOne({ _id: id }, { $set: { startsAt: addMinutes(new Date(), 120) } });
      await setBookingOutcome(id, businessId, BOOKING_STATUS.CANCELLED, { actor: 'customer' });

      expect((await Booking.findById(id))!.depositStatus).toBe(DEPOSIT_STATUS.RETAINED);
      expect(await refunds()).toHaveLength(0);
    });

    it('always refunds when the business cancels, however late', async () => {
      const id = await paidBooking();
      await Booking.updateOne({ _id: id }, { $set: { startsAt: addMinutes(new Date(), 120) } });
      await setBookingOutcome(id, businessId, BOOKING_STATUS.CANCELLED); // defaults to the business

      expect((await Booking.findById(id))!.depositStatus).toBe(DEPOSIT_STATUS.REFUNDED);
    });

    it('keeps it on a no-show and applies it on completion', async () => {
      const missed = await paidBooking('12:00');
      const kept = await paidBooking('15:00');
      await setBookingOutcome(missed, businessId, BOOKING_STATUS.NO_SHOW);
      await setBookingOutcome(kept, businessId, BOOKING_STATUS.COMPLETED);

      expect((await Booking.findById(missed))!.depositStatus).toBe(DEPOSIT_STATUS.RETAINED);
      expect((await Booking.findById(kept))!.depositStatus).toBe(DEPOSIT_STATUS.APPLIED);
      expect(await refunds()).toHaveLength(0);
    });

    it('never refunds the same payment twice', async () => {
      const id = await paidBooking();
      await Promise.all([refundBooking(id, 'first'), refundBooking(id, 'second')]);
      await refundBooking(id, 'third');

      expect(gateway.refunds).toHaveLength(1);
      expect(await refunds()).toHaveLength(1);
    });

    it('a rescheduled deposit follows the appointment, and is refunded from there', async () => {
      const oldId = await paidBooking('12:00');
      const replacement = await book('15:00', { service: plainServiceId });
      const newId = String(replacement._id);
      await Booking.updateOne({ _id: newId }, { $set: { depositMinor: DEPOSIT, depositStatus: DEPOSIT_STATUS.PAID } });

      await transferDeposit(oldId, newId);
      await setBookingOutcome(oldId, businessId, BOOKING_STATUS.CANCELLED, { actor: 'customer' });
      expect(await refunds()).toHaveLength(0);
      expect((await Booking.findById(oldId))!.depositStatus).toBe(DEPOSIT_STATUS.TRANSFERRED);

      await setBookingOutcome(newId, businessId, BOOKING_STATUS.CANCELLED);
      expect(await refunds()).toHaveLength(1);
      expect(gateway.refunds[0]!.amountMinor).toBe(DEPOSIT);
    });
  });

  it('reports no-shows with and without a deposit separately', async () => {
    const base = { businessId, staffId: 's', clientId, serviceId, durationMinutes: 45, priceMinor: 100, source: 'whatsapp' };
    const when = at('12:00');
    await Booking.insertMany([
      { ...base, startsAt: when, status: BOOKING_STATUS.COMPLETED, depositMinor: DEPOSIT },
      { ...base, startsAt: when, status: BOOKING_STATUS.COMPLETED, depositMinor: DEPOSIT },
      { ...base, startsAt: when, status: BOOKING_STATUS.COMPLETED, depositMinor: DEPOSIT },
      { ...base, startsAt: when, status: BOOKING_STATUS.NO_SHOW, depositMinor: DEPOSIT },
      { ...base, startsAt: when, status: BOOKING_STATUS.COMPLETED },
      { ...base, startsAt: when, status: BOOKING_STATUS.NO_SHOW },
      // Never reached its hour: not in either denominator.
      { ...base, startsAt: when, status: BOOKING_STATUS.CANCELLED, depositMinor: DEPOSIT },
    ]);

    const report = await buildReport({ businessId, timezone: TZ, from: date, to: date, granularity: 'day' });
    expect(report.depositComparison.withDeposit).toEqual({ reached: 4, noShow: 1, rate: 0.25 });
    expect(report.depositComparison.withoutDeposit).toEqual({ reached: 2, noShow: 1, rate: 0.5 });
  });

  describe('over HTTP', () => {
    let serverUrl: string;
    let server: ReturnType<express.Express['listen']>;

    beforeAll(() => {
      const app = express();
      const routers = createDepositRouter({ redis, provider: new FakeMessaging() });
      app.use('/public', routers.publicRouter);
      app.use('/payments', routers.gatewayRouter);
      server = app.listen(0);
      serverUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    });

    afterAll(() => {
      server?.close();
    });

    it('sends the browser back to the payment page after the gateway', async () => {
      const { booking, txnRef } = await checkout();
      const res = await fetch(`${serverUrl}/payments/simulated/return`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams(gateway.returnBody(txnRef, 'paid')),
        redirect: 'manual',
      });

      expect(res.status).toBe(303);
      expect(res.headers.get('location')).toMatch(new RegExp(`/pay/${booking.depositToken}$`));
    });

    it('refuses an unverifiable return and an unknown token', async () => {
      const bad = await fetch(`${serverUrl}/payments/simulated/return`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ txnRef: 'T1', outcome: 'paid', signature: 'nope' }),
      });
      expect(bad.status).toBe(400);
      expect((await fetch(`${serverUrl}/public/deposits/not-a-token`)).status).toBe(404);
    });

    it('shows the amount and deadline, never the booking id', async () => {
      const booking = await book('12:00');
      const res = await fetch(`${serverUrl}/public/deposits/${booking.depositToken}`);
      const view = await res.json();

      expect(view.depositMinor).toBe(DEPOSIT);
      expect(view.status).toBe(DEPOSIT_STATUS.AWAITING);
      expect(view.dueBy).toBeTruthy();
      expect(JSON.stringify(view)).not.toContain(String(booking._id));
    });
  });
});
