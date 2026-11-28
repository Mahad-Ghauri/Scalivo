import { BOOKING_STATUS, NOTIFICATION_KIND } from '@scalivo/shared';
import { PUSH_CHANNEL, pushToOwners } from '../push/fcm.js';
import { Booking } from '../models/Booking.js';
import { Business } from '../models/Business.js';
import { Service } from '../models/Service.js';
import { Staff } from '../models/Staff.js';
import { logger } from '../lib/logger.js';
import { env } from '../config/env.js';
import * as copy from '../whatsapp/messages.js';
import { meTokenFor } from '../me/token.js';
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
  | {
      ok: true;
      changed: boolean;
      delivery: SendOutcome;
      /** The booking is held pending a deposit; the payment link went out instead. */
      awaitingDeposit?: boolean;
      awaitingApproval?: boolean;
    }
  | { ok: false; reason: 'not_found' | 'already_terminal' | 'approval_expired' };

export async function confirmBooking(
  deps: SendDeps,
  businessId: string,
  bookingId: string,
  options: {
    ownerApproval?: boolean;
    /** The customer booked it themselves (WhatsApp, website, deposit), so tell the owner. */
    notifyOwner?: boolean;
    display?: {
      businessName: string;
      timezone: string;
      serviceName: string;
      staffName: string;
      pageUrl: string | null;
    };
  } = {},
): Promise<ConfirmResult> {
  if (!options.ownerApproval)
    await Booking.updateOne(
      { _id: bookingId, businessId, status: BOOKING_STATUS.PENDING, approvalRequired: true },
      { $set: { status: BOOKING_STATUS.AWAITING_APPROVAL } },
    );
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
    {
      _id: bookingId,
      businessId,
      $or: [
        {
          status: BOOKING_STATUS.PENDING,
          ...(options.ownerApproval
            ? {
                $or: [
                  { approvalRequired: { $ne: true } },
                  { approvalExpiresAt: { $gt: new Date() } },
                ],
              }
            : { approvalRequired: { $ne: true } }),
        },
        ...(options.ownerApproval
          ? [{ status: BOOKING_STATUS.AWAITING_APPROVAL, approvalExpiresAt: { $gt: new Date() } }]
          : []),
      ],
    },
    { $set: { status: BOOKING_STATUS.CONFIRMED }, $inc: { revision: 1 } },
    { new: true },
  );

  const booking = updated ?? (await Booking.findOne({ _id: bookingId, businessId }));
  if (!booking) return { ok: false, reason: 'not_found' };

  // Nothing to confirm about an appointment that is over or called off, and a
  // "you're booked" for one would be actively misleading.
  if (isTerminal(booking.status)) return { ok: false, reason: 'already_terminal' };
  if (
    booking.approvalRequired &&
    booking.status !== BOOKING_STATUS.CONFIRMED &&
    (!booking.approvalExpiresAt || booking.approvalExpiresAt <= new Date())
  )
    return { ok: false, reason: 'approval_expired' };

  let display = options.display;
  if (!display) {
    const [business, service, staff] = await Promise.all([
      Business.findById(businessId).select('name timezone'),
      Service.findOne({ _id: booking.serviceId, businessId }).select('name'),
      Staff.findOne({ _id: booking.staffId, businessId }).select('name'),
    ]);
    if (!business) return { ok: false, reason: 'not_found' };
    display = {
      businessName: business.name,
      timezone: business.timezone,
      serviceName: service?.name ?? 'your appointment',
      staffName: staff?.name ?? 'our team',
      pageUrl: await mePageUrl(businessId, booking.clientId),
    };
  }
  const recipient = booking.appointmentHolderName
    ? `Appointment for ${booking.appointmentHolderName}.\n\n`
    : '';
  if (booking.status === BOOKING_STATUS.AWAITING_APPROVAL) {
    const delivery = await sendTracked(deps, {
      businessId,
      clientId: booking.clientId,
      bookingId,
      kind: NOTIFICATION_KIND.CONFIRMATION,
      dedupeKey: `${bookingId}:approval_request`,
      scheduledFor: new Date(),
      text:
        recipient +
        `Your ${display.serviceName} request at ${display.businessName} is awaiting the owner's approval. It is not confirmed yet. We will let you know when it is accepted.`,
    });
    if (delivery.ok || delivery.reason !== 'already_claimed')
      await pushToOwners(businessId, {
        title: 'Appointment awaiting approval',
        body: 'A customer requested an appointment. Open your calendar to accept or decline before the request expires.',
        channel: PUSH_CHANNEL.BOOKINGS,
        route: '/',
      }).catch((err) =>
        logger.error({ err, businessId, bookingId }, 'could not notify owner of approval request'),
      );
    return { ok: true, changed: false, delivery, awaitingApproval: true };
  }

  /**
   * A deposit-required booking is not confirmed by the customer's YES — it is
   * confirmed by the money (SPEC §12.1). So every path that would say "you're
   * booked" says "pay to secure it" instead, and the confirmation proper is
   * sent by payments/deposits.ts once the gateway reports success. Routing it
   * here, rather than at each caller, is what keeps WhatsApp, web and the
   * owner's confirm button from each needing to know deposits exist.
   */
  if (booking.status === BOOKING_STATUS.AWAITING_DEPOSIT) {
    const delivery = await sendTracked(deps, {
      businessId,
      clientId: booking.clientId,
      bookingId,
      kind: NOTIFICATION_KIND.DEPOSIT_REQUEST,
      dedupeKey: `${bookingId}:deposit_request`,
      text:
        recipient +
        copy.depositRequest({
          businessName: display.businessName,
          serviceName: display.serviceName,
          staffName: display.staffName,
          startsAt: booking.startsAt,
          timezone: display.timezone,
          depositMinor: booking.depositMinor ?? 0,
          dueBy: booking.depositDueBy ?? booking.startsAt,
          payUrl: `${env.WEB_URL}/pay/${booking.depositToken}`,
        }),
      scheduledFor: new Date(),
    });
    logger.info({ bookingId, businessId }, 'deposit requested');
    return { ok: true, changed: false, delivery, awaitingDeposit: true };
  }

  const delivery = await sendTracked(deps, {
    businessId,
    clientId: booking.clientId,
    bookingId,
    kind: NOTIFICATION_KIND.CONFIRMATION,
    // One confirmation per booking, for the life of the booking. A reschedule
    // announces itself separately rather than re-confirming.
    dedupeKey: `${bookingId}:confirmation`,
    text:
      recipient +
      copy.booked({
        businessName: display.businessName,
        serviceName: display.serviceName,
        staffName: display.staffName,
        startsAt: booking.startsAt,
        timezone: display.timezone,
        pageUrl: display.pageUrl,
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

  // Only on the confirm that changed the status, so a repeat call never pings twice.
  if (updated && options.notifyOwner)
    await pushToOwners(businessId, {
      title: 'New booking',
      body: `${display.serviceName} with ${display.staffName}, ${booking.startsAt.toLocaleString('en-GB', {
        timeZone: display.timezone,
        weekday: 'short',
        day: 'numeric',
        month: 'short',
        hour: 'numeric',
        minute: '2-digit',
      })}`,
      channel: PUSH_CHANNEL.BOOKINGS,
      route: '/',
    }).catch((err) => logger.error({ err, businessId, bookingId }, 'could not notify owner of booking'));

  return { ok: true, changed: Boolean(updated), delivery };
}

/** Consecutive visits share display reads and a customer link, while each message remains tracked. */
export async function confirmBookings(
  deps: SendDeps,
  businessId: string,
  bookings: { id: string; clientId: string; serviceId: string; staffId: string }[],
  { notifyOwner = false }: { notifyOwner?: boolean } = {},
) {
  if (
    !bookings.length ||
    bookings.length > 5 ||
    bookings.some((booking) => booking.clientId !== bookings[0]!.clientId)
  )
    throw new Error('invalid consecutive confirmation');
  const [business, services, staff, pageUrl] = await Promise.all([
    Business.findById(businessId).select('name timezone').lean().maxTimeMS(5000),
    Service.find({ businessId, _id: { $in: bookings.map((booking) => booking.serviceId) } })
      .select('name')
      .lean()
      .limit(5)
      .maxTimeMS(5000),
    Staff.find({ businessId, _id: { $in: bookings.map((booking) => booking.staffId) } })
      .select('name')
      .lean()
      .limit(5)
      .maxTimeMS(5000),
    mePageUrl(businessId, bookings[0]!.clientId),
  ]);
  if (!business) return bookings.map(() => ({ ok: false as const, reason: 'not_found' as const }));
  const results: ConfirmResult[] = [];
  for (const booking of bookings) {
    try {
      results.push(
        await confirmBooking(deps, businessId, booking.id, {
          notifyOwner,
          display: {
            businessName: business.name,
            timezone: business.timezone,
            pageUrl,
            serviceName:
              services.find((service) => String(service._id) === booking.serviceId)?.name ??
              'your appointment',
            staffName:
              staff.find((member) => String(member._id) === booking.staffId)?.name ?? 'our team',
          },
        }),
      );
    } catch (err) {
      logger.error(
        { err, bookingId: booking.id, businessId },
        'could not confirm consecutive appointment',
      );
      results.push({ ok: false, reason: 'not_found' });
    }
  }
  return results;
}

/**
 * The magic link for this customer's own page — milestone 3.3's delivery.
 *
 * Every confirmation carries it, so this is where the token is minted: the first
 * booking creates it, and each later confirmation repeats the same URL.
 *
 * A failure here returns null and the confirmation goes out without the link.
 * That ordering is the point — the confirmation is what the customer is owed,
 * and losing it because a convenience page could not be addressed would trade
 * something transactional for something optional.
 */
async function mePageUrl(businessId: string, clientId: string): Promise<string | null> {
  try {
    const token = await meTokenFor(businessId, clientId);
    return token ? `${env.WEB_URL}/me/${token}` : null;
  } catch (err) {
    logger.warn({ err, businessId }, 'could not address the customer page');
    return null;
  }
}

function isTerminal(status: string | undefined): boolean {
  return (
    status === BOOKING_STATUS.CANCELLED ||
    status === BOOKING_STATUS.COMPLETED ||
    status === BOOKING_STATUS.NO_SHOW
  );
}
