export const BOOKING_STATUS = {
  PENDING: 'pending',
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
