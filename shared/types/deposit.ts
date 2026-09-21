/**
 * Deposits — milestone 2.6, SPEC §12.
 *
 * A deposit exists to move one number: the no-show rate. Everything here is
 * shaped by that. The booking holds its slot while the customer pays, but it
 * is not confirmed — and nobody is told "you're booked" — until the money has
 * actually arrived. "No deposit, no booking."
 *
 * Sandbox only (SPEC §12.2): live JazzCash/EasyPaisa merchant accounts need a
 * registered business. The mechanism is real; the money is not.
 */

/**
 * How long a customer has to pay before the slot is released.
 *
 * Longer than a hold on purpose. A hold covers "still typing"; this covers
 * "opening a wallet app, finding the OTP, approving the charge" — which on a
 * phone in a salon's waiting area is minutes, not seconds.
 */
export const DEPOSIT_PAYMENT_WINDOW_MINUTES = 30;

/**
 * Grace after the window before an unpaid booking is released, when a payment
 * was started but has not reported back.
 *
 * SPEC §12.4: "payment succeeds but the confirmation is slow — reconcile before
 * finalising". Releasing the slot the instant the window closes would cancel
 * the booking of someone whose money is in flight, and then refund them.
 */
export const DEPOSIT_RECONCILE_GRACE_MINUTES = 5;

/**
 * A customer cancelling at least this long before the appointment gets the
 * deposit back; later than that, the business keeps it.
 *
 * A day is enough notice to resell the slot, which is the harm the deposit
 * compensates for. The business cancelling always refunds.
 */
export const DEPOSIT_REFUND_CUTOFF_HOURS = 24;

export const DEPOSIT_STATUS = {
  /** Booking made, money not yet received. The slot is held. */
  AWAITING: 'awaiting',
  PAID: 'paid',
  /** Window closed unpaid; the slot was released. */
  EXPIRED: 'expired',
  /** The appointment happened; the deposit counted toward the bill. */
  APPLIED: 'applied',
  /** No-show or late cancellation: the business keeps it. */
  RETAINED: 'retained',
  REFUNDED: 'refunded',
  /** Moved onto the booking this one was rescheduled to. */
  TRANSFERRED: 'transferred',
} as const;

export type DepositStatus = (typeof DEPOSIT_STATUS)[keyof typeof DEPOSIT_STATUS];

/** What the public payment page shows. Reached by an unguessable token, not an id. */
export interface DepositView {
  businessName: string;
  businessSlug: string;
  serviceName: string;
  staffName: string;
  startsAt: string;
  timezone: string;
  depositMinor: number;
  priceMinor: number;
  status: DepositStatus;
  /** When the slot is released if unpaid. Null once it no longer applies. */
  dueBy: string | null;
  /** True when a late or second payment was sent back. */
  refunded: boolean;
}

/**
 * A gateway checkout is a browser form POST, not a link: JazzCash's hosted page
 * takes signed fields in the body. The page builds the form and submits it.
 */
export interface CheckoutRedirect {
  url: string;
  method: 'POST' | 'GET';
  fields: Record<string, string>;
}
