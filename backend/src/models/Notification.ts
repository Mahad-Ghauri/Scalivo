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

    /**
     * The appointment this is about — absent for marketing.
     *
     * Required until retention (§6) shipped, and it could not stay that way: a
     * rebooking nudge exists precisely BECAUSE there is no appointment, and a
     * broadcast is about a person. Optional rather than a second collection,
     * because everything else on this row — the dedupe claim, the delivery
     * status, the ack that moves it — is identical for both, and splitting them
     * would mean two answers to "did this customer ever hear from us".
     */
    bookingId: { type: String, default: null },

    /**
     * The broadcast this send belongs to (§6.2).
     *
     * Present only on CAMPAIGN rows, and it is what makes a campaign's outcome a
     * query over these rows rather than a set of counters that drift: delivered
     * is an ack, replied and rebooked are stamped below, and none of it has to
     * be aggregated at send time and hoped to be right later.
     */
    campaignId: { type: String, default: null },

    kind: { type: String, enum: Object.values(NOTIFICATION_KIND), required: true },

    /**
     * The claim. `<bookingId>:confirmation`, `<bookingId>:reminder:1440`,
     * `nudge:<clientId>:<lastVisitDay>`, `campaign:<campaignId>:<clientId>`.
     *
     * Built from the thing itself rather than from a timestamp, so that
     * re-running a tick, restarting the process, or changing the schedule cannot
     * manufacture a second identity for the same message. The nudge key is keyed
     * on the visit they are lapsing FROM, which is what makes it one nudge per
     * lapse instead of one per day for as long as they stay away.
     */
    dedupeKey: { type: String, required: true, unique: true },

    /** The LID or phone the message was addressed to, as resolved at send time. */
    to: { type: String, default: null },

    /**
     * Had this business never reached this person before? (§6.5, FINDING #3.)
     *
     * Recorded at claim time on marketing sends, because it is unrecoverable
     * afterwards — the moment the message is delivered, the contact is no longer
     * cold, and the one number an owner needs ("how many of those 40 had never
     * messaged me?") could never be reconstructed. It is also what the stricter
     * daily cap counts, and the honest explanation for a campaign whose delivery
     * rate is poor.
     */
    coldContact: { type: Boolean, default: false },

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
    /** Held while one caller is sending, so two concurrent drains cannot both send it. */
    sendingUntil: { type: Date, default: null },

    /**
     * Attribution for a marketing message (§6.3), stamped when the thing
     * happens rather than inferred when the report is read.
     *
     * Both are written once and never moved — the first reply and the first
     * booking inside the attribution window are the ones that belong to this
     * message. Computing them at read time was the alternative and it is worse
     * in the way that matters: the window is measured from the send, so a report
     * run six months later would have to reconstruct what "within two weeks"
     * meant then, and would quietly change its own history.
     */
    repliedAt: { type: Date, default: null },
    rebookedBookingId: { type: String, default: null },
  },
  { timestamps: true },
);

/** The ack path: a webhook arrives with a provider id and nothing else to match on. */
notificationSchema.index({ providerMessageId: 1 }, { sparse: true });

/** The retry pass: everything still owed for one business, oldest first. */
notificationSchema.index({ businessId: 1, status: 1, scheduledFor: 1 });

/** Reading a booking's message history, for the owner's timeline and for tests. */
notificationSchema.index({ bookingId: 1, kind: 1 });

/**
 * Two retention reads, both hot enough to earn an index.
 *
 * The first is the attribution write on every inbound message and every booking:
 * "has this client had a marketing message lately?" Unindexed it would scan a
 * business's whole message history on each customer reply.
 *
 * The second is a campaign's report and its drain pass, which both work through
 * one campaign's recipients.
 */
notificationSchema.index({ businessId: 1, clientId: 1, kind: 1, scheduledFor: -1 });
notificationSchema.index({ campaignId: 1, status: 1 }, { sparse: true });

export const Notification = model('Notification', notificationSchema);
