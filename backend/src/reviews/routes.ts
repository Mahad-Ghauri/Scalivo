import express, { type Router } from 'express';
import { z } from 'zod';
import {
  NOTIFICATION_KIND,
  REVIEW_PUBLISH_MIN_RATING,
  type OwnerReview,
  type ReviewSummary,
} from '@scalivo/shared';
import { Notification } from '../models/Notification.js';
import { Review } from '../models/Review.js';
import { requireAuth, requireTenant } from '../auth/middleware.js';
import { param } from '../http/params.js';

/**
 * Reviews as the owner sees them — including the ones nobody else can.
 *
 * This is the other half of SPEC §9.1. A low rating that only raised a push
 * notification is a low rating that is gone the moment the owner swipes it
 * away, so the flagged ones have to live somewhere they can be come back to.
 *
 * Note what this router does NOT have: any way to publish, unpublish or delete
 * a review. The publish decision belongs to the rating, and an owner who could
 * bury a 2-star and promote a 5-star would turn the profile into marketing
 * copy. If a reply-to-review feature ever lands (Phase 3), it adds a field —
 * it does not add a switch.
 */

const listQuery = z.object({
  /** 'flagged' is the working list: the low ratings, newest first. */
  filter: z.enum(['all', 'published', 'flagged']).default('all'),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  skip: z.coerce.number().int().min(0).max(10000).default(0),
});

const FILTERS = {
  all: {},
  published: { published: true },
  flagged: { rating: { $lt: REVIEW_PUBLISH_MIN_RATING } },
} as const;

function toOwnerReview(review: InstanceType<typeof Review>): OwnerReview {
  return {
    id: String(review._id),
    bookingId: review.bookingId ?? null,
    clientId: review.clientId ?? null,
    authorName: review.authorName,
    rating: review.rating,
    comment: review.comment,
    serviceName: review.serviceName ?? null,
    published: review.published,
    flagged: review.rating < REVIEW_PUBLISH_MIN_RATING,
    createdAt: (review.createdAt ?? new Date(0)).toISOString(),
  };
}

export function createReviewRouter(): Router {
  const router = express.Router();
  const guard = [requireAuth, requireTenant()] as const;

  router.get('/:businessId/reviews', ...guard, async (req, res) => {
    const parsed = listQuery.safeParse(req.query);
    if (!parsed.success) {
      res.status(400).json({ error: 'invalid query' });
      return;
    }

    const businessId = param(req, 'businessId');
    const { filter, limit, skip } = parsed.data;

    const [reviews, total] = await Promise.all([
      Review.find({ businessId, ...FILTERS[filter] })
        .sort({ createdAt: -1, _id: -1 })
        .skip(skip)
        .limit(limit),
      Review.countDocuments({ businessId, ...FILTERS[filter] }),
    ]);

    res.json({ reviews: reviews.map(toOwnerReview), total });
  });

  /**
   * Is asking working? — the metric milestone 2.2 is "done when".
   *
   * The denominator is requests SENT, not appointments completed, and the
   * difference is the point. Completed appointments include the customers who
   * opted out and the ones with no WhatsApp address at all; dividing by those
   * would report a capture problem where there is only a reachability one, and
   * the two have entirely different fixes.
   */
  router.get('/:businessId/reviews/summary', ...guard, async (req, res) => {
    const businessId = param(req, 'businessId');

    const [requested, answered, flagged, ratings] = await Promise.all([
      Notification.countDocuments({ businessId, kind: NOTIFICATION_KIND.REVIEW_REQUEST }),
      Review.countDocuments({ businessId, bookingId: { $ne: null } }),
      Review.countDocuments({ businessId, rating: { $lt: REVIEW_PUBLISH_MIN_RATING } }),
      // Every rating the business has, not just the ones this milestone
      // collected: the card says "across every rating", and a profile showing
      // reviews above an average of "—" reads as a bug.
      Review.aggregate<{ _id: null; average: number }>([
        { $match: { businessId } },
        { $group: { _id: null, average: { $avg: '$rating' } } },
      ]),
    ]);

    const average = ratings[0]?.average ?? null;

    const summary: ReviewSummary = {
      requested,
      answered,
      // Guarded rather than reported as 0/0: a business that has asked nobody
      // has no capture rate, and printing 0% would read as a failure.
      captureRate: requested === 0 ? 0 : answered / requested,
      averageRating: average === null ? null : Math.round(average * 10) / 10,
      flagged,
    };

    res.json(summary);
  });

  return router;
}
