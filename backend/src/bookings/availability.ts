import type { Redis } from 'ioredis';
import { ANY_STAFF, type AvailableSlot } from '@scalivo/shared';
import { BlockedTime } from '../models/BlockedTime.js';
import { Business } from '../models/Business.js';
import { Service } from '../models/Service.js';
import { SlotOccupancy } from '../models/SlotOccupancy.js';
import { Staff } from '../models/Staff.js';
import {
  addMinutes,
  alignToGrid,
  businessDayBounds,
  occupiedSlots,
  toBusinessLocal,
  wallClockToUtc,
} from '../lib/time.js';
import { heldSlots } from './holds.js';

/**
 * What can still be booked.
 *
 *   working hours − breaks − occupancy − blocked time − active holds
 *
 * Two rules this module exists to enforce, both easy to get wrong:
 *
 * 1. A slot is offerable only if EVERY increment the service spans is free, not
 *    just its first. Checking the start alone is how a 45-min service gets
 *    offered at 4:00 with a booking already sitting at 4:15.
 *
 * 2. Held and booked slots are HIDDEN, never greyed out (SPEC §4.2). A customer
 *    on WhatsApp is reading a list, not looking at a calendar; showing them a
 *    time they cannot have costs a round trip and reads as a bug.
 *
 * This is an offer, not a reservation. Nothing here prevents a double booking —
 * between this query and the confirm, someone else can take the slot. That is
 * what the occupancy grid's unique index is for, and why the booking path never
 * trusts an answer from here.
 */

export interface AvailabilityQuery {
  businessId: string;
  serviceId: string;
  /** Local calendar date in the business's zone, 'YYYY-MM-DD'. */
  date: string;
  /** A staff id, or ANY_STAFF to let us choose. */
  staffId?: string;
  /** Injected so tests can pin "now" instead of racing the clock. */
  now?: Date;
}

export interface Interval {
  start: Date;
  end: Date;
}

const overlaps = (a: Interval, b: Interval): boolean => a.start < b.end && b.start < a.end;

/**
 * Everything availability needs that a booking also needs, loaded once.
 *
 * The booking path re-derives the same numbers before it writes — it must, since
 * the two calls are seconds apart and the caller's is untrusted — so this is
 * shared rather than duplicated.
 */
export interface BookingContext {
  timezone: string;
  incrementMinutes: number;
  minNoticeMinutes: number;
  bookingHorizonDays: number;
  durationMinutes: number;
  bufferMinutes: number;
  /** duration + buffer: what the occupancy grid actually claims. */
  spanMinutes: number;
  /**
   * Priced from the service record, never from the request. A price that
   * arrives with the booking is a price the customer can edit.
   */
  priceMinor: number;
}

export async function loadContext(
  businessId: string,
  serviceId: string,
): Promise<BookingContext | null> {
  const [business, service] = await Promise.all([
    Business.findById(businessId),
    // `active` belongs here rather than at the callers: this is the single
    // gate every booking path goes through, so a retired service becomes
    // unbookable everywhere at once — WhatsApp, web and the owner's calendar.
    Service.findOne({ _id: serviceId, businessId, active: true }),
  ]);

  // The businessId filter on the service is a tenancy check, not a convenience:
  // without it, a caller could price and book another salon's service here.
  if (!business || !service) return null;

  const durationMinutes = service.durationMinutes;
  const bufferMinutes = service.bufferMinutes ?? 0;

  return {
    timezone: business.timezone,
    incrementMinutes: business.slotIncrementMinutes,
    minNoticeMinutes: business.minNoticeMinutes,
    bookingHorizonDays: business.bookingHorizonDays,
    durationMinutes,
    bufferMinutes,
    spanMinutes: durationMinutes + bufferMinutes,
    priceMinor: service.priceMinor,
  };
}

/** The grid points a booking at `startsAt` would claim — duration AND buffer. */
export function slotsFor(startsAt: Date, ctx: BookingContext): Date[] {
  return occupiedSlots(startsAt, ctx.spanMinutes, ctx.incrementMinutes);
}

/**
 * Is this instant inside the bookable window?
 *
 * Separated out because the booking path must repeat it. Availability filtering
 * alone would let a customer sit on a WhatsApp menu for ten minutes and confirm
 * a slot that has since fallen inside the notice period.
 */
export function windowCheck(
  startsAt: Date,
  ctx: BookingContext,
  now = new Date(),
): 'ok' | 'too_soon' | 'beyond_horizon' {
  if (startsAt.getTime() < now.getTime() + ctx.minNoticeMinutes * 60_000) return 'too_soon';
  if (startsAt.getTime() > now.getTime() + ctx.bookingHorizonDays * 86_400_000) {
    return 'beyond_horizon';
  }
  return 'ok';
}

export async function getAvailability(
  redis: Redis,
  query: AvailabilityQuery,
): Promise<AvailableSlot[]> {
  const ctx = await loadContext(query.businessId, query.serviceId);
  if (!ctx) return [];

  const now = query.now ?? new Date();
  const { start: dayStart, end: dayEnd } = businessDayBounds(query.date, ctx.timezone);

  // A day is meaningless outside the booking window — bail before touching Mongo.
  if (dayEnd.getTime() < now.getTime()) return [];
  if (dayStart.getTime() > now.getTime() + ctx.bookingHorizonDays * 86_400_000) return [];

  const wantsAnyone = !query.staffId || query.staffId === ANY_STAFF;

  const staff = await Staff.find({
    businessId: query.businessId,
    active: true,
    // Staff who cannot perform the service are not availability, whatever their
    // hours say. An empty serviceIds means "not configured yet", not "everything".
    serviceIds: query.serviceId,
    ...(wantsAnyone ? {} : { _id: query.staffId }),
  });
  if (staff.length === 0) return [];

  const staffIds = staff.map((s) => String(s._id));

  // The occupancy window runs past closing because a booking's buffer, and a
  // booking that started yesterday evening, both claim grid points inside today.
  const [occupancy, blocked] = await Promise.all([
    SlotOccupancy.find({
      businessId: query.businessId,
      staffId: { $in: staffIds },
      slotStart: { $gte: addMinutes(dayStart, -ctx.spanMinutes), $lt: dayEnd },
    }),
    BlockedTime.find({
      businessId: query.businessId,
      // A null staffId blocks the whole business — a holiday, not a day off.
      $or: [{ staffId: null }, { staffId: { $in: staffIds } }],
      startsAt: { $lt: dayEnd },
      endsAt: { $gt: dayStart },
    }),
  ]);

  const takenBy = new Map<string, Set<number>>();
  for (const id of staffIds) takenBy.set(id, new Set());
  for (const row of occupancy) takenBy.get(row.staffId)?.add(row.slotStart.getTime());

  const dayOfWeek = toBusinessLocal(dayStart, ctx.timezone).weekday % 7; // luxon: Mon=1..Sun=7
  const slots: AvailableSlot[] = [];

  for (const member of staff) {
    const staffId = String(member._id);
    const hours = member.workingHours.find((h) => h.dayOfWeek === dayOfWeek);
    if (!hours) continue; // closed that day

    const opens = wallClockToUtc(`${query.date}T${hours.opensAt}`, ctx.timezone);
    const closes = wallClockToUtc(`${query.date}T${hours.closesAt}`, ctx.timezone);
    const breaks: Interval[] = hours.breaks.map((b) => ({
      start: wallClockToUtc(`${query.date}T${b.startsAt}`, ctx.timezone),
      end: wallClockToUtc(`${query.date}T${b.endsAt}`, ctx.timezone),
    }));

    const blockedHere = blocked
      .filter((b) => b.staffId === null || b.staffId === staffId)
      .map((b) => ({ start: b.startsAt, end: b.endsAt }));

    // Every grid point in the working day, so the hold lookup is one MGET rather
    // than one per candidate start.
    const gridPoints: Date[] = [];
    for (
      let t = alignToGrid(opens, ctx.incrementMinutes);
      t < addMinutes(closes, ctx.spanMinutes);
      t = addMinutes(t, ctx.incrementMinutes)
    ) {
      gridPoints.push(t);
    }

    const held = await heldSlots(redis, query.businessId, staffId, gridPoints);
    const taken = takenBy.get(staffId) ?? new Set<number>();

    for (const startsAt of gridPoints) {
      const serviceEnd = addMinutes(startsAt, ctx.durationMinutes);

      // The SERVICE must fit inside opening hours; its buffer may run past
      // closing. Turnaround after the last appointment is the owner's time.
      if (startsAt < opens || serviceEnd > closes) continue;
      if (windowCheck(startsAt, ctx, now) !== 'ok') continue;

      const appointment = { start: startsAt, end: serviceEnd };
      if (breaks.some((b) => overlaps(appointment, b))) continue;
      if (blockedHere.some((b) => overlaps(appointment, b))) continue;

      // Rule 1: EVERY increment, not just the first.
      const span = slotsFor(startsAt, ctx);
      const free = span.every((s) => !taken.has(s.getTime()) && !held.has(s.getTime()));
      if (!free) continue;

      slots.push({ staffId, startsAt, durationMinutes: ctx.durationMinutes });
    }
  }

  slots.sort((a, b) => a.startsAt.getTime() - b.startsAt.getTime());

  // "Any available" is one offer per time, not the same 4:00 listed twice
  // because two people are free. Least-busy-first spreads load instead of
  // always burying whoever sorts first.
  if (!wantsAnyone) return slots;

  const load = new Map<string, number>();
  for (const id of staffIds) load.set(id, 0);
  for (const row of occupancy) load.set(row.staffId, (load.get(row.staffId) ?? 0) + 1);

  const byTime = new Map<number, AvailableSlot>();
  for (const slot of slots) {
    const existing = byTime.get(slot.startsAt.getTime());
    if (!existing || (load.get(slot.staffId) ?? 0) < (load.get(existing.staffId) ?? 0)) {
      byTime.set(slot.startsAt.getTime(), slot);
    }
  }
  return [...byTime.values()].sort((a, b) => a.startsAt.getTime() - b.startsAt.getTime());
}

/**
 * Is this a real, active staff member who can actually perform this service?
 *
 * Separate from the hours check because it is the one part no caller may ever
 * skip. The owner's calendar can legitimately squeeze an appointment in after
 * closing; nobody can legitimately book a laser session with a receptionist who
 * is not qualified for it, and "they were deleted last week" is never a reason
 * to write the appointment anyway.
 */
export async function qualifiedStaff(businessId: string, staffId: string, serviceId: string) {
  return Staff.findOne({ _id: staffId, businessId, active: true, serviceIds: serviceId });
}

/**
 * Does time the owner declared off-limits overlap this appointment?
 *
 * Blocked time writes no occupancy rows, so the transaction cannot catch it —
 * there is nothing there to collide with. This query is the only thing standing
 * between a holiday and a booking on it.
 *
 * Kept separate from the hours check so that the owner override on the calendar
 * cannot reach it. Working hours are a default the owner may knowingly work
 * outside of; a block is the owner's own explicit statement that they are not
 * there, and silently booking over it would make the feature useless. If they
 * change their mind, they delete the block.
 */
export async function isBlocked(
  businessId: string,
  staffId: string,
  appointment: Interval,
): Promise<boolean> {
  const blocked = await BlockedTime.exists({
    businessId,
    $or: [{ staffId: null }, { staffId }],
    startsAt: { $lt: appointment.end },
    endsAt: { $gt: appointment.start },
  });
  return blocked !== null;
}

/**
 * Can this one staff member take this one appointment, ignoring occupancy?
 *
 * The booking path needs this because it cannot trust its caller. A `startsAt`
 * arriving over HTTP is just a number: it may be 3am, inside lunch, on a closed
 * Sunday, or during a blocked holiday, and none of those collide with an
 * occupancy row — there is nothing there to collide with. The unique index
 * guards against OTHER BOOKINGS; this guards against times that were never
 * bookable in the first place.
 */
export async function isWithinWorkingHours(
  businessId: string,
  staffId: string,
  serviceId: string,
  startsAt: Date,
  ctx: BookingContext,
): Promise<boolean> {
  const member = await qualifiedStaff(businessId, staffId, serviceId);
  if (!member) return false;

  const appointment = { start: startsAt, end: addMinutes(startsAt, ctx.durationMinutes) };
  if (!withinRoster(member.workingHours, appointment, ctx)) return false;

  return !(await isBlocked(businessId, staffId, appointment));
}

/**
 * The pure half: does this appointment sit inside the roster, clear of breaks?
 *
 * No database, so the calendar can ask the same question about a staff member
 * it has already loaded — and so the hours arithmetic is testable without
 * standing up Mongo.
 */
export function withinRoster(
  // Typed loosely enough to take a Mongoose subdocument array directly. The
  // break fields are optional in the schema and required by the zod validator
  // in catalog/hours.ts — which is where a malformed break is actually refused,
  // rather than here, where refusing would mean rejecting real bookings over a
  // row nobody can write.
  workingHours: readonly {
    dayOfWeek: number;
    opensAt: string;
    closesAt: string;
    breaks: readonly { startsAt?: string | null; endsAt?: string | null }[];
  }[],
  appointment: Interval,
  ctx: BookingContext,
): boolean {
  const local = toBusinessLocal(appointment.start, ctx.timezone);
  const date = local.toISODate();
  if (!date) return false;

  const hours = workingHours.find((h) => h.dayOfWeek === local.weekday % 7);
  if (!hours) return false; // closed that day

  const opens = wallClockToUtc(`${date}T${hours.opensAt}`, ctx.timezone);
  const closes = wallClockToUtc(`${date}T${hours.closesAt}`, ctx.timezone);
  if (appointment.start < opens || appointment.end > closes) return false;

  return !hours.breaks.some(
    (b) =>
      b.startsAt != null &&
      b.endsAt != null &&
      overlaps(appointment, {
        start: wallClockToUtc(`${date}T${b.startsAt}`, ctx.timezone),
        end: wallClockToUtc(`${date}T${b.endsAt}`, ctx.timezone),
      }),
  );
}

/**
 * The next few DAYS that have any opening — what the date menu offers.
 *
 * Distinct from nextAvailable(), which returns individual times. Offering a day
 * with nothing free is the dead end SPEC §1.4 calls out: the customer picks it,
 * gets an empty list, and has to start again.
 */
export async function daysWithAvailability(
  redis: Redis,
  businessId: string,
  serviceId: string,
  options: { staffId?: string; limit?: number } = {},
): Promise<{ date: string; slots: AvailableSlot[] }[]> {
  const ctx = await loadContext(businessId, serviceId);
  if (!ctx) return [];

  const limit = options.limit ?? 3;
  const days: { date: string; slots: AvailableSlot[] }[] = [];

  for (let offset = 0; offset <= ctx.bookingHorizonDays && days.length < limit; offset++) {
    const date = toBusinessLocal(new Date(Date.now() + offset * 86_400_000), ctx.timezone)
      .toISODate();
    if (!date) continue;

    const slots = await getAvailability(redis, {
      businessId,
      serviceId,
      date,
      ...(options.staffId ? { staffId: options.staffId } : {}),
    });
    if (slots.length > 0) days.push({ date, slots });
  }

  return days;
}

/**
 * The next few openings from a given instant, scanning forward day by day.
 *
 * This is what turns "that slot just went" into a useful reply instead of a dead
 * end — the customer is mid-conversation and needs somewhere to go next.
 * Bounded by the horizon so a fully-booked salon terminates.
 */
export async function nextAvailable(
  redis: Redis,
  businessId: string,
  serviceId: string,
  options: { from?: Date; staffId?: string; limit?: number } = {},
): Promise<AvailableSlot[]> {
  const ctx = await loadContext(businessId, serviceId);
  if (!ctx) return [];

  const from = options.from ?? new Date();
  const limit = options.limit ?? 3;
  const found: AvailableSlot[] = [];

  for (let dayOffset = 0; dayOffset <= ctx.bookingHorizonDays; dayOffset++) {
    const date = toBusinessLocal(new Date(from.getTime() + dayOffset * 86_400_000), ctx.timezone)
      .toISODate();
    if (!date) break;

    const slots = await getAvailability(redis, {
      businessId,
      serviceId,
      date,
      ...(options.staffId ? { staffId: options.staffId } : {}),
    });
    for (const slot of slots) {
      if (slot.startsAt > from) found.push(slot);
      if (found.length >= limit) return found;
    }
  }

  return found;
}

export type AvailabilityReason = 
  | 'available' 
  | 'invalid_slot'
  | 'too_soon' 
  | 'beyond_horizon' 
  | 'outside_hours' 
  | 'blocked' 
  | 'slot_taken';

export interface AvailabilityResult {
  available: boolean;
  reason: AvailabilityReason;
}

/**
 * ADVISORY availability check for a specific interval and a specific staff member.
 * 
 * IMPORTANT: This function is ADVISORY, not authoritative! A concurrent request 
 * can claim the exact same interval a millisecond after this function returns `available`.
 * The absolute authority remains the unique compound index on the SlotOccupancy collection, 
 * which guarantees no double bookings during the final transactional commit.
 * 
 * NOTE: ANY_STAFF resolution is strictly out of scope for this function. Callers are 
 * responsible for iterating over candidates and evaluating them individually.
 */
export async function checkIntervalAvailability(
  businessId: string,
  staffId: string,
  serviceId: string,
  startsAt: Date,
  now = new Date(),
): Promise<AvailabilityResult> {
  const ctx = await loadContext(businessId, serviceId);
  if (!ctx) return { available: false, reason: 'invalid_slot' };

  // 1. Grid alignment check
  if (alignToGrid(startsAt, ctx.incrementMinutes).getTime() !== startsAt.getTime()) {
    return { available: false, reason: 'invalid_slot' };
  }

  // 2. Horizon & Notice Period Check
  const window = windowCheck(startsAt, ctx, now);
  if (window !== 'ok') {
    return { available: false, reason: window };
  }

  // 3. Staff & Working Hours Check
  const member = await qualifiedStaff(businessId, staffId, serviceId);
  if (!member) {
    return { available: false, reason: 'outside_hours' };
  }

  const appointment = { start: startsAt, end: addMinutes(startsAt, ctx.durationMinutes) };
  if (!withinRoster(member.workingHours, appointment, ctx)) {
    return { available: false, reason: 'outside_hours' };
  }

  // 4. Blocked Time Check
  if (await isBlocked(businessId, staffId, appointment)) {
    return { available: false, reason: 'blocked' };
  }

  // 5. Occupancy Check
  // Reuses the exact slotsFor grid-decomposition logic used by holdSlot/createBooking
  // to ensure spanMinutes covers all required increments.
  const slots = slotsFor(startsAt, ctx);
  const taken = await SlotOccupancy.exists({
    businessId,
    staffId,
    slotStart: { $in: slots },
  });

  if (taken) {
    return { available: false, reason: 'slot_taken' };
  }

  return { available: true, reason: 'available' };
}
