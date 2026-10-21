/**
 * The customer's own page — milestone 3.3, SPEC §1.5 / §11.
 *
 * Everything else the platform serves has an obvious answer to "who is asking":
 * the marketplace serves strangers and shows only published businesses, the
 * dashboard serves owners and carries a JWT. This surface serves a CUSTOMER, and
 * a customer has no account. They gave a WhatsApp number once; they were never
 * asked for a password and must not be.
 *
 * So the URL is the credential. `MeView` is what the holder of one token may
 * read, and the shape is drawn tightly on purpose — one person's relationship
 * with ONE business, no ids that address anything else, no phone number, and
 * nothing about anybody else. See me/token.ts for why the token is durable and
 * what that costs.
 */

import type { BookingStatus } from '../constants/booking-status.js';

/**
 * Completed spend, in minor units, per loyalty point. Rs 100 = 1 point.
 *
 * A platform-wide rate rather than a per-business setting, which is milestone
 * 3.5's job. The rate matters less than the property it buys: the balance is a
 * pure function of `lifetimeSpendMinor`, so there is no accrual ledger to drift
 * out of step with the bookings, and recompute() cannot lose somebody's points.
 * When 3.5 makes the rate configurable it replaces this constant and every
 * historical balance re-derives itself correctly.
 *
 * Deliberately coarse. One point per rupee on an Rs 8,000 treatment reads as a
 * number nobody can hold in their head; eighty reads as a balance.
 */
export const LOYALTY_MINOR_PER_POINT = 10_000;

export const loyaltyPoints = (spendMinor: number): number =>
  Math.max(0, Math.floor(spendMinor / LOYALTY_MINOR_PER_POINT));

/**
 * One appointment as its own customer sees it.
 *
 * No `clientId`, no `businessId` and no staff or service ids: this shape is
 * read by a page reached with a bearer token in a URL, and an id here is an id
 * that has escaped into a browser history. The one exception is `depositToken`,
 * which is a capability the customer already holds — it arrived in their chat.
 */
export interface MeAppointment {
  id: string;
  serviceName: string;
  staffName: string;
  startsAt: string;
  durationMinutes: number;
  priceMinor: number;
  status: BookingStatus;
  appointmentHolderName?: string | null;
  /** Money still owed on this one; the page links to /pay/<token>. Null otherwise. */
  depositToken: string | null;
}

/**
 * Standing, not per-visit. `visits` counts completed appointments only — the
 * same rule the owner's CRM uses, so the two never disagree in front of a
 * customer who asks.
 */
export interface MeLoyalty {
  points: number;
  visits: number;
  lifetimeSpendMinor: number;
  /** First completed visit, imported history included. Null before the first one. */
  memberSince: string | null;
}

/**
 * What "again" means for this customer — their most frequent service, and the
 * staff member they have seen most for it.
 *
 * Resolved on the server rather than in the page, because the page must not be
 * given a service list to choose from: this is one tap on a known service, not
 * a booking form. `staffId` is null when they have no clear preference, which
 * the rebook then treats as any qualified staff member.
 */
export interface MeUsual {
  serviceId: string;
  serviceName: string;
  durationMinutes: number;
  priceMinor: number;
  staffId: string | null;
  staffName: string | null;
}

/** A completed visit with no rating yet. Drives the review screen. */
export interface MePendingReview {
  bookingId: string;
  serviceName: string;
  visitedAt: string;
}

export interface MeView {
  /** For the greeting. First name only, and null when nobody ever gave one. */
  firstName: string | null;
  businessName: string;
  businessSlug: string;
  timezone: string;
  /** Soonest first. Anything not yet started and not called off. */
  upcoming: MeAppointment[];
  /** Most recent first, capped — a history, not an archive. */
  past: MeAppointment[];
  loyalty: MeLoyalty;
  usual: MeUsual | null;
  pendingReview: MePendingReview | null;
}

/** How many past appointments the page carries. */
export const ME_PAST_LIMIT = 6;
/** Bound future appointments without reading an unlimited customer history. */
export const ME_UPCOMING_LIMIT = 100;

/**
 * Why a rebook was refused, in the customer's terms.
 *
 * A subset of PublicBookingError: the /me path supplies the identity itself, so
 * `invalid_phone` cannot happen here, and it is a booking rather than a browse,
 * so there is no hold to expire before the customer has one.
 */
export type MeRebookError =
  | 'slot_taken'
  | 'hold_expired'
  | 'invalid_slot'
  | 'outside_hours'
  | 'too_soon'
  | 'beyond_horizon'
  | 'no_staff'
  | 'rate_limited';
