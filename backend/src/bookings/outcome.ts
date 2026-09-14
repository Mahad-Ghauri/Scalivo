import { BOOKING_STATUS, type BookingStatus } from '@scalivo/shared';
import { Booking } from '../models/Booking.js';
import { SlotOccupancy } from '../models/SlotOccupancy.js';
import { recordOutcome } from '../crm/profile.js';
import { logger } from '../lib/logger.js';

/**
 * Marking an appointment done, missed, or confirmed.
 *
 * The whole file exists for one property: **the counter moves only when the
 * status actually changed.** The status is the guard in the update filter, not
 * a thing checked beforehand — so two owners tapping "Complete" at once, a
 * retried request, and a replayed webhook all produce exactly one increment.
 * Reading the booking, deciding it needs completing, and then incrementing is
 * the same check-then-write race the booking grid was built to avoid, and it
 * has the same fix: let the write be the check.
 */

/** Terminal states an owner can move a booking into, and what each means for the CRM. */
const CRM_EFFECT = {
  [BOOKING_STATUS.COMPLETED]: 'completed',
  [BOOKING_STATUS.NO_SHOW]: 'no_show',
  [BOOKING_STATUS.CANCELLED]: 'cancelled',
} as const;

export type Outcome = keyof typeof CRM_EFFECT;

export type OutcomeResult =
  | { ok: true; changed: boolean }
  | { ok: false; reason: 'not_found' | 'already_terminal' };

/** Once a booking is completed, no-showed or cancelled, it stays there. */
const TERMINAL: BookingStatus[] = [
  BOOKING_STATUS.COMPLETED,
  BOOKING_STATUS.NO_SHOW,
  BOOKING_STATUS.CANCELLED,
];

export async function setBookingOutcome(
  bookingId: string,
  businessId: string,
  outcome: Outcome,
): Promise<OutcomeResult> {
  // The filter carries the guard. A booking already in a terminal state does
  // not match, so nothing is written and nothing is counted.
  const booking = await Booking.findOneAndUpdate(
    { _id: bookingId, businessId, status: { $nin: TERMINAL } },
    { $set: { status: outcome } },
    { new: true },
  );

  if (!booking) {
    // Either it does not exist, or someone got there first. Distinguishing the
    // two costs one read and the app renders them differently: "not found" is
    // an error, "already marked" is just a stale screen.
    const exists = await Booking.exists({ _id: bookingId, businessId });
    return { ok: false, reason: exists ? 'already_terminal' : 'not_found' };
  }

  // A no-show keeps its slot: the time was consumed whether or not anyone
  // turned up, and silently reopening it would let the grid sell an hour the
  // staff member has already spent waiting. Only a cancellation frees time.
  if (outcome === BOOKING_STATUS.CANCELLED) {
    await SlotOccupancy.deleteMany({ bookingId, businessId });
  }

  await recordOutcome(businessId, booking.clientId, CRM_EFFECT[outcome], {
    startsAt: booking.startsAt,
    priceMinor: booking.priceMinor,
    serviceId: booking.serviceId,
    staffId: booking.staffId,
  });

  logger.info({ bookingId, businessId, outcome }, 'booking outcome recorded');
  return { ok: true, changed: true };
}

/**
 * Confirm a pending booking. Not terminal, and not a CRM event — nothing about
 * the customer's history has changed yet.
 */
export async function confirmBooking(bookingId: string, businessId: string): Promise<boolean> {
  const result = await Booking.updateOne(
    { _id: bookingId, businessId, status: BOOKING_STATUS.PENDING },
    { $set: { status: BOOKING_STATUS.CONFIRMED } },
  );
  return result.modifiedCount === 1;
}
