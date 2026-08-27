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
  | { ok: false; reason: 'hold_expired' | 'invalid_slot' | 'outside_hours' };
