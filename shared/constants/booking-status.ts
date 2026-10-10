export const BOOKING_STATUS = {
  PENDING: 'pending',
  AWAITING_APPROVAL: 'awaiting_approval',
  /** Deposit-required booking waiting on payment. Holds a slot; expires with the hold. */
  AWAITING_DEPOSIT: 'awaiting_deposit',
  CONFIRMED: 'confirmed',
  COMPLETED: 'completed',
  NO_SHOW: 'no_show',
  CANCELLED: 'cancelled',
} as const;

export type BookingStatus = (typeof BOOKING_STATUS)[keyof typeof BOOKING_STATUS];

// A booking occupies its slot unless it is cancelled, and counts toward revenue
// only when completed. Both are one comparison at the call site — no list needed.

/** The grid resolution availability is computed on. Per-business overridable. */
export const DEFAULT_SLOT_INCREMENT_MINUTES = 15;

/** Soft-hold TTLs. WhatsApp customers type slower than web ones. */
export const HOLD_TTL_SECONDS = {
  WHATSAPP: 5 * 60,
  WEB: 2 * 60,
} as const;

/**
 * How soon a customer may book. Without a floor, the 09:00 slot stays offerable
 * at 08:58 and the owner gets a WhatsApp booking for two minutes from now.
 */
export const DEFAULT_MIN_NOTICE_MINUTES = 60;

/**
 * How far ahead. Bounds the availability query as much as it bounds the
 * product — without it, "next free slot" scans forever when a calendar is full.
 */
export const DEFAULT_BOOKING_HORIZON_DAYS = 30;

/**
 * Asking for no particular staff member.
 *
 * A hold and a booking are always against a REAL staff id — this is only ever an
 * input, resolved to a person before anything is reserved. A hold on "any" would
 * reserve nobody and guarantee nothing.
 */
export const ANY_STAFF = 'any';
