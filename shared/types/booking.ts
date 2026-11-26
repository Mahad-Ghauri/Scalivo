import type { BookingStatus } from '../constants/booking-status.js';
import type { DepositStatus } from './deposit.js';

/**
 * A booking. `startsAt` is always UTC — conversion to business-local happens at
 * the edges only (display, and interpreting owner-entered times).
 */
export interface Booking {
  id: string;
  businessId: string;
  staffId: string;
  clientId: string;
  serviceId: string;
  startsAt: Date;
  durationMinutes: number;
  status: BookingStatus;
  resourceIds?: string[];
  appointmentHolderId?: string | null;
  appointmentHolderName?: string | null;
  approvalExpiresAt?: Date | null;
  revision?: number;
  priceMinor: number;
  /** Which surface created it — a headline evaluation metric (WhatsApp vs web). */
  source: 'whatsapp' | 'web' | 'owner';
  /** The deposit this booking required, in paisa. Null when none was asked for. */
  depositMinor: number | null;
  depositStatus: DepositStatus | null;
  createdAt: Date;
}

/**
 * Where a booking stands on the customer's side of its reminders — the badge
 * on the owner's calendar. Null until a reminder has gone out.
 *   confirmed   ✅ replied 1
 *   awaiting    ❓ reminded, no reply yet
 *   undelivered ⚠️ the reminder never reached them
 */
export type ReminderState = 'confirmed' | 'awaiting' | 'undelivered' | null;

export function reminderState(b: {
  clientConfirmedAt?: Date | null;
  remindedAt?: Date | null;
  undeliveredAlertAt?: Date | null;
}): ReminderState {
  if (b.clientConfirmedAt) return 'confirmed';
  if (b.undeliveredAlertAt) return 'undelivered';
  if (b.remindedAt) return 'awaiting';
  return null;
}

/**
 * One row per base increment a booking spans. THIS is the double-booking
 * arbiter, not the booking collection.
 *
 * Why it exists: a unique index on {businessId, staffId, startsAt} only catches
 * *identical* start times. A 45-min service at 4:00 and a 20-min at 4:15 for one
 * staff member have different startsAt, so both insert cleanly and you have a
 * double booking nothing detected.
 *
 * Instead: a 45-min service at 4:00 writes rows at 4:00, 4:15, 4:30, each unique
 * on {businessId, staffId, slotStart}. Any overlap collides on at least one row.
 * The rows and the booking are written in ONE transaction, so a duplicate-key on
 * any of them aborts the whole booking.
 *
 * Never check-then-write. The database is the arbiter.
 */
export interface SlotOccupancy {
  businessId: string;
  staffId: string;
  /** UTC, aligned to the business's increment grid. */
  slotStart: Date;
  bookingId: string;
}

/** An offered time. Held and booked slots are hidden from customers, never greyed. */
export interface AvailableSlot {
  staffId: string;
  startsAt: Date;
  durationMinutes: number;
}

/**
 * Time a staff member is unavailable for reasons no working-hours pattern
 * describes: Eid, a wedding, a supplier visit, a sick afternoon.
 *
 * Deliberately not modelled as an occupancy row. Occupancy rows are owned by a
 * booking and deleted with it; blocked time outlives every booking near it, and
 * a business-wide holiday would otherwise mean writing a row per staff member
 * per increment for a whole day.
 */
export interface BlockedTime {
  id: string;
  businessId: string;
  /** null blocks the whole business — a public holiday, not one person's day off. */
  staffId: string | null;
  /** UTC half-open interval [startsAt, endsAt). */
  startsAt: Date;
  endsAt: Date;
  reason: string | null;
}

/**
 * A soft hold over every increment a service spans, in Redis with a TTL.
 *
 * Advisory only — it stops two customers being offered the same slot while one
 * is still typing. It is NOT the double-booking guard: that is the occupancy
 * grid's unique index, inside the transaction. A hold can expire mid-confirm,
 * and the booking must still be refused rather than double-written.
 */
export interface Hold {
  token: string;
  businessId: string;
  /** Always a real staff id, even when the customer asked for ANY_STAFF. */
  staffId: string;
  serviceId: string;
  startsAt: Date;
  expiresAt: Date;
}

export interface BookingRequest {
  businessId: string;
  staffId: string;
  clientId: string;
  appointmentHolderId?: string | undefined;
  serviceId: string;
  startsAt: Date;
  source: Booking['source'];
  /** Proves this caller owns the soft hold it is converting. */
  holdToken: string;
}

/** Losing a booking race is normal traffic, not an error condition. */
export type BookingResult =
  | { ok: true; booking: Booking }
  | { ok: false; reason: 'slot_taken'; alternatives: AvailableSlot[] }
  | {
      ok: false;
      reason:
        | 'hold_expired'
        | 'invalid_slot'
        | 'outside_hours'
        | 'too_soon'
        | 'beyond_horizon'
        | 'no_staff';
    };

/** Transport shape for a consecutive visit; every leg has already passed availability checks. */
export interface SequenceSlot {
  staffId: string;
  startsAt: string;
  appointments: { serviceId: string; staffId: string; startsAt: string; durationMinutes: number }[];
}

/**
 * A follow-up the owner attached to a booking: "come back in N days for X".
 *
 *   scheduled → waiting for the visit to complete and the due window to open
 *   offered   → customer messaged with a suggested slot (1 book · 2 other · 3 no)
 *   nudged    → one gentle reminder after no reply
 *   booked    → the customer has a later booking for that service
 *   declined  → customer replied "not now"
 *   lapsed    → no reply / unreachable / opted out — on the owner's call list
 *   cancelled → the visit never happened, or the owner removed it
 */
export const FOLLOW_UP_STATUS = {
  SCHEDULED: 'scheduled',
  OFFERED: 'offered',
  NUDGED: 'nudged',
  BOOKED: 'booked',
  DECLINED: 'declined',
  LAPSED: 'lapsed',
  CANCELLED: 'cancelled',
} as const;
export type FollowUpStatus = (typeof FOLLOW_UP_STATUS)[keyof typeof FOLLOW_UP_STATUS];

/** Days before dueAt the customer is first messaged. */
export const FOLLOW_UP_OFFER_DAYS_BEFORE = 3;
/** Days of silence before the nudge, and again before it lapses. */
export const FOLLOW_UP_NUDGE_AFTER_DAYS = 3;

/** One row of the owner's "Follow-ups" list. */
export interface FollowUpItem {
  bookingId: string;
  status: FollowUpStatus;
  dueAt: Date;
  note: string | null;
  lapsedReason: string | null;
  serviceId: string;
  serviceName: string;
  staffId: string | null;
  staffName: string | null;
  clientId: string;
  clientName: string | null;
  clientPhone: string | null;
  /** The visit this follows. */
  visitAt: Date;
  bookedBookingId: string | null;
}

/** What a booking's screens show about its follow-up. */
export interface FollowUpSummary {
  status: FollowUpStatus;
  dueAt: Date;
  serviceId: string;
  staffId: string | null;
  note: string | null;
}

export function followUpSummary(
  f: { status: string; dueAt: Date; serviceId: string; staffId?: string | null; note?: string | null } | null | undefined,
): FollowUpSummary | null {
  if (!f) return null;
  return {
    status: f.status as FollowUpStatus,
    dueAt: f.dueAt,
    serviceId: f.serviceId,
    staffId: f.staffId ?? null,
    note: f.note ?? null,
  };
}
