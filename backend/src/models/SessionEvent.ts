import { Schema, model } from 'mongoose';
import { SESSION_INTENT, SESSION_STATUS } from '@scalivo/shared';

/**
 * One row per session status TRANSITION. Append-only; nothing updates a row
 * after it is written.
 *
 * This exists because `business.whatsapp.status` is a single field that gets
 * overwritten. It answers "is the session up right now?" and destroys the
 * answer to "how much of last month was it up?" on the way past. Session uptime
 * is the evaluation chapter's headline metric and the one genuine contribution
 * the thesis claims, and it cannot be reconstructed from a field that only ever
 * holds the present.
 *
 * The transitions were reaching pino and nowhere else. Pino writes to stdout,
 * stdout is not collected anywhere, and a backend restart took the history with
 * it. So a tenant could run for months and produce no uptime data at all — the
 * exact failure this collection is here to prevent, written down because it is
 * invisible until the moment someone asks for the number.
 *
 * ## Transitions, not observations
 *
 * A row is written only when the status actually CHANGES. The reconcile job
 * polls every five minutes and would otherwise write 288 identical `ready` rows
 * a day per business, which is not data, and computing uptime from it would
 * mean de-duplicating the series first.
 *
 * Writing only on change also dedupes SPIKE FINDING #2 for free. An unlink
 * emits `session.qr` and then `session.status: qr_ready` about 4ms later. The
 * first writes a transition to `qr_ready`; the second finds the stored status
 * already `qr_ready` and writes nothing. One outage, one row.
 *
 * ## Reading it
 *
 * Consecutive rows are the interval boundaries: a business was up from a row
 * with `status: 'ready'` until whatever row came next, and is still up now if
 * `ready` is the newest. The final open interval runs to the time of asking,
 * which means uptime is only computable against a clock — there is no row that
 * says "still up", and inventing one on a timer would be manufacturing evidence.
 */
const sessionEventSchema = new Schema(
  {
    businessId: { type: String, required: true },

    /**
     * The gateway's session id, denormalised deliberately.
     *
     * A business that re-links gets a NEW session, and the old id is gone from
     * the business document the moment it does. Without this, two separate
     * sessions' histories would be indistinguishable, and a re-link would read
     * as one continuous session that mysteriously restarted.
     */
    sessionId: { type: String, required: true },

    status: { type: String, enum: Object.values(SESSION_STATUS), required: true },

    /**
     * What it was before. Null only on the first row for a session.
     *
     * Stored rather than derived by looking at the previous row, so that a
     * single row is self-describing and a gap in the series — a delivery we
     * never received — is visible as a mismatch instead of silently closing
     * over the hole.
     */
    previousStatus: { type: String, default: null },

    /**
     * What we believed should be happening when this arrived.
     *
     * This is what separates an outage from an owner deliberately linking a
     * number: `qr_ready` under LIVE intent is a session that died, and
     * `qr_ready` under LINKING is a human holding a phone. Uptime must not
     * count the second as downtime, and nothing else in the row can tell them
     * apart.
     */
    intent: {
      type: String,
      enum: Object.values(SESSION_INTENT),
      required: true,
    },

    /**
     * Which path noticed. `webhook` is the live stream; `reconcile` means the
     * 5-minute poll found a status the stream never delivered.
     *
     * Worth keeping separate: a run where most transitions arrive via
     * `reconcile` is a run where the webhook stream is unreliable, and that is a
     * finding about the system rather than about the business's uptime.
     */
    source: { type: String, enum: ['webhook', 'reconcile'], required: true },

    /**
     * When it happened, which is NOT when the row was written.
     *
     * Webhook envelopes carry the provider's own timestamp and can arrive late
     * or be retried — delivery is at-least-once (FINDING #6). Using insertion
     * time would fold our own delivery lag into the business's downtime.
     */
    occurredAt: { type: Date, required: true },
  },
  // `createdAt` is kept as the audit trail of when we learned it; `updatedAt`
  // would be meaningless on a collection nothing updates.
  { timestamps: { createdAt: true, updatedAt: false } },
);

// The only query this collection has: one business's history over a window, in
// order. Compound rather than two single-field indexes, because reading it any
// other way — unordered, or across every tenant at once — is not a question
// uptime asks.
sessionEventSchema.index({ businessId: 1, occurredAt: 1 });

export const SessionEvent = model('SessionEvent', sessionEventSchema);
