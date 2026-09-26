import type { HydratedDocument, InferSchemaType } from 'mongoose';
import {
  BOOKING_STATUS,
  NOTIFICATION_KIND,
  REVIEW_PROMPT_TTL_SECONDS,
  REVIEW_REQUEST_DELAY_MINUTES,
  REVIEW_REQUEST_MAX_LATE_HOURS,
} from '@scalivo/shared';
import { Booking } from '../models/Booking.js';
import { Business } from '../models/Business.js';
import { Notification } from '../models/Notification.js';
import { Review } from '../models/Review.js';
import { Service } from '../models/Service.js';
import { addMinutes } from '../lib/time.js';
import { logger } from '../lib/logger.js';
import * as copy from '../whatsapp/messages.js';
import { writePendingPrompt } from '../whatsapp/state.js';
import { sendTracked, type SendDeps } from '../notifications/send.js';
import { NOT_ELIGIBLE, marketingEligibility } from '../retention/eligibility.js';

/**
 * Asking how it went — SPEC §9.1, once per appointment.
 *
 * A pass rather than a call at the moment the owner taps "Complete", for the
 * same reason reminders are a pass: the request is due at a moment that is not
 * the moment something happened, and a send fired inline from a request handler
 * is a send that is lost whenever the process that owed it restarts.
 *
 * Two bounds define the window, and both earn their place:
 *
 * - **The lower one** (the delay) keeps the question from arriving while the
 *   customer is still at the counter.
 * - **The upper one** (max late) is what stops the first run of this feature —
 *   or the first run after an outage — messaging every customer the business
 *   has ever served. A sudden outbound burst to old contacts is both a bad
 *   experience and the single behaviour most likely to get a WhatsApp number
 *   restricted (NOTES.md, warm-up protocol).
 *
 * Appointments completed before this shipped have no `completedAt` at all, so
 * they fall outside the window by construction rather than by a cutoff date
 * somebody has to remember to remove.
 */

/** Five minutes: the delay is measured in hours, so minute resolution buys nothing. */
const INTERVAL_MS = 5 * 60 * 1000;

type BusinessDoc = HydratedDocument<InferSchemaType<typeof Business.schema>>;

export async function reviewRequestsOnce(deps: SendDeps, now = new Date()): Promise<void> {
  const businesses = await Business.find({});

  for (const business of businesses) {
    try {
      await requestReviewsFor(deps, business, now);
    } catch (err) {
      // One business's bad data must not stop every other business's requests —
      // the same isolation the reminder pass has, for the same reason.
      logger.error({ err, businessId: String(business._id) }, 'review request pass failed');
    }
  }
}

/**
 * One business's due rating requests.
 *
 * Exported for the same reason `remindBusiness` is: driving the global pass in a
 * test against a shared database picks up other suites' bookings mid-assertion,
 * and the failures then look like duplicate sends rather than the parallelism
 * they are.
 */
export async function requestReviewsFor(
  deps: SendDeps,
  business: BusinessDoc,
  now: Date,
): Promise<void> {
  const businessId = String(business._id);

  const dueBefore = addMinutes(now, -REVIEW_REQUEST_DELAY_MINUTES);
  const notBefore = addMinutes(now, -REVIEW_REQUEST_MAX_LATE_HOURS * 60);

  const bookings = await Booking.find({
    businessId,
    status: BOOKING_STATUS.COMPLETED,
    completedAt: { $gte: notBefore, $lte: dueBefore },
  }).sort({ completedAt: 1 });

  if (bookings.length === 0) return;

  const bookingIds = bookings.map((b) => String(b._id));

  /**
   * Which of these have already been asked.
   *
   * Strictly an optimisation, as in the reminder pass — the unique dedupeKey is
   * the real guard and sendTracked handles the collision on its own. Without it
   * every pass would fire a doomed insert for every completed appointment in a
   * two-day window, forever.
   */
  const claimed = new Set(
    (
      await Notification.find({
        businessId,
        kind: NOTIFICATION_KIND.REVIEW_REQUEST,
        bookingId: { $in: bookingIds },
      }).select('dedupeKey')
    ).map((n) => n.dedupeKey),
  );

  /**
   * And which already have a review.
   *
   * Belt and braces against a rating that arrived some other way — a walk-in
   * the owner entered, an import — asking someone to rate what they have
   * already rated.
   */
  const reviewed = new Set(
    (await Review.find({ businessId, bookingId: { $in: bookingIds } }).select('bookingId')).map(
      (r) => r.bookingId,
    ),
  );

  for (const booking of bookings) {
    const bookingId = String(booking._id);
    const dedupeKey = `${bookingId}:review_request`;

    if (claimed.has(dedupeKey) || reviewed.has(bookingId)) continue;

    /**
     * Opt-out is honoured here, unlike for confirmations and reminders.
     *
     * Those are transactional — the customer asked for the appointment, so its
     * reminder is owed regardless. A review request is not owed to anybody: it
     * is the business asking a favour to build its own reputation, which is
     * exactly what `STOP` said no to.
     *
     * Through the shared check, which is a FIX rather than a tidy-up: this used
     * to read `Client.marketingOptOut` — a field on the global person document
     * that nothing has ever written — while STOP writes the per-business flag on
     * ClientProfile. The opt-out looked honoured and was not. Only the quiet
     * period is skipped: a rating request is about an appointment that just
     * happened, and asking a fortnight later is not asking.
     */
    const eligibility = await marketingEligibility(businessId, booking.clientId, now);
    if (!eligibility.ok && eligibility.reason === NOT_ELIGIBLE.OPTED_OUT) continue;

    const service = await Service.findById(booking.serviceId).select('name');

    const sent = await sendTracked(deps, {
      businessId,
      clientId: booking.clientId,
      bookingId,
      kind: NOTIFICATION_KIND.REVIEW_REQUEST,
      dedupeKey,
      text: copy.ratingRequest({
        businessName: business.name,
        serviceName: service?.name ?? 'visit',
      }),
      scheduledFor: addMinutes(booking.completedAt ?? now, REVIEW_REQUEST_DELAY_MINUTES),
    });

    if (!sent.ok) continue;

    /**
     * Arming the prompt is what makes the answer mean a rating.
     *
     * Written even when the send only QUEUED behind an outage: the message is
     * still owed and will drain, and a prompt nobody was asked about costs
     * nothing — it is only ever consulted when a reply arrives, and a reply can
     * only arrive if the question did.
     *
     * Last, and after the claim. Armed first, a crash between the two would
     * leave a customer whose next `4` is read as a rating for a question they
     * were never asked, and who would then be unable to book service 4.
     */
    await writePendingPrompt(
      deps.redis,
      businessId,
      booking.clientId,
      { kind: 'rating', bookingId },
      REVIEW_PROMPT_TTL_SECONDS,
    );

    logger.info({ businessId, bookingId, status: sent.status }, 'rating request sent');
  }
}

/** Start the loop. Returns a stop function, as the reminder and reconcile jobs do. */
export function startReviewRequestJob(deps: SendDeps): () => void {
  const run = () => {
    reviewRequestsOnce(deps).catch((err) => logger.error({ err }, 'review request tick failed'));
  };

  const timer = setInterval(run, INTERVAL_MS);
  // Without unref a finished container lingers on this timer.
  timer.unref();

  return () => clearInterval(timer);
}
