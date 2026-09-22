import { randomInt } from 'node:crypto';
import { DateTime } from 'luxon';
import {
  BOOKING_STATUS,
  DEPOSIT_RECONCILE_GRACE_MINUTES,
  DEPOSIT_STATUS,
  NOTIFICATION_KIND,
  type CheckoutRedirect,
  type DepositStatus,
  type DepositView,
} from '@scalivo/shared';
import { Booking } from '../models/Booking.js';
import { Business } from '../models/Business.js';
import { Service } from '../models/Service.js';
import { Staff } from '../models/Staff.js';
import { env } from '../config/env.js';
import { postgres } from '../config/db.js';
import { addMinutes } from '../lib/time.js';
import { logger } from '../lib/logger.js';
import { setBookingOutcome } from '../bookings/outcome.js';
import { confirmBooking } from '../notifications/confirm.js';
import { sendTracked, type SendDeps } from '../notifications/send.js';
import * as copy from '../whatsapp/messages.js';
import {
  expirePending,
  insertPayment,
  markFailed,
  markPaid,
  moveToBooking,
  pendingPayments,
  recordEvent,
} from './ledger.js';
import type { PaymentReturn } from './provider.js';
import { paymentProvider } from './registry.js';
import { refundPayment } from './settle.js';

/**
 * The deposit loop, end to end — SPEC §12.
 *
 *   booking made ──► AWAITING_DEPOSIT (slot held, link sent)
 *        │                 │
 *        │     paid ◄──────┤ gateway return / inquiry
 *        │       │         │
 *        │   CONFIRMED     └── window closes unpaid ──► CANCELLED, slot freed
 *        │   "you're booked"
 *
 * Two rules hold everything together.
 *
 * **The booking status is the guard.** A payment confirms a booking only via
 * a conditional update on AWAITING_DEPOSIT, and the expiry pass cancels one
 * only under the same condition. Whichever lands first wins, and the loser
 * finds nothing to change — so a payment racing the deadline either confirms
 * the booking or is refunded, and never both confirms AND gets cancelled.
 *
 * **Money that arrives is never dropped.** A late payment, a second payment,
 * or a payment for a booking the owner has since cancelled is still recorded
 * as paid — and then refunded. Ignoring it because the booking has moved on
 * would keep the customer's money with no record of why.
 */

/** 'T' + PKT timestamp + 5 digits: 20 characters, JazzCash's limit for pp_TxnRefNo. */
function newTxnRef(now: Date): string {
  const stamp = DateTime.fromJSDate(now).setZone('Asia/Karachi').toFormat('yyyyMMddHHmmss');
  return `T${stamp}${String(randomInt(0, 100_000)).padStart(5, '0')}`;
}

export async function depositView(token: string): Promise<DepositView | null> {
  const booking = await Booking.findOne({ depositToken: token });
  if (!booking || booking.depositMinor === null || booking.depositMinor === undefined) return null;

  const [business, service, staff, refunds] = await Promise.all([
    Business.findById(booking.businessId).select('name slug timezone'),
    Service.findById(booking.serviceId).select('name'),
    Staff.findById(booking.staffId).select('name'),
    postgres.query(
      `SELECT 1 FROM refunds r JOIN payments p ON p.id = r.payment_id WHERE p.booking_id = $1 LIMIT 1`,
      [String(booking._id)],
    ),
  ]);
  if (!business) return null;

  return {
    businessName: business.name,
    businessSlug: business.slug,
    serviceName: service?.name ?? 'Appointment',
    staffName: staff?.name ?? '',
    startsAt: booking.startsAt.toISOString(),
    timezone: business.timezone,
    depositMinor: booking.depositMinor,
    priceMinor: booking.priceMinor,
    status: (booking.depositStatus ?? DEPOSIT_STATUS.AWAITING) as DepositStatus,
    dueBy: booking.depositDueBy ? booking.depositDueBy.toISOString() : null,
    refunded: (refunds.rowCount ?? 0) > 0,
  };
}

export type CheckoutResult =
  | { ok: true; redirect: CheckoutRedirect }
  | { ok: false; reason: 'not_found' | 'not_payable' };

/**
 * One attempt at paying. Each gets its own ledger row and transaction
 * reference, so a customer who backs out of the wallet page and tries again
 * does not collide with — or silently reuse — the abandoned attempt.
 */
export async function startCheckout(token: string, now = new Date()): Promise<CheckoutResult> {
  const booking = await Booking.findOne({ depositToken: token });
  if (!booking) return { ok: false, reason: 'not_found' };

  if (
    booking.status !== BOOKING_STATUS.AWAITING_DEPOSIT ||
    !booking.depositMinor ||
    !booking.depositDueBy ||
    booking.depositDueBy <= now
  ) {
    return { ok: false, reason: 'not_payable' };
  }

  const provider = paymentProvider();
  const txnRef = newTxnRef(now);
  const bookingId = String(booking._id);

  await insertPayment({
    txnRef,
    provider: provider.name,
    businessId: booking.businessId,
    bookingId,
    clientId: booking.clientId,
    amountMinor: booking.depositMinor,
  });
  await recordEvent({ kind: 'checkout', txnRef, bookingId, detail: { amountMinor: booking.depositMinor } });

  const business = await Business.findById(booking.businessId).select('name');
  return {
    ok: true,
    redirect: provider.checkout({
      txnRef,
      amountMinor: booking.depositMinor,
      description: `Deposit — ${business?.name ?? 'appointment'}`,
      billReference: bookingId.slice(-12),
      // The gateway's own expiry matches ours, so it will not take money for a
      // slot we are about to release.
      expiresAt: booking.depositDueBy,
      returnUrl: `${env.PUBLIC_URL}/payments/${provider.name}/return`,
    }),
  };
}

/**
 * A gateway return, as it arrives through the customer's browser.
 *
 * Returns the booking's payment-page token so the route can send the browser
 * back to it, or null when the return is not authentic or not ours.
 */
export async function handleReturn(
  deps: SendDeps,
  body: Record<string, string>,
): Promise<string | null> {
  const parsed = paymentProvider().parseReturn(body);
  if (!parsed) {
    // Logged in full: a forged "I paid" is worth being able to find later.
    await recordEvent({ kind: 'forged_return', txnRef: body.pp_TxnRefNo ?? body.txnRef ?? null, detail: body });
    logger.warn({ provider: paymentProvider().name }, 'payment return failed verification');
    return null;
  }

  await recordEvent({
    kind: 'return',
    txnRef: parsed.txnRef,
    detail: { outcome: parsed.outcome, code: parsed.code, message: parsed.message },
  });
  const bookingId = await applyPaymentResult(deps, parsed);
  if (!bookingId) return null;

  const booking = await Booking.findById(bookingId).select('depositToken');
  return booking?.depositToken ?? null;
}

/**
 * Act on a verified result. Idempotent: the ledger's conditional update means
 * a replayed return finds nothing to change. Returns the booking id, or null
 * for an unknown transaction.
 */
export async function applyPaymentResult(
  deps: SendDeps,
  result: PaymentReturn,
): Promise<string | null> {
  const { rows } = await postgres.query<{ booking_id: string; amount_minor: string }>(
    `SELECT booking_id, amount_minor FROM payments WHERE txn_ref = $1`,
    [result.txnRef],
  );
  const known = rows[0];
  if (!known) return null;

  if (result.outcome === 'pending') return known.booking_id;
  if (result.outcome === 'failed') {
    // The booking stays AWAITING_DEPOSIT: a declined card is a reason to try
    // again, not to lose the slot.
    await markFailed(result.txnRef);
    return known.booking_id;
  }

  if (result.amountMinor !== null && result.amountMinor !== Number(known.amount_minor)) {
    // Signed, but not what we asked for. Never confirm on it; a person looks.
    await recordEvent({
      kind: 'amount_mismatch',
      txnRef: result.txnRef,
      bookingId: known.booking_id,
      detail: { expected: known.amount_minor, received: result.amountMinor },
    });
    logger.error({ txnRef: result.txnRef }, 'payment amount does not match the deposit');
    return known.booking_id;
  }

  const payment = await markPaid(result.txnRef, result.providerRef);
  if (!payment) return known.booking_id; // already applied — a replay

  const now = new Date();
  const booking = await Booking.findOneAndUpdate(
    { _id: payment.booking_id, status: BOOKING_STATUS.AWAITING_DEPOSIT },
    {
      $set: {
        // PENDING, then confirmBooking takes it to CONFIRMED and sends
        // "you're booked" — the one confirmation path, not a second one.
        status: BOOKING_STATUS.PENDING,
        depositStatus: DEPOSIT_STATUS.PAID,
        depositPaidAt: now,
        depositDueBy: null,
      },
    },
    { new: true },
  );

  if (!booking) {
    // Expired, cancelled, or already paid by an earlier attempt. The money is
    // real either way, so it goes back.
    await refundPayment(payment, 'paid after the booking stopped waiting for it');
    return payment.booking_id;
  }

  await recordEvent({ kind: 'confirmed', txnRef: payment.txn_ref, bookingId: payment.booking_id });
  await confirmBooking(deps, booking.businessId, payment.booking_id).catch((err) =>
    logger.error({ err, bookingId: payment.booking_id }, 'deposit paid but confirmation failed'),
  );
  return payment.booking_id;
}

/**
 * Carry a paid deposit onto the booking a customer rescheduled to.
 *
 * Marked TRANSFERRED before the old booking is cancelled, so the cancellation
 * finds nothing to refund; and the ledger rows move, so a later refund of the
 * NEW booking finds the money it is refunding.
 */
export async function transferDeposit(fromBookingId: string, toBookingId: string): Promise<void> {
  const moved = await Booking.updateOne(
    { _id: fromBookingId, depositStatus: DEPOSIT_STATUS.PAID },
    { $set: { depositStatus: DEPOSIT_STATUS.TRANSFERRED } },
  );
  if (moved.modifiedCount === 0) return;

  await moveToBooking(fromBookingId, toBookingId);
  await recordEvent({ kind: 'transferred', bookingId: fromBookingId, detail: { to: toBookingId } });
}

/**
 * Release slots whose deposit never came.
 *
 * Reconcile first (SPEC §12.4): a booking with a payment still in flight is
 * asked about before it is given up on, and held through a short grace period
 * while the gateway cannot say. Cancelling someone whose money is on its way,
 * and then refunding them, is the outcome this pass exists to avoid.
 */
export async function expireOverdueDeposits(deps: SendDeps, now = new Date()): Promise<number> {
  const overdue = await Booking.find({
    status: BOOKING_STATUS.AWAITING_DEPOSIT,
    depositDueBy: { $lte: now },
  }).limit(200);

  let released = 0;
  for (const booking of overdue) {
    const bookingId = String(booking._id);

    const inFlight = await pendingPayments(bookingId);
    let unresolved = false;
    for (const payment of inFlight) {
      const outcome = await paymentProvider().inquire(payment.txn_ref);
      if (outcome === 'paid' || outcome === 'failed') {
        await applyPaymentResult(deps, {
          txnRef: payment.txn_ref,
          outcome,
          providerRef: null,
          amountMinor: null,
          code: null,
          message: 'reconciled by inquiry',
        });
      } else {
        unresolved = true;
      }
    }

    const graceOver = addMinutes(booking.depositDueBy!, DEPOSIT_RECONCILE_GRACE_MINUTES) <= now;
    if (unresolved && !graceOver) continue;

    const result = await setBookingOutcome(bookingId, booking.businessId, BOOKING_STATUS.CANCELLED, {
      actor: 'system',
      // A payment reconciled a moment ago has moved it on; leave it alone.
      expectStatus: BOOKING_STATUS.AWAITING_DEPOSIT,
    });
    if (!result.ok) continue;

    await Booking.updateOne(
      { _id: bookingId, depositStatus: DEPOSIT_STATUS.AWAITING },
      { $set: { depositStatus: DEPOSIT_STATUS.EXPIRED, depositDueBy: null } },
    );
    await expirePending(bookingId);
    await recordEvent({ kind: 'expired', bookingId });
    released += 1;

    const [business, service] = await Promise.all([
      Business.findById(booking.businessId).select('timezone'),
      Service.findById(booking.serviceId).select('name'),
    ]);
    await sendTracked(deps, {
      businessId: booking.businessId,
      clientId: booking.clientId,
      bookingId,
      kind: NOTIFICATION_KIND.DEPOSIT_EXPIRED,
      dedupeKey: `${bookingId}:deposit_expired`,
      text: copy.depositExpired({
        serviceName: service?.name ?? 'appointment',
        startsAt: booking.startsAt,
        timezone: business?.timezone ?? 'Asia/Karachi',
      }),
      scheduledFor: now,
    }).catch((err) => logger.error({ err, bookingId }, 'could not tell the customer the slot was released'));

    logger.info({ bookingId, businessId: booking.businessId }, 'unpaid deposit expired, slot released');
  }
  return released;
}

/** Every minute: a released slot is only worth anything while it can still be resold. */
export function startDepositExpiryJob(deps: SendDeps): () => void {
  const timer = setInterval(() => {
    expireOverdueDeposits(deps).catch((err) => logger.error({ err }, 'deposit expiry pass failed'));
  }, 60_000);
  timer.unref();
  return () => clearInterval(timer);
}
