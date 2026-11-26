import { BOOKING_STATUS, DELIVERY_STATUS, NOTIFICATION_KIND } from '@scalivo/shared';
import { Booking } from '../models/Booking.js';
import { Business } from '../models/Business.js';
import { Client } from '../models/Client.js';
import { Notification } from '../models/Notification.js';
import { Service } from '../models/Service.js';
import { PUSH_CHANNEL, pushToOwners } from '../push/fcm.js';
import { addMinutes, formatLocal } from '../lib/time.js';
import { logger } from '../lib/logger.js';

/**
 * Telling the owner about the reminders that did not work.
 *
 * Two alerts, each at most once per booking:
 *
 * - **Undelivered** — a reminder the provider accepted but no ack ever said
 *   arrived. "Sent" proves nothing (README finding #3); silence after half an
 *   hour is the owner's cue that the customer probably has not seen it.
 * - **Unconfirmed** — the customer was reminded, the reminder is not known to
 *   have failed, and they still have not replied 1 by the cut-off. A likely
 *   no-show the owner can still phone, which is the whole value of asking.
 *
 * The once-only guarantee is a conditional update on the booking
 * (`alertAt: null` → now) made BEFORE the push: the same claim-then-act rule as
 * Notification rows, so overlapping ticks cannot both alert.
 */

const INTERVAL_MS = 60 * 1000;

/** How long an accepted reminder may stay un-acked before it counts as lost. */
export const UNDELIVERED_AFTER_MINUTES = 30;

const LIVE = [BOOKING_STATUS.PENDING, BOOKING_STATUS.CONFIRMED, BOOKING_STATUS.AWAITING_APPROVAL];

export async function escalationsOnce(now = new Date()): Promise<void> {
  const businesses = await Business.find({ 'reminders.escalate': { $ne: false } }).select(
    'name timezone reminders',
  );
  for (const business of businesses) {
    try {
      await escalateBusiness(String(business._id), business.timezone, business.reminders, now);
    } catch (err) {
      logger.error({ err, businessId: String(business._id) }, 'escalation pass failed');
    }
  }
}

export async function escalateBusiness(
  businessId: string,
  timezone: string,
  settings:
    | { enabled?: boolean | null; escalate?: boolean | null; escalateMinutesBefore?: number | null }
    | null
    | undefined,
  now: Date,
): Promise<void> {
  if (settings?.enabled === false || settings?.escalate === false) return;
  const cutoff = settings?.escalateMinutesBefore ?? 180;

  // Every reminder that went out for an appointment still ahead. Bounded by
  // the longest plausible lead (a week) so the scan stays small.
  const reminders = await Notification.find({
    businessId,
    kind: NOTIFICATION_KIND.REMINDER,
    status: {
      $in: [
        DELIVERY_STATUS.ACCEPTED,
        DELIVERY_STATUS.DELIVERED,
        DELIVERY_STATUS.READ,
        DELIVERY_STATUS.FAILED,
      ],
    },
    scheduledFor: { $gte: addMinutes(now, -60 * 24 * 8) },
  })
    .select('bookingId status acceptedAt deliveredAt')
    .lean();
  if (reminders.length === 0) return;

  const byBooking = new Map<string, typeof reminders>();
  for (const r of reminders) {
    if (!r.bookingId) continue;
    byBooking.set(r.bookingId, [...(byBooking.get(r.bookingId) ?? []), r]);
  }

  const bookings = await Booking.find({
    _id: { $in: [...byBooking.keys()] },
    businessId,
    startsAt: { $gt: now },
    status: { $in: LIVE },
  });

  for (const booking of bookings) {
    const sent = byBooking.get(String(booking._id)) ?? [];
    const arrived = sent.some(
      (r) =>
        r.deliveredAt != null ||
        r.status === DELIVERY_STATUS.DELIVERED ||
        r.status === DELIVERY_STATUS.READ,
    );
    const lost = sent.some(
      (r) =>
        r.status === DELIVERY_STATUS.FAILED ||
        (r.status === DELIVERY_STATUS.ACCEPTED &&
          r.deliveredAt == null &&
          r.acceptedAt != null &&
          now.getTime() - r.acceptedAt.getTime() >= UNDELIVERED_AFTER_MINUTES * 60_000),
    );

    // ── Undelivered: only if NO reminder is known to have arrived.
    if (!arrived && lost && booking.clientConfirmedAt == null) {
      if (await claim(booking._id, 'undeliveredAlertAt', now)) {
        await alert(businessId, timezone, booking, 'undelivered');
      }
      // An unreachable customer cannot be "unconfirmed" as well — one alert.
      continue;
    }

    // ── Unconfirmed: reminded, silent, and inside the cut-off.
    const insideCutoff = booking.startsAt.getTime() - now.getTime() <= cutoff * 60_000;
    if (booking.clientConfirmedAt == null && insideCutoff && booking.undeliveredAlertAt == null) {
      if (await claim(booking._id, 'unconfirmedAlertAt', now)) {
        await alert(businessId, timezone, booking, 'unconfirmed');
      }
    }
  }
}

async function claim(
  bookingId: unknown,
  field: 'unconfirmedAlertAt' | 'undeliveredAlertAt',
  now: Date,
): Promise<boolean> {
  const result = await Booking.updateOne(
    { _id: bookingId, [field]: null },
    { $set: { [field]: now } },
  );
  return result.modifiedCount === 1;
}

async function alert(
  businessId: string,
  timezone: string,
  booking: { _id: unknown; clientId: string; serviceId: string; startsAt: Date },
  kind: 'unconfirmed' | 'undelivered',
): Promise<void> {
  const [client, service] = await Promise.all([
    Client.findById(booking.clientId).select('displayName phone').lean(),
    Service.findById(booking.serviceId).select('name').lean(),
  ]);
  const who = client?.displayName ?? client?.phone ?? 'A customer';
  const what = `${service?.name ?? 'appointment'} ${formatLocal(booking.startsAt, timezone)}`;

  const message =
    kind === 'unconfirmed'
      ? { title: `${who} hasn't confirmed`, body: `${what}. Tap to call or message them.` }
      : {
          title: `Reminder didn't reach ${who}`,
          body: `${what}. They may not know. Tap to contact them.`,
        };

  await pushToOwners(businessId, {
    ...message,
    channel: PUSH_CHANNEL.BOOKINGS,
    route: '/appointments',
  });
  logger.info({ businessId, bookingId: String(booking._id), kind }, 'owner escalation sent');
}

export function startEscalationJob(): () => void {
  const run = () => {
    escalationsOnce().catch((err) => logger.error({ err }, 'escalation tick failed'));
  };
  const timer = setInterval(run, INTERVAL_MS);
  timer.unref();
  return () => clearInterval(timer);
}
