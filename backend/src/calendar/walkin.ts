import { BOOKING_STATUS, type BookingResult } from '@scalivo/shared';
import { Client } from '../models/Client.js';
import { loadContext, slotsFor } from '../bookings/availability.js';
import { createBooking } from '../bookings/create.js';
import { acquireHold, releaseHold } from '../bookings/holds.js';
import { normalisePhone } from '../lib/phone.js';
import { logger } from '../lib/logger.js';
import { confirmBooking } from '../notifications/confirm.js';
import type { SendDeps } from '../notifications/send.js';

/**
 * Someone is standing at the desk.
 *
 * The single rule this file exists to obey: **a walk-in goes through
 * createBooking like everything else.** It would be a dozen lines to insert a
 * Booking row here directly, and those dozen lines would be a second write path
 * with no occupancy rows — so the grid would not know the hour was sold, and
 * WhatsApp would cheerfully offer it to somebody else. Every guarantee Phase 1.3
 * bought holds only while there is exactly one way to write a booking.
 *
 * What is genuinely different about a walk-in is only ever the INPUT: a person
 * who may have no phone number, and a start time that is now rather than in an
 * hour. Both are handled before the shared path is entered, not inside it.
 */

export interface WalkInRequest {
  businessId: string;
  serviceId: string;
  /**
   * Required, never ANY_STAFF. The owner is looking at a staff-columned calendar
   * and pointing at a column; asking the system to choose would be answering a
   * question they have already answered better.
   */
  staffId: string;
  startsAt: Date;
  /** Either is enough to create a client; neither is allowed. */
  name?: string;
  phone?: string;
  /** An existing customer the owner picked from search — skips matching entirely. */
  clientId?: string;
  now?: Date;
}

export type WalkInResult =
  | (Extract<BookingResult, { ok: true }> & { clientId: string })
  | Extract<BookingResult, { ok: false }>
  | { ok: false; reason: 'no_client' };

/**
 * Find the person, or make them.
 *
 * Matching on the phone is the whole point. A regular who has messaged on
 * WhatsApp already exists as a Client keyed on the number WhatsApp reported, and
 * creating a second row for them here would split their visit history in two
 * with nothing on screen to say so. normalisePhone is what makes the owner's
 * `0320…` and WhatsApp's `92320…` the same key.
 */
async function resolveClient(request: WalkInRequest): Promise<string | null> {
  if (request.clientId) {
    const existing = await Client.exists({ _id: request.clientId });
    return existing ? request.clientId : null;
  }

  const phone = request.phone ? normalisePhone(request.phone) : null;
  const name = request.name?.trim() || null;

  // A nameless, numberless walk-in is not a customer, it is an empty row. The
  // owner has to give us something to call them.
  if (!phone && !name) return null;

  if (phone) {
    const matched = await Client.findOne({ phone });
    if (matched) {
      // Backfill a name we did not have. Never overwrite one we did — WhatsApp's
      // display name is the customer's own, and the owner's shorthand is not an
      // improvement on it.
      if (name && !matched.displayName) {
        matched.displayName = name;
        await matched.save();
      }
      return String(matched._id);
    }
  }

  // No phone means the partial unique index lets this coexist with every other
  // phone-less client — which is exactly why that index is partial and not
  // sparse. See the note on the Client model.
  const created = await Client.create({ phone, displayName: name });
  logger.info({ clientId: String(created._id), hasPhone: Boolean(phone) }, 'walk-in client created');
  return String(created._id);
}

export async function createWalkIn(
  deps: SendDeps,
  request: WalkInRequest,
): Promise<WalkInResult> {
  const { redis } = deps;
  const ctx = await loadContext(request.businessId, request.serviceId);
  if (!ctx) return { ok: false, reason: 'invalid_slot' };

  const clientId = await resolveClient(request);
  if (!clientId) return { ok: false, reason: 'no_client' };

  /**
   * The hold is taken directly rather than through holdSlot, which enforces the
   * notice period a walk-in exists to ignore — the customer is already here.
   *
   * It is still taken. Not for the customer's benefit but for the owner's: two
   * staff members entering the same walk-in on two phones serialise here instead
   * of both reaching the transaction, and the loser is told immediately rather
   * than after a rolled-back write.
   */
  const slots = slotsFor(request.startsAt, ctx);
  const handle = await acquireHold(redis, request.businessId, request.staffId, slots, 60);
  if (!handle) return { ok: false, reason: 'slot_taken', alternatives: [] };

  const result = await createBooking(redis, {
    businessId: request.businessId,
    staffId: request.staffId,
    clientId,
    serviceId: request.serviceId,
    startsAt: request.startsAt,
    source: 'owner',
    holdToken: handle.token,
    override: true,
    ...(request.now ? { now: request.now } : {}),
  });

  if (!result.ok) {
    // Give the span straight back. Left to its TTL it would hide a minute of
    // availability from the customer the refusal was about.
    await releaseHold(redis, handle);
    return result;
  }

  /**
   * Straight to CONFIRMED, skipping PENDING — and a confirmation message with
   * it, through the same tracked path a WhatsApp booking uses.
   *
   * PENDING means "we are waiting for the customer to say yes". The customer is
   * standing in front of the owner; there is nobody left to hear from. Leaving
   * it pending would put the walk-in on every chase-the-unconfirmed list the
   * retention engine grows in Phase 2.
   *
   * The message is not redundant just because the customer is in the room. It is
   * the only written record they get of a time somebody else typed for them, and
   * it is what CANCEL and RESCHEDULE later reply to. A walk-in with no phone
   * number simply has no address, and confirmBooking records that as skipped
   * rather than failing the booking.
   */
  await confirmBooking(deps, request.businessId, result.booking.id);

  logger.info(
    { bookingId: result.booking.id, businessId: request.businessId, clientId },
    'walk-in booked',
  );

  return {
    ...result,
    booking: { ...result.booking, status: BOOKING_STATUS.CONFIRMED },
    clientId,
  };
}
