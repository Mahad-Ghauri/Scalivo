import type { Redis } from 'ioredis';
import {
  BOOKING_STATUS,
  DELIVERY_STATUS,
  NOTIFICATION_KIND,
  isMarketing,
  type DeliveryStatus,
  type MessagingProvider,
  type NotificationKind,
} from '@scalivo/shared';
import { Booking } from '../models/Booking.js';
import { Notification } from '../models/Notification.js';
import { logger } from '../lib/logger.js';
import { isDuplicateKey } from '../lib/mongo.js';
import { optedOut } from '../retention/eligibility.js';
import { resolveAddress, ADDRESS_MISSING } from './address.js';

/**
 * Sending something the customer did not ask for, exactly once, and knowing
 * whether it arrived.
 *
 * Three rules, in the order they matter:
 *
 * 1. **Claim before sending.** The Notification row goes in first, with a unique
 *    dedupeKey. If the insert collides, somebody else already owns this message
 *    and we stop — no send, no second row. Sending first and recording after
 *    would leave a window in which a crash loses the record but not the message,
 *    and the next pass would send it again.
 *
 * 2. **A send failure is not a lost message.** The row stays QUEUED and
 *    `retryPending` picks it up — on the next reminder tick, or immediately when
 *    Session Health sees the session come back. This is the half of an outage
 *    the owner never sees and cares about most.
 *
 * 3. **Accepted is not delivered.** A successful send writes ACCEPTED and
 *    nothing stronger (FINDING #3). Only a message.ack moves it, in ack.ts.
 *
 * The Redis outbound queue is deliberately NOT used here. It is the right home
 * for a conversational reply, which is worthless an hour later and costs nothing
 * to lose — but a reminder is owed for days, and "did this customer ever hear
 * from us?" is a question the evaluation chapter has to answer months later. Two
 * queues for two lifetimes, rather than one queue that serves neither well.
 */

export interface SendDeps {
  redis: Redis;
  provider: MessagingProvider;
}

export interface NotificationSpec {
  businessId: string;
  clientId: string;
  /** Omitted by marketing: a nudge exists BECAUSE there is no appointment. */
  bookingId?: string | null;
  /** Set only by a broadcast, so its outcome is a query over these rows. */
  campaignId?: string | null;
  /**
   * Marketing only: had this business never reached this person before?
   *
   * Passed in rather than resolved here, because the caller has just worked it
   * out for the whole audience in two queries and this path would have to ask
   * again per recipient.
   */
  coldContact?: boolean;
  kind: NotificationKind;
  /** The idempotency claim. See the Notification model. */
  dedupeKey: string;
  text: string;
  /** When it was meant to go out. `now` for a confirmation. */
  scheduledFor: Date;
}

export type SendOutcome =
  | { ok: true; status: DeliveryStatus; notificationId: string }
  | { ok: false; reason: 'already_claimed' | 'no_address' | 'no_session' };

/** Attempts that mean "the session is down", not "this message is bad". */
const MAX_ATTEMPTS = 8;

export async function sendTracked(deps: SendDeps, spec: NotificationSpec): Promise<SendOutcome> {
  let claim;
  try {
    claim = await Notification.create({
      businessId: spec.businessId,
      clientId: spec.clientId,
      bookingId: spec.bookingId ?? null,
      campaignId: spec.campaignId ?? null,
      coldContact: spec.coldContact ?? false,
      kind: spec.kind,
      dedupeKey: spec.dedupeKey,
      text: spec.text,
      scheduledFor: spec.scheduledFor,
      status: DELIVERY_STATUS.QUEUED,
    });
  } catch (err) {
    if (isDuplicateKey(err)) {
      logger.debug({ dedupeKey: spec.dedupeKey }, 'notification already claimed');
      return { ok: false, reason: 'already_claimed' };
    }
    throw err;
  }

  const status = await deliver(deps, String(claim._id));

  if (status === DELIVERY_STATUS.SKIPPED) {
    // The row survives as the record that we decided not to send, which is the
    // difference between a customer who was not reachable and one we forgot.
    return { ok: false, reason: 'no_address' };
  }

  return { ok: true, status, notificationId: String(claim._id) };
}

/**
 * One attempt at one claimed notification.
 *
 * Split out from sendTracked because the retry pass needs exactly this and
 * nothing else — it already has the row, and re-claiming would collide with
 * itself.
 */
async function deliver(deps: SendDeps, notificationId: string): Promise<DeliveryStatus> {
  const notification = await Notification.findById(notificationId);
  if (!notification) return DELIVERY_STATUS.SKIPPED;

  /**
   * The appointment may have gone away while the message waited.
   *
   * This is not a hypothetical: the session drops on Friday evening, a customer
   * cancels over the phone on Saturday morning, the session returns on Saturday
   * afternoon, and without this check the drain cheerfully reminds them about an
   * appointment they cancelled. Checked on every attempt rather than only on
   * retry, because the first attempt can also follow a claim by some seconds.
   *
   * Skipped entirely for marketing, which has no booking to have gone away.
   */
  if (notification.bookingId) {
    const booking = await Booking.findById(notification.bookingId).select('status');
    if (!booking || !stillOwed(notification.kind, booking.status)) {
      await settle(notification._id, DELIVERY_STATUS.SKIPPED, {
        lastError: booking ? `booking is ${booking.status}` : 'booking no longer exists',
      });
      logger.info(
        { notificationId, bookingId: notification.bookingId },
        'skipped a notification for a booking that is over',
      );
      return DELIVERY_STATUS.SKIPPED;
    }
  }

  /**
   * The consent may have gone away while the message waited — the marketing
   * equivalent of the check above, and the last line of the opt-out guarantee.
   *
   * Every marketing path checks eligibility before claiming, so this only fires
   * in the gap between the claim and the send: a broadcast that takes an hour to
   * drain, or one whose messages queued behind an outage for a day. That gap is
   * exactly where a `STOP` sent in reply to the campaign's first recipients
   * lands, and honouring it a message too late is not honouring it.
   */
  if (isMarketing(notification.kind) && (await optedOut(notification.businessId, notification.clientId))) {
    await settle(notification._id, DELIVERY_STATUS.SKIPPED, { lastError: 'opted out' });
    logger.info({ notificationId, kind: notification.kind }, 'skipped marketing to an opted-out client');
    return DELIVERY_STATUS.SKIPPED;
  }

  const resolved = await resolveAddress(notification.businessId, notification.clientId);

  if (!resolved.ok) {
    // A client with no WhatsApp address will never acquire one by waiting, so
    // this is settled rather than retried. A missing SESSION, by contrast, is
    // exactly what an outage looks like — that stays queued.
    if (resolved.reason === ADDRESS_MISSING.NO_ADDRESS) {
      await settle(notification._id, DELIVERY_STATUS.SKIPPED, { lastError: 'no whatsapp address' });
      logger.info({ notificationId }, 'client has no WhatsApp address — not notifying');
      return DELIVERY_STATUS.SKIPPED;
    }

    await bumpAttempt(notification._id, 'no linked session');
    return DELIVERY_STATUS.QUEUED;
  }

  const { sessionId, to } = resolved.address;

  try {
    const sent = await deps.provider.sendText(sessionId, to, notification.text);

    // ACCEPTED, never delivered. The ack is what moves this on, and it may never
    // come — which is the fact this whole subsystem exists to make visible.
    await Notification.updateOne(
      { _id: notification._id, status: DELIVERY_STATUS.QUEUED },
      {
        $set: {
          status: DELIVERY_STATUS.ACCEPTED,
          providerMessageId: sent.providerMessageId,
          sessionId,
          to,
          acceptedAt: sent.acceptedAt,
          lastError: null,
        },
        $inc: { attempts: 1 },
      },
    );

    logger.info(
      { notificationId, kind: notification.kind, providerMessageId: sent.providerMessageId },
      'notification accepted by the provider',
    );
    return DELIVERY_STATUS.ACCEPTED;
  } catch (err) {
    const attempts = (notification.attempts ?? 0) + 1;

    if (attempts >= MAX_ATTEMPTS) {
      await settle(notification._id, DELIVERY_STATUS.FAILED, { lastError: String(err) });
      logger.error({ err, notificationId, attempts }, 'giving up on a notification');
      return DELIVERY_STATUS.FAILED;
    }

    await bumpAttempt(notification._id, String(err));
    logger.warn({ err, notificationId, attempts }, 'notification send failed — staying queued');
    return DELIVERY_STATUS.QUEUED;
  }
}

/**
 * Everything still owed for one business, oldest first.
 *
 * Called from two places on purpose, mirroring the Session Health split that
 * already exists: the `ready` webhook drains within a second of recovery, and
 * the reminder tick is the safety net for the recovery whose webhook never
 * arrived. Either alone leaves a gap; both together are cheap.
 *
 * Order is preserved and a failure STOPS the pass rather than working down the
 * list. If the session dropped again mid-drain, pushing on would burn every
 * message's attempt counter against a session that is not there.
 */
export async function retryPending(
  deps: SendDeps,
  businessId: string,
): Promise<{ sent: number; remaining: number }> {
  const pending = await Notification.find({ businessId, status: DELIVERY_STATUS.QUEUED })
    .sort({ scheduledFor: 1 })
    .select('_id')
    .limit(200);

  let sent = 0;
  for (const row of pending) {
    const status = await deliver(deps, String(row._id));
    if (status === DELIVERY_STATUS.ACCEPTED) sent += 1;
    else if (status === DELIVERY_STATUS.QUEUED) break;
  }

  const remaining = await Notification.countDocuments({
    businessId,
    status: DELIVERY_STATUS.QUEUED,
  });

  if (sent > 0) logger.info({ businessId, sent, remaining }, 'drained pending notifications');
  return { sent, remaining };
}

/** Record a decision not to send, or a final failure. Neither is retried. */
async function settle(
  id: unknown,
  status: DeliveryStatus,
  fields: { lastError: string },
): Promise<void> {
  await Notification.updateOne(
    { _id: id, status: DELIVERY_STATUS.QUEUED },
    { $set: { status, ...fields } },
  );
}

async function bumpAttempt(id: unknown, lastError: string): Promise<void> {
  await Notification.updateOne({ _id: id }, { $set: { lastError }, $inc: { attempts: 1 } });
}

/**
 * Is this message still owed, given what became of the appointment?
 *
 * The question used to be simply "is the booking over?", and that was right
 * while every tracked notification was something sent BEFORE the appointment.
 * A review request is the first one sent after it, so for that kind a completed
 * booking is the precondition rather than a reason to drop the message.
 *
 * Cancelled and no-show still are — there is nothing to rate — which is the
 * case that matters: a customer who never turned up must not be asked how it
 * went, and a request claimed before the owner marked them absent would
 * otherwise drain into exactly that.
 */
function stillOwed(kind: string, status: string | undefined): boolean {
  if (kind === NOTIFICATION_KIND.REVIEW_REQUEST) return status === BOOKING_STATUS.COMPLETED;
  // A follow-up hangs off the visit that happened.
  if (kind === NOTIFICATION_KIND.FOLLOW_UP) return status === BOOKING_STATUS.COMPLETED;
  // The payment link matters only while the booking is still waiting for it:
  // one queued during an outage and sent after the customer paid would ask
  // them to pay twice.
  if (kind === NOTIFICATION_KIND.DEPOSIT_REQUEST) return status === BOOKING_STATUS.AWAITING_DEPOSIT;
  if (kind === NOTIFICATION_KIND.DEPOSIT_EXPIRED) return status === BOOKING_STATUS.CANCELLED;
  // Nothing confirms or reminds an appointment that is not yet secured.
  if (status === BOOKING_STATUS.AWAITING_DEPOSIT) return false;

  return (
    status !== BOOKING_STATUS.CANCELLED &&
    status !== BOOKING_STATUS.COMPLETED &&
    status !== BOOKING_STATUS.NO_SHOW
  );
}
