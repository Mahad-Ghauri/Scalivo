import mongoose from 'mongoose';
import {
  BOOKING_STATUS,
  type BookingStatus,
  type RescheduleResult,
} from '@scalivo/shared';
import { Booking } from '../models/Booking.js';
import { SlotOccupancy } from '../models/SlotOccupancy.js';
import { Service } from '../models/Service.js';
import { isBlocked, loadContext, qualifiedStaff, slotsFor, windowCheck, withinRoster } from '../bookings/availability.js';
import { toBooking } from '../bookings/create.js';
import { alignToGrid, addMinutes, formatLocal } from '../lib/time.js';
import { logger } from '../lib/logger.js';
import { notifyClient, type NotifyDeps } from './notify.js';
import { Business } from '../models/Business.js';
import { isDuplicateKey } from '../lib/mongo.js';

/**
 * Moving an appointment.
 *
 * This is the only operation in the system that must free time and claim time at
 * once, and getting the order wrong breaks it in a way that looks like a bug in
 * the grid rather than a bug here.
 *
 * **The self-collision.** A 45-minute booking at 16:00 owns the grid points
 * 16:00, 16:15 and 16:30. Move it fifteen minutes later and it wants 16:15,
 * 16:30 and 16:45 — two of which it is already sitting on. Claim the new rows
 * before releasing the old ones and the unique index rejects the booking for
 * overlapping ITSELF, and the owner is told a slot they already own is taken.
 * So the delete comes first, inside the transaction.
 *
 * **Why that is still safe.** The delete is invisible outside the transaction
 * until it commits, so no concurrent booking can slip into the window it opens:
 * a second writer claiming 16:00 conflicts and one of the two aborts. And if the
 * insert fails, the rollback puts the original rows back — the appointment stays
 * exactly where it was rather than being left with no occupancy at all, which is
 * the failure that would quietly double-sell the original hour.
 *
 * Everything else is the booking path's discipline repeated, for the same
 * reason: this request arrives over HTTP from a calendar drawn some time ago.
 */

const TERMINAL: BookingStatus[] = [
  BOOKING_STATUS.COMPLETED,
  BOOKING_STATUS.NO_SHOW,
  BOOKING_STATUS.CANCELLED,
];

export interface RescheduleRequest {
  businessId: string;
  bookingId: string;
  startsAt: Date;
  /** Omit to keep the current staff member. */
  staffId?: string;
  /**
   * The owner acting on their own diary.
   *
   * Bypasses the notice period and the roster — squeezing someone in at 18:30
   * after a 18:00 close is ordinary, and the notice period exists to protect
   * staff from surprise CUSTOMER bookings, not from themselves.
   *
   * Never bypasses: the occupancy grid (that is correctness, not policy),
   * blocked time (the owner's own explicit statement that they are not there),
   * the booking horizon, or whether the staff member can perform the service.
   */
  override?: boolean;
  now?: Date;
}

/** Thrown inside the transaction to abort it with a reason the caller can render. */
class Abort extends Error {
  constructor(readonly reason: Exclude<RescheduleResult, { ok: true }>['reason']) {
    super(reason);
  }
}

export async function rescheduleBooking(
  deps: NotifyDeps,
  request: RescheduleRequest,
): Promise<RescheduleResult> {
  const { businessId, bookingId } = request;
  const now = request.now ?? new Date();

  if (!mongoose.isValidObjectId(bookingId)) return { ok: false, reason: 'not_found' };

  /**
   * Read for DATA, not for permission.
   *
   * There is deliberately no `if (TERMINAL.includes(booking.status)) return`
   * here, even though it would refuse a completed appointment a transaction
   * earlier and slightly cheaper. Two guards for one rule means the cheap one
   * shadows the real one: every test would be answered by the read, the
   * conditional update inside the transaction would never be exercised, and the
   * only guard that actually holds under concurrency would be dead code that
   * looks alive. The status check lives in the update filter, once.
   */
  const booking = await Booking.findOne({ _id: bookingId, businessId });
  if (!booking) return { ok: false, reason: 'not_found' };

  const staffId = request.staffId ?? booking.staffId;
  const startsAt = request.startsAt;

  // Nothing to do, and worth saying so rather than silently succeeding: the
  // caller would otherwise message the customer about a move that never was.
  if (staffId === booking.staffId && startsAt.getTime() === booking.startsAt.getTime()) {
    return { ok: false, reason: 'unchanged' };
  }

  const ctx = await loadContext(businessId, booking.serviceId);
  if (!ctx) return { ok: false, reason: 'invalid_slot' };

  /**
   * The appointment keeps its OWN duration.
   *
   * If the service has been edited from 45 to 60 minutes since this was booked,
   * re-deriving the length here would quietly resize an appointment the customer
   * was already told about. Moving something is not re-specifying it.
   *
   * The buffer is taken from the service as it stands now, because turnaround is
   * the business's current operating policy rather than a promise made to the
   * customer.
   */
  const durationMinutes = booking.durationMinutes;
  const spanMinutes = durationMinutes + ctx.bufferMinutes;
  const moveCtx = { ...ctx, durationMinutes, spanMinutes };

  if (alignToGrid(startsAt, ctx.incrementMinutes).getTime() !== startsAt.getTime()) {
    // Off-grid starts write rows on points a genuinely overlapping booking never
    // touches, so the index would have nothing to collide with. Refuse, never snap.
    return { ok: false, reason: 'invalid_slot' };
  }

  // The horizon holds even under override — a booking two years out is a typo,
  // not a decision. The notice period does not.
  const window = windowCheck(startsAt, moveCtx, now);
  if (window === 'beyond_horizon') return { ok: false, reason: 'beyond_horizon' };
  if (window === 'too_soon' && !request.override) return { ok: false, reason: 'too_soon' };

  const member = await qualifiedStaff(businessId, staffId, booking.serviceId);
  if (!member) return { ok: false, reason: 'no_staff' };

  const appointment = { start: startsAt, end: addMinutes(startsAt, durationMinutes) };

  if (!request.override && !withinRoster(member.workingHours, appointment, moveCtx)) {
    return { ok: false, reason: 'outside_hours' };
  }
  if (await isBlocked(businessId, staffId, appointment)) {
    return { ok: false, reason: 'outside_hours' };
  }

  const slots = slotsFor(startsAt, moveCtx);
  const previous = { staffId: booking.staffId, startsAt: booking.startsAt };

  const session = await mongoose.startSession();
  try {
    await session.withTransaction(async () => {
      // DELETE FIRST — see the self-collision note at the top of this file.
      await SlotOccupancy.deleteMany({ businessId, bookingId }, { session });

      await SlotOccupancy.insertMany(
        slots.map((slotStart) => ({ businessId, staffId, slotStart, bookingId })),
        { session, ordered: true },
      );

      // Re-guarded rather than trusted from the read above: between that read
      // and this write the customer may have cancelled over WhatsApp, and
      // re-claiming the grid for a cancelled appointment would block an hour
      // nobody is coming to. No match aborts, and the rollback restores
      // whatever the cancellation left.
      const updated = await Booking.findOneAndUpdate(
        { _id: bookingId, businessId, status: { $nin: TERMINAL } },
        { $set: { staffId, startsAt } },
        { session, new: true },
      );
      if (!updated) throw new Abort('already_terminal');
    });
  } catch (err) {
    if (err instanceof Abort) return { ok: false, reason: err.reason };
    if (isDuplicateKey(err)) {
      logger.info({ bookingId, businessId, staffId, startsAt }, 'reschedule lost the slot race');
      return { ok: false, reason: 'slot_taken' };
    }
    throw err;
  } finally {
    await session.endSession();
  }

  const moved = await Booking.findById(bookingId);
  if (!moved) throw new Error(`booking ${bookingId} rescheduled but could not be read back`);

  logger.info(
    { bookingId, businessId, from: previous, to: { staffId, startsAt } },
    'booking rescheduled',
  );

  const notified = await announce(deps, businessId, moved.clientId, booking.serviceId, startsAt);
  return { ok: true, booking: toBooking(moved), notified };
}

/**
 * Tell the customer, in the BUSINESS's timezone.
 *
 * A reschedule the customer is not told about is worse than no reschedule: they
 * turn up at the old time, are told they are not booked, and the business looks
 * broken. Failure to send is reported back rather than swallowed, so the owner
 * can pick up the phone.
 */
async function announce(
  deps: NotifyDeps,
  businessId: string,
  clientId: string,
  serviceId: string,
  startsAt: Date,
): Promise<boolean> {
  const [business, service] = await Promise.all([
    Business.findById(businessId).select('name timezone'),
    Service.findById(serviceId).select('name'),
  ]);
  if (!business) return false;

  const when = formatLocal(startsAt, business.timezone);
  return notifyClient(
    deps,
    businessId,
    clientId,
    `Your ${service?.name ?? 'appointment'} at ${business.name} has been moved to ${when}. ` +
      `Reply CANCEL if that no longer works for you.`,
  );
}
