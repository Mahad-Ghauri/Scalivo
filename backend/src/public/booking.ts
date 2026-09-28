import {
  BOOKING_STATUS,
  type AvailableSlot,
  type GrowChannel,
  type PublicBookingReceipt,
  type PublicSlot,
} from '@scalivo/shared';
import { Booking } from '../models/Booking.js';
import { Service } from '../models/Service.js';
import { Staff } from '../models/Staff.js';
import { createBooking } from '../bookings/create.js';
import { loadContext, slotsFor } from '../bookings/availability.js';
import { holdKeys, releaseHold } from '../bookings/holds.js';
import { findOrCreateClient } from '../crm/clients.js';
import { normalisePhone } from '../lib/phone.js';
import { logger } from '../lib/logger.js';
import { confirmBooking } from '../notifications/confirm.js';
import type { SendDeps } from '../notifications/send.js';

/**
 * Booking from the public website.
 *
 * The one rule: **this file contains no booking logic.** A web booking is a
 * customer, a hold and a call to createBooking with `source: 'web'` — the same
 * occupancy transaction, the same unique index, the same "that slot just went"
 * as a WhatsApp booking. The two channels cannot double-book each other because
 * there is only one way to write a booking, not because they coordinate.
 *
 * What IS different about the web is only the input: an anonymous stranger who
 * types a phone number, which is why the customer is resolved here and why the
 * route in front of this is rate-limited.
 */

export const toPublicSlot = (slot: AvailableSlot): PublicSlot => ({
  staffId: slot.staffId,
  startsAt: slot.startsAt.toISOString(),
});

/**
 * Give a hold back early — the customer picked a different time.
 *
 * Without this, every time a customer changes their mind the time they left
 * stays hidden from everyone else for the rest of its two minutes. Safe to
 * expose publicly because the release script only deletes keys still carrying
 * the caller's token: guessing someone else's slot releases nothing.
 */
export async function releaseWebHold(
  deps: Pick<SendDeps, 'redis'>,
  businessId: string,
  hold: { token: string; serviceId: string; staffId: string; startsAt: Date },
): Promise<void> {
  const ctx = await loadContext(businessId, hold.serviceId);
  if (!ctx) return;
  const slots = slotsFor(hold.startsAt, ctx);
  await releaseHold(deps.redis, {
    token: hold.token,
    staffId: hold.staffId,
    keys: holdKeys(businessId, hold.staffId, slots),
    expiresAt: new Date(),
  });
}

export type WebBookingResult =
  | { ok: true; receipt: PublicBookingReceipt }
  | { ok: false; reason: 'slot_taken'; alternatives: PublicSlot[] }
  | {
      ok: false;
      reason: 'hold_expired' | 'invalid_slot' | 'outside_hours' | 'too_soon' | 'beyond_horizon' | 'no_staff' | 'invalid_phone';
    };

/**
 * `WebBookingResult` without the one failure that only an anonymous caller can
 * have — a phone number cannot be invalid when nobody typed one.
 *
 * Spelled out rather than `Exclude`d: the failure member carries its reasons as
 * a union on one field, so `Exclude` matches no member and silently removes
 * nothing. It would have compiled and narrowed the type not at all.
 */
export type ClientBookingResult =
  | { ok: true; receipt: PublicBookingReceipt }
  | { ok: false; reason: 'slot_taken'; alternatives: PublicSlot[] }
  | {
      ok: false;
      reason: 'hold_expired' | 'invalid_slot' | 'outside_hours' | 'too_soon' | 'beyond_horizon' | 'no_staff';
    };

/**
 * Book for a customer who is already known — the shared half of every booking
 * made through a browser.
 *
 * Split out for milestone 3.3: the customer's own page books as the person whose
 * token opened it, so it needs everything below and none of the phone-number
 * handling above. Sharing the code rather than copying it is what stops the two
 * drifting — in particular, the rebook cannot quietly lose the confirmation
 * send, the deposit routing, or `source: 'web'`.
 */
export async function bookAsClient(
  deps: SendDeps,
  businessId: string,
  input: {
    clientId: string;
    serviceId: string;
    staffId: string;
    startsAt: Date;
    holdToken: string;
    channel?: GrowChannel | undefined;
  },
): Promise<ClientBookingResult> {
  const result = await createBooking(deps.redis, {
    businessId,
    serviceId: input.serviceId,
    staffId: input.staffId,
    clientId: input.clientId,
    startsAt: input.startsAt,
    holdToken: input.holdToken,
    source: 'web',
    channel: input.channel ?? 'direct',
  });

  if (!result.ok) {
    return result.reason === 'slot_taken'
      ? { ok: false, reason: 'slot_taken', alternatives: result.alternatives.map(toPublicSlot) }
      : { ok: false, reason: result.reason };
  }

  /**
   * Pressing "Confirm booking" IS the customer's yes — the web equivalent of
   * typing YES on WhatsApp — so the booking is confirmed and the confirmation
   * message sent now, through the same tracked, ack-driven path.
   *
   * A confirmation that cannot be sent does not fail a booking that exists.
   * Note it may never arrive: a first message to a number that has never
   * messaged the business is exactly the cold-contact case WhatsApp can drop
   * silently (spike issue #830). The notification row records whether it did.
   */
  const confirmed = await confirmBooking(deps, businessId, result.booking.id).catch((err) => {
    logger.error({ err, bookingId: result.booking.id }, 'could not confirm web booking');
    return null;
  });

  const [service, staff] = await Promise.all([
    Service.findById(result.booking.serviceId).select('name'),
    Staff.findById(result.booking.staffId).select('name'),
  ]);

  return {
    ok: true,
    receipt: {
      id: result.booking.id,
      startsAt: result.booking.startsAt.toISOString(),
      durationMinutes: result.booking.durationMinutes,
      priceMinor: result.booking.priceMinor,
      serviceName: service?.name ?? '',
      staffName: staff?.name ?? '',
      status:
        confirmed?.ok && !confirmed.awaitingDeposit ? BOOKING_STATUS.CONFIRMED : result.booking.status,
      depositToken: confirmed?.ok && confirmed.awaitingDeposit ? await depositTokenOf(result.booking.id) : null,
    },
  };
}

export async function bookFromWeb(
  deps: SendDeps,
  businessId: string,
  input: {
    serviceId: string;
    staffId: string;
    startsAt: Date;
    holdToken: string;
    name: string;
    phone: string;
    channel?: GrowChannel | undefined;
  },
): Promise<WebBookingResult> {
  /**
   * A phone number is required on the web, unlike a walk-in. It is the only
   * way this customer is ever reached — the confirmation, the reminder, and the
   * CANCEL they reply with all go over WhatsApp — and it is what matches them
   * to the history they already have from booking by message.
   *
   * It is NOT verified. Anyone can type anyone's number, and the booking then
   * lands on that person's profile and messages them. An OTP over WhatsApp is
   * the fix; until then the rate limit on the route is what bounds the damage.
   */
  if (!normalisePhone(input.phone)) return { ok: false, reason: 'invalid_phone' };

  const clientId = await findOrCreateClient({ phone: input.phone, name: input.name, via: 'web' });
  if (!clientId) return { ok: false, reason: 'invalid_phone' };

  return bookAsClient(deps, businessId, { ...input, clientId });
}

/** Read back rather than put on the shared Booking contract, which the owner app also receives. */
async function depositTokenOf(bookingId: string): Promise<string | null> {
  const booking = await Booking.findById(bookingId).select('depositToken');
  return booking?.depositToken ?? null;
}
