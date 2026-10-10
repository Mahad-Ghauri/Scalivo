import mongoose from 'mongoose';
import { BOOKING_STATUS } from '@scalivo/shared';
import { Booking } from '../models/Booking.js';
import { Review } from '../models/Review.js';
import { BookingAudit } from '../models/BookingAudit.js';
import { CapacityOccupancy } from '../models/CapacityOccupancy.js';
import { SlotOccupancy } from '../models/SlotOccupancy.js';
import { recomputeProfile } from '../crm/profile.js';
import type { Outcome } from './outcome.js';

const terminal = [BOOKING_STATUS.COMPLETED, BOOKING_STATUS.NO_SHOW, BOOKING_STATUS.CANCELLED];

/** Corrections do not replay messages, review prompts or additive CRM counters. */
export async function correctBookingOutcome(input: {
  businessId: string;
  bookingId: string;
  actorId: string;
  outcome: Outcome;
  revision: number;
  reason: string;
}): Promise<boolean> {
  const session = await mongoose.startSession();
  try {
    let corrected = false;
    await session.withTransaction(
      async () => {
        corrected = false;
        const booking = await Booking.findOne({
          _id: input.bookingId,
          businessId: input.businessId,
          status: { $in: terminal, $ne: input.outcome },
          revision: input.revision,
        })
          .session(session)
          .maxTimeMS(5000);
        if (!booking) return;
        // Correcting a future cancellation to an outcome would fabricate attendance.
        const eligibleAt =
          booking.startsAt.getTime() +
          (input.outcome === BOOKING_STATUS.COMPLETED ? booking.durationMinutes : 10) * 60000;
        if (input.outcome !== BOOKING_STATUS.CANCELLED && eligibleAt > Date.now()) return;
        const before = booking.status!;
        booking.status = input.outcome;
        booking.completedAt =
          input.outcome === BOOKING_STATUS.COMPLETED ? (booking.completedAt ?? new Date()) : null;
        booking.revision++;
        await booking.save({ session });
        if (input.outcome === BOOKING_STATUS.CANCELLED) {
          await SlotOccupancy.deleteMany(
            { businessId: input.businessId, bookingId: input.bookingId },
            { session },
          );
          await CapacityOccupancy.deleteMany(
            { businessId: input.businessId, bookingId: input.bookingId },
            { session },
          );
        }
        await BookingAudit.create(
          [
            {
              businessId: input.businessId,
              bookingId: input.bookingId,
              actorId: input.actorId,
              reason: input.reason,
              before,
              after: input.outcome,
              revision: booking.revision,
            },
          ],
          { session },
        );
        if (input.outcome !== BOOKING_STATUS.COMPLETED)
          await Review.updateMany(
            { businessId: input.businessId, bookingId: input.bookingId },
            { $set: { published: false } },
            { session, maxTimeMS: 5000 },
          );
        await recomputeProfile(input.businessId, booking.clientId, session);
        corrected = true;
      },
      { maxCommitTimeMS: 5000 },
    );
    return corrected;
  } finally {
    await session.endSession();
  }
}
