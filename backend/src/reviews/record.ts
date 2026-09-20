import {
  BOOKING_STATUS,
  REVIEW_COMMENT_MAX_LENGTH,
  REVIEW_PUBLISH_MIN_RATING,
} from '@scalivo/shared';
import { Booking } from '../models/Booking.js';
import { Business } from '../models/Business.js';
import { Client } from '../models/Client.js';
import { Review } from '../models/Review.js';
import { Service } from '../models/Service.js';
import { PUSH_CHANNEL, pushToOwners } from '../push/fcm.js';
import { isDuplicateKey } from '../lib/mongo.js';
import { logger } from '../lib/logger.js';

/**
 * Turning a customer's `4` into a review — SPEC §9.2.
 *
 * Three rules, and the order matters:
 *
 * 1. **A review is tied to a completed booking, always.** Not "usually" — the
 *    only way into this function is a rating request that was sent for one, and
 *    the booking is re-checked here rather than trusted from the conversation.
 *    A review system anyone can post to is a review system nobody believes, and
 *    the profile is a public surface with an incentive attached.
 *
 * 2. **One review per appointment.** Enforced by the unique index on
 *    `bookingId`, not by looking first: the customer who replies `5` twice in
 *    quick succession is two concurrent webhook deliveries, and check-then-write
 *    loses that race the same way it loses every other one in this codebase.
 *
 * 3. **The publish decision is taken here, once.** `published` is written from
 *    the rating at the moment it arrives, so the public read path never has to
 *    re-derive it — and because that path filters on the rating too, a wrong
 *    flag still cannot leak a bad visit onto a profile.
 */

export interface Rating {
  businessId: string;
  clientId: string;
  bookingId: string;
  rating: number;
}

export type RatingResult =
  | { ok: true; reviewId: string; published: boolean; alreadyRated: boolean }
  /** The booking vanished, belongs to someone else, or was never completed. */
  | { ok: false; reason: 'no_completed_booking' };

/** First name only. The profile shows it to strangers; the phone number is ours. */
function authorNameOf(displayName: string | null | undefined): string {
  const first = displayName?.trim().split(/\s+/)[0];
  return first && first.length > 0 ? first : 'A customer';
}

export async function recordRating(input: Rating): Promise<RatingResult> {
  const { businessId, clientId, bookingId, rating } = input;

  // Scoped by business AND client: the conversation already knows both, and a
  // booking id from the wrong tenant must not be ratable even if one leaked
  // into a pending prompt.
  const booking = await Booking.findOne({
    _id: bookingId,
    businessId,
    clientId,
    status: BOOKING_STATUS.COMPLETED,
  });

  if (!booking) return { ok: false, reason: 'no_completed_booking' };

  const [client, service] = await Promise.all([
    Client.findById(clientId).select('displayName'),
    Service.findById(booking.serviceId).select('name'),
  ]);

  const published = rating >= REVIEW_PUBLISH_MIN_RATING;

  try {
    const review = await Review.create({
      businessId,
      bookingId,
      clientId,
      authorName: authorNameOf(client?.displayName),
      rating,
      serviceName: service?.name ?? null,
      published,
    });

    logger.info({ businessId, bookingId, rating, published }, 'review recorded');

    // Fire-and-forget, deliberately: the review is written and the customer has
    // been thanked. A push that fails must not turn a recorded rating into an
    // error the FSM reports back to them.
    if (!published) {
      void flagToOwner(businessId, {
        rating,
        authorName: authorNameOf(client?.displayName),
        serviceName: service?.name ?? null,
      });
    }

    return { ok: true, reviewId: String(review._id), published, alreadyRated: false };
  } catch (err) {
    if (!isDuplicateKey(err)) throw err;

    // Already rated. Not an error: the second `5` is the same person answering
    // the same question, and the honest response is the same thank-you.
    const existing = await Review.findOne({ bookingId });
    if (!existing) throw err;

    return {
      ok: true,
      reviewId: String(existing._id),
      published: existing.published,
      alreadyRated: true,
    };
  }
}

/**
 * The private half of SPEC §9.1 — the owner hears it before a stranger does.
 *
 * On the BOOKINGS channel rather than SESSION_HEALTH. An unhappy customer is
 * important and not an emergency, and an alarm channel that also carries
 * important-but-not-urgent news stops being an alarm channel.
 */
async function flagToOwner(
  businessId: string,
  details: { rating: number; authorName: string; serviceName: string | null },
): Promise<void> {
  const business = await Business.findById(businessId).select('name');

  await pushToOwners(businessId, {
    title: `${business?.name ?? 'Your business'} — a customer wasn't happy`,
    body:
      `${details.authorName} rated ${details.serviceName ?? 'their appointment'} ` +
      `${details.rating}/5. It has not been published — worth a call.`,
    channel: PUSH_CHANNEL.BOOKINGS,
    // No `route`: the Flutter app has no reviews screen yet, and a route it
    // ignores is a promise the notification does not keep. The flagged list
    // lives on the web dashboard — see reviews/routes.ts.
  }).catch((err) => logger.error({ err, businessId }, 'could not flag a low rating to the owner'));
}

/**
 * The optional written comment, attached after the fact.
 *
 * Only ever reaches a review that is already published, because only the 4–5
 * path asks for one — so this never has to decide whether a comment makes a
 * private review public. It cannot.
 */
export async function attachComment(
  businessId: string,
  bookingId: string,
  comment: string,
): Promise<void> {
  const trimmed = comment.trim().slice(0, REVIEW_COMMENT_MAX_LENGTH);
  if (!trimmed) return;

  await Review.updateOne({ bookingId, businessId, published: true }, { $set: { comment: trimmed } });
  logger.info({ businessId, bookingId }, 'review comment attached');
}
