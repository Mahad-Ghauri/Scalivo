import {
  BOOKING_STATUS,
  type BookingStatus,
  type CalendarBlock,
  type CalendarDay,
  type CalendarEntry,
  type CalendarView,
  followUpSummary,
  reminderState,
} from '@scalivo/shared';
import { BlockedTime } from '../models/BlockedTime.js';
import { Booking } from '../models/Booking.js';
import { Business } from '../models/Business.js';
import { Client } from '../models/Client.js';
import { Service } from '../models/Service.js';
import { Staff } from '../models/Staff.js';
import { addMinutes, businessDayBounds, toBusinessLocal } from '../lib/time.js';

/**
 * Reading the diary.
 *
 * Nothing here writes, but two things are easy to get wrong in a way that shows
 * the owner a day that is not their day:
 *
 * 1. **A day is a LOCAL day.** Splitting on UTC midnight moves the first five
 *    hours of every Karachi day onto the previous page. Every boundary in this
 *    file goes through businessDayBounds.
 *
 * 2. **An appointment that starts before the range can still be inside it.** A
 *    booking at 23:45 with an hour's duration belongs to tomorrow's morning as
 *    well as tonight. Filtering on `startsAt` alone drops it from the view while
 *    the grid still considers that time occupied — the owner sees a free hour
 *    that nobody can book into, and there is nothing on screen to explain why.
 */

/** Terminal states that no longer occupy time, and so are not drawn by default. */
const FREED: BookingStatus[] = [BOOKING_STATUS.CANCELLED];

export interface CalendarQuery {
  businessId: string;
  /** Business-local start date, 'YYYY-MM-DD'. */
  from: string;
  /** Business-local end date, INCLUSIVE — a one-day view passes the same date twice. */
  to: string;
  staffId?: string;
  /** Cancelled appointments are hidden unless the owner asks to see them. */
  includeCancelled?: boolean;
}

/**
 * How far back to look for appointments that spill into the range.
 *
 * Derived from the business's own longest service rather than assumed, because
 * a guessed constant is wrong in exactly one direction that matters: too small
 * and a long treatment silently vanishes off the top of the day.
 */
async function longestSpanMinutes(businessId: string): Promise<number> {
  const services = await Service.find({ businessId }).select('durationMinutes bufferMinutes');
  return services.reduce((max, s) => Math.max(max, s.durationMinutes + (s.bufferMinutes ?? 0)), 0);
}

export async function getCalendar(query: CalendarQuery): Promise<CalendarView | null> {
  const business = await Business.findById(query.businessId);
  if (!business) return null;

  const timezone = business.timezone;
  const { start: from } = businessDayBounds(query.from, timezone);
  // `to` is inclusive, so the window runs to the END of that local day.
  const { end: to } = businessDayBounds(query.to, timezone);
  if (to <= from) return null;

  const staff = await Staff.find({
    businessId: query.businessId,
    active: true,
    ...(query.staffId ? { _id: query.staffId } : {}),
  }).select('_id name');

  const staffIds = staff.map((s) => String(s._id));
  const staffName = new Map(staff.map((s) => [String(s._id), s.name]));

  const lookback = await longestSpanMinutes(query.businessId);

  const [bookings, blocks] = await Promise.all([
    Booking.find({
      businessId: query.businessId,
      ...(query.staffId ? { staffId: { $in: staffIds } } : {}),
      // See note 2 above: widened by the longest possible appointment, then
      // filtered on the real interval below.
      startsAt: { $gte: addMinutes(from, -lookback), $lt: to },
      ...(query.includeCancelled ? {} : { status: { $nin: FREED } }),
    }).sort({ startsAt: 1 }),
    BlockedTime.find({
      businessId: query.businessId,
      resourceId: null,
      // A null staffId closes the whole business and belongs on every column.
      ...(query.staffId ? { $or: [{ staffId: null }, { staffId: query.staffId }] } : {}),
      startsAt: { $lt: to },
      endsAt: { $gt: from },
    }).sort({ startsAt: 1 }),
  ]);

  // Names resolved in three queries for the whole range rather than per row.
  const [clients, services] = await Promise.all([
    Client.find({ _id: { $in: [...new Set(bookings.map((b) => b.clientId))] } }).select(
      '_id displayName phone',
    ),
    Service.find({ _id: { $in: [...new Set(bookings.map((b) => b.serviceId))] } }).select(
      '_id name',
    ),
  ]);
  const byClient = new Map(clients.map((c) => [String(c._id), c]));
  const serviceName = new Map(services.map((s) => [String(s._id), s.name]));

  const entries: CalendarEntry[] = [];
  for (const booking of bookings) {
    const endsAt = addMinutes(booking.startsAt, booking.durationMinutes);
    // The widened query above pulled in appointments that finished before the
    // range began. Half-open overlap: [startsAt, endsAt) against [from, to).
    if (endsAt <= from) continue;

    const client = byClient.get(booking.clientId);
    entries.push({
      id: String(booking._id),
      staffId: booking.staffId,
      // A booking outlives the staff member who was deactivated after it — the
      // appointment still happened and must still be drawable.
      staffName: staffName.get(booking.staffId) ?? 'Staff',
      clientId: booking.clientId,
      clientName: booking.appointmentHolderName ?? client?.displayName ?? null,
      clientPhone: client?.phone ?? null,
      serviceId: booking.serviceId,
      serviceName: serviceName.get(booking.serviceId) ?? 'Service',
      startsAt: booking.startsAt,
      endsAt,
      durationMinutes: booking.durationMinutes,
      status: booking.status,
      revision: booking.revision,
      approvalExpiresAt: booking.approvalExpiresAt ?? null,
      priceMinor: booking.priceMinor,
      source: booking.source,
      reminderState: reminderState(booking),
      followUp: followUpSummary(booking.followUp),
    });
  }

  // `?? null` rather than a cast: Mongoose types a `default: null` field as
  // `T | null | undefined`, the undefined covering a projected-away field. The
  // contract says null, and collapsing the two here is what stops the app having
  // to know the difference.
  const calendarBlocks: CalendarBlock[] = blocks.map((b) => ({
    id: String(b._id),
    staffId: b.staffId ?? null,
    startsAt: b.startsAt,
    endsAt: b.endsAt,
    reason: b.reason ?? null,
  }));

  return {
    timezone,
    from,
    to,
    staff: staff.map((s) => ({ id: String(s._id), name: s.name })),
    days: groupByLocalDay(query.from, query.to, timezone, entries, calendarBlocks),
  };
}

/**
 * Bucket everything into local days, emitting empty days too.
 *
 * A missing Tuesday is indistinguishable from a Tuesday with nothing on it once
 * the data reaches a UI, and the second is the common case. Emitting the empty
 * day means the app renders a column rather than skipping to Wednesday.
 *
 * An appointment or block spanning midnight appears on BOTH days. That is not a
 * duplicate: the owner looking at Tuesday needs to see the thing occupying
 * Tuesday's first hour.
 */
function groupByLocalDay(
  fromDate: string,
  toDate: string,
  timezone: string,
  entries: CalendarEntry[],
  blocks: CalendarBlock[],
): CalendarDay[] {
  const days: CalendarDay[] = [];

  let cursor = toBusinessLocal(businessDayBounds(fromDate, timezone).start, timezone);
  const last = toBusinessLocal(businessDayBounds(toDate, timezone).start, timezone);

  // Walking in local days rather than adding 86_400_000 ms: a DST transition
  // makes a local day 23 or 25 hours long, and ms arithmetic would drift onto
  // the wrong date. Pakistan has no DST today, but the code must not be the
  // reason a second market cannot be added.
  while (cursor <= last) {
    const date = cursor.toISODate();
    if (!date) break;

    const { start, end } = businessDayBounds(date, timezone);
    days.push({
      date,
      entries: entries.filter((e) => e.startsAt < end && e.endsAt > start),
      blocks: blocks.filter((b) => b.startsAt < end && b.endsAt > start),
    });

    cursor = cursor.plus({ days: 1 });
  }

  return days;
}
