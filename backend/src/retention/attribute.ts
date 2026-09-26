import {
  DELIVERY_STATUS,
  REBOOK_ATTRIBUTION_DAYS,
  RETENTION_KINDS,
} from '@scalivo/shared';
import { Notification } from '../models/Notification.js';
import { logger } from '../lib/logger.js';

/**
 * Did the message work? — SPEC §6.3.
 *
 * Two events answer it, and both are stamped on the marketing message they
 * followed, at the moment they happen: the customer replied, and the customer
 * booked. `rebooked ÷ sends` is then a query rather than a reconstruction, which
 * matters because it is one of the thesis's headline metrics and it has to mean
 * the same thing in six months as it does today.
 *
 * **Attribution is a claim about cause and this one is deliberately weak.** A
 * booking inside the window followed a nudge; it was not necessarily caused by
 * one. The window is short (two weeks) so that a regular customer's next
 * ordinary visit is not credited to a campaign it had nothing to do with, and the
 * evaluation chapter reports these as attributed, never as caused.
 *
 * Only the FIRST reply and the FIRST booking after a message count, and only for
 * a message that was actually handed over — a nudge sitting QUEUED behind an
 * outage cannot have caused anything.
 */

const DAY_MS = 86_400_000;

/** Statuses that mean the message left the building. Everything else cannot have been read. */
const WAS_SENT = [
  DELIVERY_STATUS.ACCEPTED,
  DELIVERY_STATUS.DELIVERED,
  DELIVERY_STATUS.READ,
] as const;

/**
 * The customer messaged us. If a marketing message is the last thing they heard
 * from us, this is a reply to it.
 *
 * Called on every inbound message, which is why it is one indexed conditional
 * update and not a read followed by a write: inbound volume is small but this is
 * on the hot path of every conversation, and a query per message that usually
 * matches nothing should cost as little as possible.
 *
 * `repliedAt: null` in the filter is what makes it first-reply-only — a customer
 * who exchanges twenty messages while booking stamps the nudge once.
 */
export async function attributeReply(
  businessId: string,
  clientId: string,
  at = new Date(),
): Promise<void> {
  try {
    await Notification.findOneAndUpdate(
      {
        businessId,
        clientId,
        kind: { $in: RETENTION_KINDS },
        status: { $in: WAS_SENT },
        repliedAt: null,
        scheduledFor: { $gte: new Date(at.getTime() - REBOOK_ATTRIBUTION_DAYS * DAY_MS) },
      },
      { $set: { repliedAt: at } },
      // findOneAndUpdate rather than updateOne, only because it is the one that
      // takes a sort — and the sort is the point. Newest first: if two campaigns
      // reached them, the reply belongs to the one they just received, not to the
      // one from a fortnight ago.
      { sort: { scheduledFor: -1 } },
    );
  } catch (err) {
    // Attribution is bookkeeping. Losing it must never cost the customer their
    // reply, which is what throwing from the inbound path would do.
    logger.error({ err, businessId, clientId }, 'could not attribute a reply');
  }
}

/**
 * The customer booked. Called from the one place every booking passes through
 * (crm/profile.ts recordBooking), so web, WhatsApp and owner-entered bookings
 * are all attributed by the same rule without three call sites to keep in step.
 */
export async function attributeRebooking(
  businessId: string,
  clientId: string,
  bookingId: string,
  at = new Date(),
): Promise<void> {
  try {
    const result = await Notification.findOneAndUpdate(
      {
        businessId,
        clientId,
        kind: { $in: RETENTION_KINDS },
        status: { $in: WAS_SENT },
        rebookedBookingId: null,
        scheduledFor: { $gte: new Date(at.getTime() - REBOOK_ATTRIBUTION_DAYS * DAY_MS) },
      },
      { $set: { rebookedBookingId: bookingId } },
      { sort: { scheduledFor: -1 }, new: true },
    );

    if (result) {
      logger.info(
        { businessId, clientId, bookingId, kind: result.kind, campaignId: result.campaignId },
        'booking attributed to a marketing message',
      );
    }
  } catch (err) {
    logger.error({ err, businessId, clientId, bookingId }, 'could not attribute a booking');
  }
}
