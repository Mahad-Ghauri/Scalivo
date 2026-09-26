import { Schema, model } from 'mongoose';
import { CAMPAIGN_AUDIENCE, CAMPAIGN_STATUS } from '@scalivo/shared';

/**
 * One win-back broadcast — SPEC §6.2.
 *
 * This holds the DEFINITION only: who it was aimed at, what it said, and whether
 * it has finished going out. Every per-recipient fact — claimed, accepted,
 * delivered, replied, rebooked — lives on the Notification rows that carry this
 * campaign's id, and the report is an aggregate over them.
 *
 * That split is deliberate, and it is a departure from SPEC §17, which lists
 * `campaigns` among the PostgreSQL tables alongside payments. The reason is
 * FINDING #3: the only evidence a message arrived is a `message.ack` webhook,
 * acks match on `providerMessageId`, and that already updates a Notification. A
 * per-recipient row in Postgres would mean every ack writing to two databases
 * with no transaction across them — and the first partial failure would leave
 * the delivery rate the thesis reports disagreeing with itself. Money goes to
 * Postgres because money needs ACID; a campaign needs one source of truth, and
 * the ack has already chosen where that is.
 *
 * `recipients` is the only count stored here, written once when the audience is
 * claimed. It is the denominator, and it has to survive a client being deleted.
 */
const campaignSchema = new Schema(
  {
    businessId: { type: String, required: true, index: true },

    audience: {
      type: String,
      enum: Object.values(CAMPAIGN_AUDIENCE),
      required: true,
    },

    /**
     * Exactly what was sent, opt-out line included.
     *
     * Stored on the campaign as well as on every recipient's row because the
     * owner's question months later is "what did I say in March?", and a
     * campaign that reached nobody has no recipient row to read it off.
     */
    message: { type: String, required: true },

    status: {
      type: String,
      enum: Object.values(CAMPAIGN_STATUS),
      default: CAMPAIGN_STATUS.SENDING,
    },

    /** How many people it was aimed at, fixed at creation. The denominator. */
    recipients: { type: Number, required: true },

    /** Set when the last recipient has been attempted, or when the owner stopped it. */
    completedAt: { type: Date, default: null },
  },
  { timestamps: true },
);

/** The owner's campaign list, newest first. */
campaignSchema.index({ businessId: 1, createdAt: -1 });

/** The drain pass: which campaigns still owe sends, oldest first so one finishes before the next starts. */
campaignSchema.index({ status: 1, createdAt: 1 });

export const Campaign = model('Campaign', campaignSchema);
