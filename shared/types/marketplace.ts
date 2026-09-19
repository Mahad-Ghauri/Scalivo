import type { Business, Service, Staff, WorkingHours } from './business.js';

/**
 * The public marketplace contract: what `GET /public/*` returns and what the
 * Next.js site renders.
 *
 * Every date here is an ISO string rather than a `Date`. These shapes only ever
 * exist on the far side of `JSON.stringify`, and typing them as `Date` would
 * promise the web a method it does not have.
 */

/** A photo on a business profile. `alt` is never optional — an unlabelled gallery is unusable on a screen reader. */
export interface GalleryImage {
  url: string;
  alt: string;
}

/**
 * A published review. Milestone 2.2's rule is encoded in who can reach this
 * shape: only 4–5 star ratings are published, lower ones go privately to the
 * owner and never cross the public boundary.
 */
export interface PublicReview {
  id: string;
  authorName: string;
  rating: number;
  comment: string;
  createdAt: string;
  serviceName: string | null;
}

/** A review shown away from its business — the home page carousel. */
export interface FeaturedReview extends PublicReview {
  businessName: string;
  businessSlug: string;
}

/**
 * A service as a customer sees it. `bufferMinutes` and `active` are dropped:
 * turnaround time and retirement state are the owner's business.
 */
export type PublicService = Pick<
  Service,
  'id' | 'name' | 'durationMinutes' | 'priceMinor' | 'depositRequired' | 'depositAmountMinor' | 'displayOrder'
> & {
  description: string | null;
};

/**
 * A staff member as a customer sees it. `workingHours` is deliberately absent:
 * per-person schedules would broadcast when each named individual is alone in
 * the building. Availability is answered by asking for slots.
 */
export type PublicStaff = Pick<Staff, 'id' | 'name' | 'serviceIds'> & {
  role: string | null;
  avatarUrl: string | null;
};

/** A business on the directory grid — deliberately smaller than the full profile. */
export interface BusinessCard {
  id: string;
  slug: string;
  name: string;
  category: string;
  city: string | null;
  neighbourhood: string | null;
  tagline: string;
  coverUrl: string | null;
  logoUrl: string | null;
  /** Mean of published reviews; null until there are any. */
  rating: number | null;
  reviewCount: number;
  /** Cheapest active service, in paisa. */
  fromPriceMinor: number | null;
  popularServices: string[];
}

/**
 * A full public profile.
 *
 * `Omit<Business, 'whatsapp'>` is load-bearing: `whatsapp` carries the session
 * id, the API key reference and live health state. Removing it at the type
 * level is what gives the public projection a compile-time reason to drop it.
 */
export interface MarketplaceBusiness extends Omit<Business, 'whatsapp'> {
  tagline: string;
  about: string;
  neighbourhood: string | null;
  addressLine: string | null;
  logoUrl: string | null;
  coverUrl: string | null;
  themeColor: string | null;
  gallery: GalleryImage[];
  /**
   * The BUSINESS's opening envelope — derived from staff rosters, since
   * availability is modelled per person but a customer wants one answer to
   * "are they open Sunday?".
   */
  hours: WorkingHours[];
  rating: number | null;
  reviewCount: number;
  services: PublicService[];
  staff: PublicStaff[];
  reviews: PublicReview[];
}

/** A filter option plus how many published businesses it would match. */
export interface FacetOption {
  value: string;
  label: string;
  count: number;
}

/* ---------------------------------------------------------------------------- */
/*  Web booking                                                                  */
/* ---------------------------------------------------------------------------- */

/** An offered start time. `staffId` is who would do it — always a real person. */
export interface PublicSlot {
  staffId: string;
  startsAt: string;
}

/** A 2-minute soft hold. The token proves ownership when the booking is written. */
export interface PublicHold {
  token: string;
  staffId: string;
  startsAt: string;
  expiresAt: string;
}

export interface PublicBookingRequest {
  serviceId: string;
  /** The staff id the HOLD named — never ANY_STAFF. */
  staffId: string;
  startsAt: string;
  holdToken: string;
  name: string;
  /** Any spelling a customer types; normalised to E.164 server-side. */
  phone: string;
}

/** What the customer is shown after booking. No client id, no internal status history. */
export interface PublicBookingReceipt {
  id: string;
  startsAt: string;
  durationMinutes: number;
  priceMinor: number;
  serviceName: string;
  staffName: string;
  status: string;
}

export type PublicBookingError =
  | 'slot_taken'
  | 'hold_expired'
  | 'invalid_slot'
  | 'outside_hours'
  | 'too_soon'
  | 'beyond_horizon'
  | 'no_staff'
  | 'invalid_phone'
  | 'rate_limited';


