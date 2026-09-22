/**
 * The Grow module — SPEC §10. Where customers come from, and how far they get.
 *
 * The funnel is the web's: a profile view, a booking form started, a booking
 * made. WhatsApp bookings have no "view" to count — the customer just messages
 * — so they are reported beside the funnel rather than folded into it.
 */

/**
 * Where a visit came from. Closed on purpose: `?ref=` is typed by strangers, and
 * an open set would let anyone invent a channel in an owner's report.
 *
 *   qr          the counter poster
 *   instagram   the share link, posted to Instagram (or a visit it referred)
 *   facebook    the share link, posted to Facebook
 *   whatsapp    the share link, sent in a chat or a status
 *   link        the plain share link, copied anywhere else
 *   marketplace found on Scalivo itself — search, the home page, "nearby"
 *   direct      none of the above: typed, bookmarked, or referrer unknown
 */
export const GROW_CHANNELS = ['qr', 'instagram', 'facebook', 'whatsapp', 'link', 'marketplace', 'direct'] as const;
export type GrowChannel = (typeof GROW_CHANNELS)[number];

export const isGrowChannel = (value: unknown): value is GrowChannel =>
  typeof value === 'string' && (GROW_CHANNELS as readonly string[]).includes(value);

/** What the profile page reports. A booking is not an event — the booking itself is the record. */
export const FUNNEL_EVENTS = ['view', 'start'] as const;
export type FunnelEvent = (typeof FUNNEL_EVENTS)[number];

/** One tap boosts for this long. Long enough to matter, short enough that nobody forgets it is on. */
export const BOOST_DAYS = 7;

export interface FunnelStages {
  /** Distinct visitors who opened the profile, per day. */
  views: number;
  /** Of those, how many picked a service in the booking form. */
  starts: number;
  /** Web bookings made. A deposit booking counts once it is paid, not while it is held. */
  bookings: number;
}

export interface FunnelReport {
  /** Business-local, both inclusive. */
  range: { from: string; to: string };
  totals: FunnelStages;
  /** Every channel with any activity, busiest first. */
  byChannel: (FunnelStages & { channel: GrowChannel })[];
  /** WhatsApp bookings in the same range — the other front door, which has no funnel to draw. */
  whatsappBookings: number;
}

export interface BoostState {
  active: boolean;
  /** ISO. Null when no boost has ever run, or the last one has been stopped. */
  until: string | null;
}
