import type { BookingStatus } from '../constants/booking-status.js';
import type { Booking, ReminderState } from './booking.js';

/**
 * What the owner's calendar shows.
 *
 * Every field a screen renders is resolved here rather than left as an id. The
 * owner reads "Hydrafacial with Dr. Ayesha for Sana Khan", and an app that has
 * to fetch three names per appointment makes forty round trips to draw one day.
 *
 * `endsAt` is the SERVICE end, not the buffered end. The grid claims the buffer
 * so nothing can be booked into it, but drawing a 20-minute laser session as a
 * 35-minute block would tell the owner the room is busy when it is being tidied.
 */
export interface CalendarEntry {
  id: string;
  staffId: string;
  staffName: string;
  clientId: string;
  /** Null for a walk-in nobody named — the owner sees "Walk-in" rather than a blank. */
  clientName: string | null;
  clientPhone: string | null;
  serviceId: string;
  serviceName: string;
  startsAt: Date;
  endsAt: Date;
  durationMinutes: number;
  status: BookingStatus;
  revision?: number;
  approvalExpiresAt?: Date | null;
  priceMinor: number;
  source: Booking['source'];
  /** Customer-side reminder badge; see reminderState(). */
  reminderState?: ReminderState;
}

/** Time the owner has declared unavailable. A null staffId closes the business. */
export interface CalendarBlock {
  id: string;
  staffId: string | null;
  startsAt: Date;
  endsAt: Date;
  reason: string | null;
}

/**
 * One business-local day.
 *
 * Grouped by local date rather than returned as a flat list because that is the
 * only grouping the UI can trust: a UTC-day split puts the first five hours of
 * every Karachi day on the wrong page.
 */
export interface CalendarDay {
  /** Business-local calendar date, 'YYYY-MM-DD'. */
  date: string;
  entries: CalendarEntry[];
  blocks: CalendarBlock[];
}

export interface CalendarView {
  timezone: string;
  /** UTC bounds of the local range actually covered. */
  from: Date;
  to: Date;
  /** Everyone the view covers, so an empty column still renders as a column. */
  staff: { id: string; name: string }[];
  days: CalendarDay[];
}

/**
 * Moving a booking.
 *
 * `slot_taken` is the same normal-traffic outcome the booking path has: the
 * owner was looking at a calendar drawn a minute ago. `unchanged` means the new
 * time and staff member are the ones it already had — worth distinguishing so
 * the app does not announce a reschedule to the customer that never happened.
 */
export type RescheduleResult =
  | { ok: true; booking: Booking; notified: boolean }
  | {
      ok: false;
      reason:
        | 'not_found'
        | 'already_terminal'
        | 'unchanged'
        | 'slot_taken'
        | 'invalid_slot'
        | 'outside_hours'
        | 'too_soon'
        | 'beyond_horizon'
        | 'no_staff';
    };
