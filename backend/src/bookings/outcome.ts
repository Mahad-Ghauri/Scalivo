import mongoose from 'mongoose';
import { BOOKING_STATUS, type BookingStatus } from '@scalivo/shared';
import { Booking } from '../models/Booking.js';
import { SlotOccupancy } from '../models/SlotOccupancy.js';
import { CapacityOccupancy } from '../models/CapacityOccupancy.js';
import { BookingAudit } from '../models/BookingAudit.js';
import { recordOutcome } from '../crm/profile.js';
import { logger } from '../lib/logger.js';
import { settleDeposit, type OutcomeActor } from '../payments/settle.js';

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
  { ok: true; changed: boolean } | { ok: false; reason: 'not_found' | 'already_terminal' };

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
  options: {
    /**
     * Who made it happen. Only deposits care: a business cancelling always
     * refunds, a customer cancelling late does not. Defaults to the business,
     * because every owner-facing route is one.
     */
    actor?: OutcomeActor;
    /**
     * Apply only if the booking is still in this status. The deposit expiry
     * pass uses it so that a payment landing a millisecond earlier — flipping
     * the booking out of AWAITING_DEPOSIT — wins, instead of being cancelled
     * and refunded by a pass that read the list before the money arrived.
     */
    expectStatus?: BookingStatus;
    audit?: { actorId: string; reason: string };
    expectRevision?: number;
    futureOnly?: boolean;
    approvalDueBefore?: Date;
  } = {},
): Promise<OutcomeResult> {
  // The status flip and the freed slot commit together: a cancelled booking
  // whose occupancy survived would keep the hour unsellable forever.
  const session = await mongoose.startSession();
  // Assigned inside the callback, which TypeScript cannot follow — hence the box.
  const written: { booking: InstanceType<typeof Booking> | null } = { booking: null };

  try {
    await session.withTransaction(
      async () => {
        const prior = options.audit
          ? await Booking.findOne({ _id: bookingId, businessId }).session(session)
          : null;
        written.booking = await Booking.findOneAndUpdate(
          {
            _id: bookingId,
            businessId,
            status: options.expectStatus ?? { $nin: TERMINAL },
            ...(options.expectRevision !== undefined ? { revision: options.expectRevision } : {}),
            ...(options.approvalDueBefore
              ? { approvalExpiresAt: { $lte: options.approvalDueBefore } }
              : {}),
            ...(options.futureOnly ? { startsAt: { $gt: new Date() } } : {}),
          },
          {
            $set: {
              status: outcome,
              // Stamped in the same write as the status, by the same guarded
              // filter — so the review request that keys on it inherits the
              // exactly-once property for free. Set here rather than in the
              // review pass because this is the only moment we know it happened.
              ...(outcome === BOOKING_STATUS.COMPLETED ? { completedAt: new Date() } : {}),
            },
            $inc: { revision: 1 },
          },
          { new: true, session },
        );
        if (written.booking && prior && options.audit)
          await BookingAudit.create(
            [
              {
                businessId,
                bookingId,
                actorId: options.audit.actorId,
                reason: options.audit.reason,
                before: prior.status,
                after: outcome,
                revision: written.booking.revision,
              },
            ],
            { session },
          );

        if (written.booking)
          await recordOutcome(
            businessId,
            written.booking.clientId,
            CRM_EFFECT[outcome],
            {
              startsAt: written.booking.startsAt,
              priceMinor: written.booking.priceMinor,
              serviceId: written.booking.serviceId,
              staffId: written.booking.staffId,
            },
            session,
          );

        // A no-show keeps its slot: the time was consumed whether or not anyone
        // turned up. Only a cancellation frees time.
        if (written.booking && outcome === BOOKING_STATUS.CANCELLED) {
          await SlotOccupancy.deleteMany({ bookingId, businessId }, { session });
          await CapacityOccupancy.deleteMany({ bookingId, businessId }, { session });
        }
      },
      { maxCommitTimeMS: 5000 },
    );
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

  // Money last, and outside the transaction for the same reason as the CRM: a
  // gateway that is slow or down must not un-cancel an appointment. A deposit
  // left PAID on a cancelled booking is visible in the ledger and re-settleable.
  await settleDeposit(
    { id: bookingId, startsAt: booking.startsAt, depositStatus: booking.depositStatus ?? null },
    CRM_EFFECT[outcome],
    options.actor ?? 'business',
  ).catch((err) => logger.error({ err, businessId, bookingId }, 'could not settle the deposit'));

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
