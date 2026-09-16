import { BOOKING_STATUS, NOTIFICATION_KIND } from '@scalivo/shared';
import { Booking } from '../models/Booking.js';
import { Business } from '../models/Business.js';
import { Service } from '../models/Service.js';
import { Staff } from '../models/Staff.js';
import { logger } from '../lib/logger.js';
import * as copy from '../whatsapp/messages.js';
import { sendTracked, type SendDeps, type SendOutcome } from './send.js';

/**
 * Making a booking real: the status change and the message, in one place.
 *
 * They used to be in two. `bookings/outcome.ts` flipped PENDING → CONFIRMED and
 * told nobody; the FSM told the customer "you're booked" and left the status
 * PENDING forever. Neither half was visibly broken — the calendar drew the
 * appointment, the grid held the hour — but every WhatsApp booking in the system
 * would have landed on the chase-the-unconfirmed list Phase 2 retention grows,
 * and the owner would have been told to ring customers who had already said yes.
 *
 * Keeping them merged is what stops that coming back. Two functions doing half a
 * job each is how the gap existed in the first place — the same lesson
 * cancelBooking taught, for the same reason.
 *
 * **CONFIRMED tracks the customer's answer, not the message's fate.** It is
 * tempting to flip on the ack instead, since this phase is about ack-driven
 * delivery — but that conflates two different facts. The customer typed YES; the
 * appointment exists whether or not our reply reached them. Gating the status on
 * delivery would leave real appointments looking unconfirmed because a message
 * went missing, which is the failure mode inverted rather than fixed. Whether
 * they were successfully TOLD lives on the notification row, where a null
 * `deliveredAt` is the honest record of a confirmation that never landed.
 */

export type ConfirmResult =
  | { ok: true; changed: boolean; delivery: SendOutcome }
  | { ok: false; reason: 'not_found' | 'already_terminal' };

export async function confirmBooking(
  deps: SendDeps,
  businessId: string,
  bookingId: string,
): Promise<ConfirmResult> {
  /**
   * Conditional on PENDING, so the write is the check.
   *
   * Confirming twice is then a no-op rather than a resurrection: a booking the
   * customer cancelled in the seconds between typing YES and this call must not
   * be quietly un-cancelled by a confirmation arriving late. `changed` reports
   * which of the two happened, because the owner-facing confirm route renders
   * "already confirmed" and "just confirmed" differently.
   */
  const updated = await Booking.findOneAndUpdate(
    { _id: bookingId, businessId, status: BOOKING_STATUS.PENDING },
    { $set: { status: BOOKING_STATUS.CONFIRMED } },
    { new: true },
  );

  const booking = updated ?? (await Booking.findOne({ _id: bookingId, businessId }));
  if (!booking) return { ok: false, reason: 'not_found' };

  // Nothing to confirm about an appointment that is over or called off, and a
  // "you're booked" for one would be actively misleading.
  if (isTerminal(booking.status)) return { ok: false, reason: 'already_terminal' };

  const [business, service, staff] = await Promise.all([
    Business.findById(businessId).select('name timezone'),
    Service.findById(booking.serviceId).select('name'),
    Staff.findById(booking.staffId).select('name'),
  ]);
  if (!business) return { ok: false, reason: 'not_found' };

  const delivery = await sendTracked(deps, {
    businessId,
    clientId: booking.clientId,
    bookingId,
    kind: NOTIFICATION_KIND.CONFIRMATION,
    // One confirmation per booking, for the life of the booking. A reschedule
    // announces itself separately rather than re-confirming.
    dedupeKey: `${bookingId}:confirmation`,
    text: copy.booked({
      businessName: business.name,
      serviceName: service?.name ?? 'your appointment',
      staffName: staff?.name ?? 'our team',
      startsAt: booking.startsAt,
      timezone: business.timezone,
    }),
    scheduledFor: new Date(),
  });

  logger.info(
    {
      bookingId,
      businessId,
      changed: Boolean(updated),
      delivery: delivery.ok ? delivery.status : delivery.reason,
    },
    'booking confirmed',
  );

  return { ok: true, changed: Boolean(updated), delivery };
}

function isTerminal(status: string | undefined): boolean {
  return (
    status === BOOKING_STATUS.CANCELLED ||
    status === BOOKING_STATUS.COMPLETED ||
    status === BOOKING_STATUS.NO_SHOW
  );
}
