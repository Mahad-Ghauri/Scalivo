import mongoose, { type HydratedDocument, type InferSchemaType } from 'mongoose';
import type { Redis } from 'ioredis';
import {
  ANY_STAFF,
  BOOKING_STATUS,
  type Booking as BookingContract,
  type BookingRequest,
  type BookingResult,
  HOLD_TTL_SECONDS,
  type Hold,
} from '@scalivo/shared';
import { Booking } from '../models/Booking.js';
import { SlotOccupancy } from '../models/SlotOccupancy.js';
import { Staff } from '../models/Staff.js';
import { alignToGrid } from '../lib/time.js';
import { logger } from '../lib/logger.js';
import {
  getAvailability,
  isWithinWorkingHours,
  loadContext,
  nextAvailable,
  slotsFor,
  windowCheck,
} from './availability.js';
import { acquireHold, releaseHold, verifyHold } from './holds.js';
import { toBusinessLocal } from '../lib/time.js';

/**
 * Turning an offer into a booking.
 *
 * The whole design rests on one refusal: never check-then-write. Reading
 * availability and then inserting leaves a window between the read and the
 * write, and that window is precisely where a double booking lives — two
 * requests both read "free", both insert, both succeed. No amount of care in
 * the read closes it.
 *
 * So the write itself is the check. Occupancy rows carry a unique index on
 * {businessId, staffId, slotStart}; they and the booking go in inside ONE
 * transaction; a duplicate key on any row aborts everything. The loser gets
 * "that slot just went" and three alternatives, which is normal traffic on a
 * busy Saturday, not an error.
 *
 * Everything else here — holds, working hours, notice period — is courtesy and
 * validation layered on top. Strip all of it away and the system is still
 * correct. Strip the transaction away and nothing else can save it.
 */

/** MongoDB's duplicate-key error, however it is wrapped by the driver. */
function isDuplicateKey(err: unknown): boolean {
  if (typeof err !== 'object' || err === null) return false;
  const e = err as { code?: number; writeErrors?: { code?: number }[] };
  if (e.code === 11000) return true;
  return Array.isArray(e.writeErrors) && e.writeErrors.some((w) => w.code === 11000);
}

/**
 * Mongoose document -> the shared `Booking` contract.
 *
 * Mongoose stores `_id`; the contract says `id`. Returning the raw document
 * instead makes `res.json()` ship `_id`, so every client reading `Booking.id`
 * — the Flutter app included — silently gets undefined. Nothing errors; the
 * field is just always missing.
 *
 * Mapping explicitly is also what stops internal fields leaking outward by
 * default: a spread of the document would publish whatever the schema grows
 * next, including anything added for internal bookkeeping.
 */
function toBooking(
  doc: HydratedDocument<InferSchemaType<typeof Booking.schema>>,
): BookingContract {
  return {
    id: String(doc._id),
    businessId: doc.businessId,
    staffId: doc.staffId,
    clientId: doc.clientId,
    serviceId: doc.serviceId,
    startsAt: doc.startsAt,
    durationMinutes: doc.durationMinutes,
    status: doc.status,
    priceMinor: doc.priceMinor,
    source: doc.source,
    createdAt: doc.createdAt,
  };
}

export interface HoldRequest {
  businessId: string;
  serviceId: string;
  startsAt: Date;
  /** A staff id, or ANY_STAFF. */
  staffId?: string;
  source: 'whatsapp' | 'web' | 'owner';
  now?: Date;
}

export type HoldOutcome =
  | { ok: true; hold: Hold }
  | { ok: false; reason: 'slot_taken' | 'invalid_slot' | 'outside_hours' | 'too_soon' | 'beyond_horizon' | 'no_staff' };

/**
 * Reserve a span while the customer decides.
 *
 * ANY_STAFF resolves to a real person HERE, not at booking time. A hold on
 * "anyone" reserves nobody: two customers could each hold "anyone" for 4:00 with
 * only one person free, and both would be told yes. Picking first, then holding
 * that person, is what makes the promise real.
 */
export async function holdSlot(redis: Redis, request: HoldRequest): Promise<HoldOutcome> {
  const ctx = await loadContext(request.businessId, request.serviceId);
  if (!ctx) return { ok: false, reason: 'invalid_slot' };

  const now = request.now ?? new Date();
  const startsAt = request.startsAt;

  // An unaligned start would write occupancy rows on grid points that a genuinely
  // overlapping booking never touches — the collision the index relies on simply
  // would not happen. Refuse rather than silently snap.
  if (alignToGrid(startsAt, ctx.incrementMinutes).getTime() !== startsAt.getTime()) {
    return { ok: false, reason: 'invalid_slot' };
  }

  const window = windowCheck(startsAt, ctx, now);
  if (window !== 'ok') return { ok: false, reason: window };

  const wantsAnyone = !request.staffId || request.staffId === ANY_STAFF;

  let candidates: string[];
  if (wantsAnyone) {
    // Ask availability for this exact instant rather than reimplementing it, and
    // take its least-busy-first ordering — the one place staff assignment
    // policy lives.
    const date = toBusinessLocal(startsAt, ctx.timezone).toISODate();
    if (!date) return { ok: false, reason: 'invalid_slot' };

    const offers = await getAvailability(redis, {
      businessId: request.businessId,
      serviceId: request.serviceId,
      date,
      now,
    });
    candidates = offers
      .filter((slot) => slot.startsAt.getTime() === startsAt.getTime())
      .map((slot) => slot.staffId);

    // getAvailability collapses to one staff member per time, so fall back to
    // everyone qualified — the first choice may lose the hold race to another
    // customer a millisecond earlier, and the second choice is still valid.
    if (candidates.length === 0) {
      const qualified = await Staff.find({
        businessId: request.businessId,
        active: true,
        serviceIds: request.serviceId,
      }).select('_id');
      candidates = qualified.map((s) => String(s._id));
    }
  } else {
    candidates = [request.staffId!];
  }

  if (candidates.length === 0) return { ok: false, reason: 'no_staff' };

  const slots = slotsFor(startsAt, ctx);
  const ttl = request.source === 'whatsapp' ? HOLD_TTL_SECONDS.WHATSAPP : HOLD_TTL_SECONDS.WEB;

  let bookable = false;
  for (const staffId of candidates) {
    if (!(await isWithinWorkingHours(request.businessId, staffId, request.serviceId, startsAt, ctx))) {
      continue;
    }
    bookable = true;

    // Occupancy is checked before spending a hold, purely to give the right
    // answer. It is not a guard — the transaction is.
    const taken = await SlotOccupancy.exists({
      businessId: request.businessId,
      staffId,
      slotStart: { $in: slots },
    });
    if (taken) continue;

    const handle = await acquireHold(redis, request.businessId, staffId, slots, ttl);
    if (!handle) continue;

    return {
      ok: true,
      hold: {
        token: handle.token,
        businessId: request.businessId,
        staffId,
        serviceId: request.serviceId,
        startsAt,
        expiresAt: handle.expiresAt,
      },
    };
  }

  return { ok: false, reason: bookable ? 'slot_taken' : 'outside_hours' };
}

/**
 * Write the booking, or lose the race cleanly.
 *
 * Every validation below is repeated from the hold path on purpose. The hold was
 * taken minutes ago on a customer's say-so; between then and now the notice
 * period may have swallowed the slot, the owner may have blocked the afternoon,
 * and the request itself may never have held anything at all.
 */
export async function createBooking(
  redis: Redis,
  request: BookingRequest & { now?: Date },
): Promise<BookingResult> {
  const ctx = await loadContext(request.businessId, request.serviceId);
  if (!ctx) return { ok: false, reason: 'invalid_slot' };

  const now = request.now ?? new Date();
  const { startsAt, staffId } = request;

  if (staffId === ANY_STAFF) return { ok: false, reason: 'invalid_slot' };
  if (alignToGrid(startsAt, ctx.incrementMinutes).getTime() !== startsAt.getTime()) {
    return { ok: false, reason: 'invalid_slot' };
  }

  const window = windowCheck(startsAt, ctx, now);
  if (window !== 'ok') return { ok: false, reason: window };

  const slots = slotsFor(startsAt, ctx);

  // A hold that partly expired is expired: verifyHold requires our token on
  // EVERY increment. Half a hold reserves nothing.
  if (!(await verifyHold(redis, request.businessId, staffId, slots, request.holdToken))) {
    return { ok: false, reason: 'hold_expired' };
  }

  if (!(await isWithinWorkingHours(request.businessId, staffId, request.serviceId, startsAt, ctx))) {
    return { ok: false, reason: 'outside_hours' };
  }

  // Generated up front so the occupancy rows can point at a booking that does
  // not exist yet — both inserts land in the same transaction, so from outside
  // they appear together or not at all.
  const bookingId = new mongoose.Types.ObjectId();

  const session = await mongoose.startSession();
  try {
    await session.withTransaction(async () => {
      await SlotOccupancy.insertMany(
        slots.map((slotStart) => ({
          businessId: request.businessId,
          staffId,
          slotStart,
          bookingId: String(bookingId),
        })),
        { session, ordered: true },
      );

      await Booking.create(
        [
          {
            _id: bookingId,
            businessId: request.businessId,
            staffId,
            clientId: request.clientId,
            serviceId: request.serviceId,
            startsAt,
            durationMinutes: ctx.durationMinutes,
            status: BOOKING_STATUS.PENDING,
            priceMinor: ctx.priceMinor,
            source: request.source,
          },
        ],
        { session },
      );
    });
  } catch (err) {
    if (isDuplicateKey(err)) {
      // Someone else committed first. The transaction rolled back, so no partial
      // occupancy is left behind — and the hold is theirs now, not ours, so it
      // is deliberately NOT released here.
      logger.info(
        { businessId: request.businessId, staffId, startsAt },
        'booking lost the slot race',
      );
      return {
        ok: false,
        reason: 'slot_taken',
        alternatives: await nextAvailable(redis, request.businessId, request.serviceId, {
          from: startsAt,
        }),
      };
    }
    throw err;
  } finally {
    await session.endSession();
  }

  // Occupancy owns the slot now; the hold has done its job. Leaving it would
  // block the owner from rescheduling into that time for another five minutes.
  await releaseHold(redis, {
    token: request.holdToken,
    staffId,
    keys: slots.map((s) => `hold:${request.businessId}:${staffId}:${s.getTime()}`),
    expiresAt: now,
  });

  const doc = await Booking.findById(bookingId);
  if (!doc) throw new Error(`booking ${bookingId} committed but could not be read back`);

  logger.info(
    { bookingId: String(bookingId), businessId: request.businessId, source: request.source },
    'booking created',
  );

  return { ok: true, booking: toBooking(doc) };
}

/**
 * Free the time. Deleting the occupancy rows is the operative act — the status
 * change is bookkeeping.
 *
 * Not a transaction: the two writes are idempotent and independent, and the
 * failure mode is benign in the direction that matters. Rows gone but status
 * stale means a slot is bookable again, which is what the owner asked for.
 */
export async function cancelBooking(bookingId: string, businessId: string): Promise<boolean> {
  const booking = await Booking.findOne({ _id: bookingId, businessId });
  if (!booking) return false;

  await SlotOccupancy.deleteMany({ bookingId, businessId });
  await Booking.updateOne({ _id: bookingId }, { $set: { status: BOOKING_STATUS.CANCELLED } });

  logger.info({ bookingId, businessId }, 'booking cancelled, slots freed');
  return true;
}
