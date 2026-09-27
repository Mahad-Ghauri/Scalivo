import { Schema, model } from 'mongoose';
import { FLOW_KIND, FLOW_OPENER, FLOW_OUTCOME } from '@scalivo/shared';

/**
 * One row per WhatsApp booking conversation — started, however it ended.
 *
 * This collection exists because the booking-completion metric could not be
 * computed without it, and could never have been computed afterwards. The
 * conversation lives in Redis on a 30-minute TTL and is deleted the moment it
 * finishes (whatsapp/state.ts, which says so explicitly: "Nothing here is a
 * record"). That is the right design for STATE — an abandoned conversation should
 * disappear on its own — but it means a customer who gets three questions in and
 * walks away leaves nothing at all. The successes become Bookings; the failures
 * become nothing, and "% of started flows that reach confirmation" measured over
 * the survivors alone is 100% by construction.
 *
 * It is the same mistake SessionEvent was built to correct, in a different place: a
 * value that only ever holds the present destroys the history on the way past. The
 * transitions were reaching pino, pino writes to stdout, and stdout is not
 * collected — so a tenant could run for a year and produce no funnel at all.
 *
 * ## One row per flow, not per message
 *
 * A message log was the obvious alternative and SPEC §17 still lists one. It is
 * the wrong instrument here: the funnel would become a reconstruction from message
 * text, which is fragile in exactly the way the thesis cannot afford, and it would
 * store every customer's conversation verbatim to answer a question about counts.
 * This row holds the shape of the attempt and none of its content.
 *
 * ## Nothing here is written twice
 *
 * The recorder runs inside the per-conversation Redis lock every inbound message
 * already holds (router.ts stage 3), so one customer cannot have two flows opened
 * concurrently and no unique index is needed to say so. Without that lock this
 * would want one, and the claim-before-write pattern the rest of the system uses.
 */
const flowRunSchema = new Schema(
  {
    businessId: { type: String, required: true },
    clientId: { type: String, required: true },

    startedAt: { type: Date, required: true },

    /**
     * The last transition, which is the clock abandonment is judged against.
     *
     * An open row that has been silent longer than the conversation TTL is an
     * abandoned flow — derived when the report is read, never written. There is no
     * instant at which a customer announces they have given up, and a sweeper job
     * stamping one would be recording an event that did not happen.
     */
    lastStepAt: { type: Date, required: true },

    /**
     * Where the customer entered, and where they got to.
     *
     * Both, because they are different questions and the second is meaningless
     * without the first. Flows do not all start at the service menu — accepting
     * the rebook offer after a cancellation drops straight into date selection —
     * so a drop-off count at `selecting_date` that ignored entry would read those
     * as customers who abandoned at a step they were never shown.
     *
     * Stored as the FSM's own state strings. Deliberately not validated against an
     * enum here: CONVERSATION_STATE is backend-only and adding a state should not
     * require a migration on a metrics collection.
     */
    startedState: { type: String, required: true },
    furthestState: { type: String, required: true },

    kind: { type: String, enum: Object.values(FLOW_KIND), default: FLOW_KIND.NEW },

    /**
     * Menu or sentence — milestone 3.2's comparison, and the reason it can be made.
     *
     * Defaulted rather than required, so every row written before free-text parsing
     * existed reads as what it was: a menu flow. That makes the menu's baseline the
     * whole history rather than only the period after the split was introduced, which
     * is the difference between comparing against months of traffic and comparing
     * against whatever arrived this week.
     */
    opener: { type: String, enum: Object.values(FLOW_OPENER), default: FLOW_OPENER.MENU },

    /** Transitions taken. "How many messages does booking cost?" is a usability finding. */
    steps: { type: Number, default: 1 },

    /**
     * How many times the menu failed to understand them.
     *
     * The one number that measures the numbered list itself. A flow that completes
     * after four misreads completed, and counting it purely as a success would
     * hide the cost of getting there.
     */
    invalidInputs: { type: Number, default: 0 },

    /**
     * Null while the flow is live — and null forever on an abandoned one.
     *
     * See FLOW_OUTCOME: `abandoned` is not a stored value. A null here is read as
     * "still open" inside the TTL and "abandoned" outside it, which means the same
     * row answers both questions correctly as time passes without anything
     * rewriting it.
     */
    outcome: { type: String, enum: [...Object.values(FLOW_OUTCOME), null], default: null },

    /** The appointment it produced. Set only alongside outcome BOOKED. */
    bookingId: { type: String, default: null },
  },
  { timestamps: { createdAt: true, updatedAt: false } },
);

/**
 * The recorder's lookup: this customer's open flow, if they have a live one.
 *
 * Also the report's range scan over one business, which reads the same prefix.
 */
flowRunSchema.index({ businessId: 1, clientId: 1, lastStepAt: -1 });

/** The report: one business's flows over a window. */
flowRunSchema.index({ businessId: 1, startedAt: 1 });

export const FlowRun = model('FlowRun', flowRunSchema);
