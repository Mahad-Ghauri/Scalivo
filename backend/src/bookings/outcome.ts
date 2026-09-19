import mongoose from 'mongoose';
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
  // The status flip and the freed slot commit together: a cancelled booking
  // whose occupancy survived would keep the hour unsellable forever.
  const session = await mongoose.startSession();
  // Assigned inside the callback, which TypeScript cannot follow — hence the box.
  const written: { booking: InstanceType<typeof Booking> | null } = { booking: null };

  try {
    await session.withTransaction(async () => {
      written.booking = await Booking.findOneAndUpdate(
        { _id: bookingId, businessId, status: { $nin: TERMINAL } },
        { $set: { status: outcome } },
        { new: true, session },
      );

      // A no-show keeps its slot: the time was consumed whether or not anyone
      // turned up. Only a cancellation frees time.
      if (written.booking && outcome === BOOKING_STATUS.CANCELLED) {
        await SlotOccupancy.deleteMany({ bookingId, businessId }, { session });
      }
    });
  } finally {
    await session.endSession();
  }

  const booking = written.booking;

  if (!booking) {
    // Either it does not exist, or someone got there first. Distinguishing the
    // two costs one read and the app renders them differently: "not found" is
    // an error, "already marked" is just a stale screen.
    const exists = await Booking.exists({ _id: bookingId, businessId });
    return { ok: false, reason: exists ? 'already_terminal' : 'not_found' };
  }

  // The profile is a CACHE of what this booking already records, so a failure
  // here must not fail an outcome that has already been written and acted on —
  // the slot is freed, the owner has moved on, and throwing now would report a
  // completed action as broken. Drift is repairable with recomputeProfile();
  // a false failure is not.
  await recordOutcome(businessId, booking.clientId, CRM_EFFECT[outcome], {
    startsAt: booking.startsAt,
    priceMinor: booking.priceMinor,
    serviceId: booking.serviceId,
    staffId: booking.staffId,
  }).catch((err) => logger.error({ err, businessId, bookingId }, 'could not update the client profile'));

  logger.info({ bookingId, businessId, outcome }, 'booking outcome recorded');
  return { ok: true, changed: true };
}

/**
 * Confirming lives in notifications/confirm.ts, not here.
 *
 * It used to be a sibling of setBookingOutcome — a bare PENDING → CONFIRMED
 * update that told nobody — and that was half a job. A confirmation the customer
 * never receives is not a confirmation, so the status change and the message are
 * one operation now. See the note at the top of that file.
 */
