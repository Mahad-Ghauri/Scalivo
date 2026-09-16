import { Schema, model } from 'mongoose';
import { DELIVERY_STATUS, NOTIFICATION_KIND } from '@scalivo/shared';

/**
 * One row per message the system owes a customer.
 *
 * The row is written BEFORE the send, not after, and `dedupeKey` is unique. That
 * inversion is the whole design: the insert is the claim, so a scheduler tick
 * that overlaps its predecessor, a retry pass that races the tick, and a second
 * process someone starts by accident all collide on the index instead of sending
 * the customer the same reminder twice.
 *
 * It is the same rule the booking grid runs on — never check-then-write, let the
 * database arbitrate — applied to messages instead of slots. A `find` for "have
 * we already sent this?" followed by a send has a window between them, and that
 * window is where the duplicate lives.
 *
 * Deliberately NOT stored in Redis alongside the outbound queue. A reminder is
 * owed for days, its absence is only visible long after the fact, and the
 * question "did the customer ever actually hear from us?" is one the evaluation
 * chapter has to be able to ask months later.
 */
const notificationSchema = new Schema(
  {
    businessId: { type: String, required: true, index: true },
    clientId: { type: String, required: true },
    bookingId: { type: String, required: true },

    kind: { type: String, enum: Object.values(NOTIFICATION_KIND), required: true },

    /**
     * The claim. `<bookingId>:confirmation`, `<bookingId>:reminder:1440`.
     *
     * Built from the booking and the lead time rather than from a timestamp, so
     * that re-running a tick, restarting the process, or changing the schedule
     * cannot manufacture a second identity for the same message.
     */
    dedupeKey: { type: String, required: true, unique: true },

    /** The LID or phone the message was addressed to, as resolved at send time. */
    to: { type: String, default: null },

    /**
     * What was said — or would have been.
     *
     * Deliberately not `required`. A reminder whose moment passed while we were
     * down is claimed as SKIPPED without ever being composed, and there is no
     * honest text to put on it: writing the message we would have sent would
     * suggest it went out. Empty means nothing was ever said.
     */
    text: { type: String, default: '' },

    status: {
      type: String,
      enum: Object.values(DELIVERY_STATUS),
      default: DELIVERY_STATUS.QUEUED,
    },

    /**
     * What the provider called the message. The ONLY handle an inbound
     * message.ack carries, so an ack for a message we never recorded is an ack
     * we cannot attribute — which is the normal case for conversational replies
     * and is why this is sparse rather than required.
     */
    providerMessageId: { type: String, default: null },
    sessionId: { type: String, default: null },

    /** When it was meant to go. For a confirmation, when the booking was made. */
    scheduledFor: { type: Date, required: true },

    acceptedAt: { type: Date, default: null },
    /** Set only by an ack. A null here after the event is a message that vanished. */
    deliveredAt: { type: Date, default: null },

    attempts: { type: Number, default: 0 },
    lastError: { type: String, default: null },
  },
  { timestamps: true },
);

/** The ack path: a webhook arrives with a provider id and nothing else to match on. */
notificationSchema.index({ providerMessageId: 1 }, { sparse: true });

/** The retry pass: everything still owed for one business, oldest first. */
notificationSchema.index({ businessId: 1, status: 1, scheduledFor: 1 });

/** Reading a booking's message history, for the owner's timeline and for tests. */
notificationSchema.index({ bookingId: 1, kind: 1 });

export const Notification = model('Notification', notificationSchema);
