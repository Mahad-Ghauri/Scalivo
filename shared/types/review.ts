/**
 * Review collection — SPEC §9, milestone 2.2.
 *
 * The rule the whole feature turns on: **a rating of 4 or 5 is published, and
 * anything lower goes privately to the owner.** That is not a filter applied on
 * the way out; it is a decision taken once, when the rating arrives, and written
 * into the review. The public read path then checks BOTH the flag and the
 * rating, so a mis-set flag on a 2-star review still never reaches a stranger.
 *
 * The point of asking privately is that the owner hears about a bad visit before
 * a stranger does, and can do something about it — which is only true if the
 * request goes out while the visit is still fresh, and only ever once.
 */

/**
 * The rating at which a review becomes public.
 *
 * 4, not 3. A middling score published alongside the good ones reads as faint
 * praise, and SPEC §9.1 puts the whole 1–3 band on the private path precisely
 * because those are the visits worth a phone call rather than a listing.
 */
export const REVIEW_PUBLISH_MIN_RATING = 4;

/**
 * How long after an appointment is completed the request goes out.
 *
 * Not immediately: "how was it?" arriving while the customer is still at the
 * counter paying is asking someone to rate a thing they have not finished.
 * Two hours is long enough to have left and short enough that the visit is
 * still what they would describe.
 */
export const REVIEW_REQUEST_DELAY_MINUTES = 120;

/**
 * How stale a completed appointment may be and still earn a request.
 *
 * Bounds the catch-up pass. Without it, the first run after any outage — or
 * after this feature ships at all — would message every customer the business
 * has ever served, which is both a bad experience and the kind of sudden
 * outbound burst that gets a WhatsApp number restricted.
 */
export const REVIEW_REQUEST_MAX_LATE_HOURS = 48;

/**
 * How long a sent request stays answerable.
 *
 * This is the TTL on the pending prompt, and it is what makes a bare `4` mean a
 * rating instead of a menu pick. Long enough to cover a customer who reads
 * WhatsApp at the weekend; short enough that a stray number three weeks later
 * is read as the booking it probably is.
 */
export const REVIEW_PROMPT_TTL_SECONDS = 3 * 24 * 60 * 60;

/** Long enough for a real sentence, short enough not to be an essay on a profile. */
export const REVIEW_COMMENT_MAX_LENGTH = 500;

/**
 * Below this, the reply is treated as "no comment" rather than published.
 *
 * The case this exists for: a customer who has just rated 5 and been asked for
 * a comment types `hi`, because what they actually want is to book again. The
 * literal reading publishes "hi" on the business's public profile forever. A
 * reply this short is far more likely to be someone starting a new conversation
 * than a review worth showing a stranger, so it ends the exchange politely
 * instead — the rating, which is the part that matters, is already saved.
 */
export const REVIEW_COMMENT_MIN_LENGTH = 8;

/**
 * A review as its own business sees it — including the ones nobody else can.
 *
 * Distinct from PublicReview for one reason: this shape carries `published` and
 * the low ratings, and the public shape structurally cannot. Keeping them apart
 * means an owner endpoint can never be wired to a public one by accident.
 */
export interface OwnerReview {
  id: string;
  bookingId: string | null;
  clientId: string | null;
  authorName: string;
  rating: number;
  comment: string;
  serviceName: string | null;
  published: boolean;
  /** True for the ratings SPEC §9.1 routes to the owner instead of the profile. */
  flagged: boolean;
  createdAt: string;
}

/**
 * Whether asking is working — the metric milestone 2.2 is "done when".
 *
 * `captureRate` is answered over requested, so it measures the thing that can
 * actually be improved (the copy, the delay, the channel) rather than how many
 * appointments the business had.
 */
export interface ReviewSummary {
  /** Rating requests that have gone out, however they were answered. */
  requested: number;
  /** Requests that came back with a rating. */
  answered: number;
  /** answered / requested, 0 when nothing has been asked yet. */
  captureRate: number;
  /** Over answered reviews, all ratings — not just the published ones. */
  averageRating: number | null;
  /** Low ratings the owner has not seen the customer about yet. */
  flagged: number;
}
