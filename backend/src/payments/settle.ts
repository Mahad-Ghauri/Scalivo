import { BOOKING_STATUS, DEPOSIT_REFUND_CUTOFF_HOURS, DEPOSIT_STATUS } from '@scalivo/shared';
import { Booking } from '../models/Booking.js';
import { logger } from '../lib/logger.js';
import {
  claimRefund,
  recordEvent,
  refundablePayments,
  settleRefund,
  type PaymentRow,
} from './ledger.js';
import { paymentProvider } from './registry.js';

/**
 * What happens to a paid deposit when the appointment reaches its end.
 *
 *   completed  → applied   (it counted toward the bill)
 *   no-show    → retained  (the business lost the hour; this is what it is for)
 *   cancelled  → refunded, if the BUSINESS or the system called it off, or the
 *                customer gave at least DEPOSIT_REFUND_CUTOFF_HOURS' notice;
 *                retained otherwise.
 *
 * Who cancelled matters, which is why setBookingOutcome now takes an actor. An
 * owner cancelling because their stylist is ill owes the customer their money
 * whatever the notice; a customer cancelling two hours before does not get it
 * back, or the deposit would deter nothing.
 */

export type OutcomeActor = 'customer' | 'business' | 'system';

export async function settleDeposit(
  booking: { id: string; startsAt: Date; depositStatus?: string | null },
  outcome: 'completed' | 'no_show' | 'cancelled',
  actor: OutcomeActor,
  now = new Date(),
): Promise<void> {
  if (booking.depositStatus !== DEPOSIT_STATUS.PAID) return;

  let next: string;
  if (outcome === BOOKING_STATUS.COMPLETED) next = DEPOSIT_STATUS.APPLIED;
  else if (outcome === BOOKING_STATUS.NO_SHOW) next = DEPOSIT_STATUS.RETAINED;
  else {
    const noticeHours = (booking.startsAt.getTime() - now.getTime()) / 3_600_000;
    const refundable = actor !== 'customer' || noticeHours >= DEPOSIT_REFUND_CUTOFF_HOURS;
    if (refundable) {
      await refundBooking(booking.id, actor === 'customer' ? 'customer cancelled in time' : `cancelled by ${actor}`);
      next = DEPOSIT_STATUS.REFUNDED;
    } else {
      next = DEPOSIT_STATUS.RETAINED;
    }
  }

  // Conditional on PAID: settling twice (a retried outcome) changes nothing.
  await Booking.updateOne(
    { _id: booking.id, depositStatus: DEPOSIT_STATUS.PAID },
    { $set: { depositStatus: next } },
  );
  await recordEvent({ kind: `deposit_${next}`, bookingId: booking.id, detail: { outcome, actor } });
  logger.info({ bookingId: booking.id, outcome, actor, deposit: next }, 'deposit settled');
}

/** Refund every paid, unrefunded payment on a booking. Safe to call twice. */
export async function refundBooking(bookingId: string, reason: string): Promise<number> {
  const payments = await refundablePayments(bookingId);
  for (const payment of payments) await refundPayment(payment, reason);
  return payments.length;
}

/**
 * Claim first, then ask the gateway. The other order is how money goes out
 * twice: two callers both see "not refunded", both call the gateway, and the
 * ledger's UNIQUE only stops the second ROW, not the second transfer.
 */
export async function refundPayment(payment: PaymentRow, reason: string): Promise<void> {
  if (!(await claimRefund(payment, reason))) return;

  const result = await paymentProvider()
    .refund({ txnRef: payment.txn_ref, amountMinor: Number(payment.amount_minor) })
    .catch((err) => {
      logger.error({ err, txnRef: payment.txn_ref }, 'refund request failed');
      return { status: 'failed' as const, providerRef: undefined };
    });

  await settleRefund(payment.id, result.status, result.providerRef ?? null);
  await recordEvent({
    kind: 'refund',
    txnRef: payment.txn_ref,
    bookingId: payment.booking_id,
    detail: { reason, status: result.status },
  });
  logger.info({ txnRef: payment.txn_ref, reason, status: result.status }, 'deposit refunded');
}
