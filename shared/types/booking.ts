import type { BookingStatus } from '../constants/booking-status.js';

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
  priceMinor: number;
  /** Which surface created it — a headline evaluation metric (WhatsApp vs web). */
  source: 'whatsapp' | 'web' | 'owner';
  depositId?: string;
  createdAt: Date;
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
