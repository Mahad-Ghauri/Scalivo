import type { FlowOpener } from '@scalivo/shared';
import type { TimeWindow } from './intent.js';

/**
 * The conversation state machine's vocabulary. See docs/fsm-design.md §4.
 *
 * Deliberately backend-only, unlike BOOKING_STATUS and SESSION_STATUS: no client
 * ever reads a conversation state, and putting it in the shared contract would
 * publish an internal detail the app would then be tempted to branch on.
 */
export const CONVERSATION_STATE = {
  /** Transient. Never persisted — it decides the opening message and moves on. */
  GREETING: 'greeting',
  SELECTING_SERVICE: 'selecting_service',
  SELECTING_STAFF: 'selecting_staff',
  SELECTING_DATE: 'selecting_date',
  SELECTING_SLOT: 'selecting_slot',
  CONFIRMING: 'confirming',
  /**
   * Reachable only once a payment provider exists (Phase 2, SPEC §12). Entering
   * it now would strand the customer in a state whose only exit is a payment
   * webhook nothing sends — so Phase 1 books deposit-required services normally
   * and leaves the deposit unpaid. See machine.ts.
   */
  AWAITING_DEPOSIT: 'awaiting_deposit',
  AWAITING_RATING: 'awaiting_rating',
  /**
   * Asked only after a 4 or 5, and only ever entered from AWAITING_RATING.
   *
   * It has to be its own state rather than a flag on the last one, because the
   * reply is free text: anything the customer types here is the comment,
   * including a bare number. Reading `5` as another rating would overwrite the
   * review they just left with the same review.
   */
  AWAITING_REVIEW_COMMENT: 'awaiting_review_comment',
  /**
   * Picking WHICH existing booking. Shared by cancel and reschedule because the
   * question is identical — `intent` carries which one asked, so a customer who
   * typed CANCEL is not silently walked into rescheduling.
   */
  SELECTING_BOOKING: 'selecting_booking',
  RESCHEDULING: 'rescheduling',
  CANCELLING: 'cancelling',
  /**
   * Straight after a cancel: "book the same thing on another day?" Carries the
   * cancelled booking's serviceId/staffId, never its bookingId — a yes starts a
   * new booking, and a bookingId would make commit() treat it as a reschedule.
   */
  OFFERING_REBOOK: 'offering_rebook',
  HELP: 'help',
} as const;

export type ConversationState = (typeof CONVERSATION_STATE)[keyof typeof CONVERSATION_STATE];

/**
 * IDLE is the ABSENCE of a conversation key, not a stored value — so a customer
 * who returns after the TTL gets a clean restart rather than a stale half-booking.
 */
export interface Conversation {
  state: ConversationState;

  serviceId?: string;
  /** Absent means "no preference" — a real choice, not a missing one. */
  staffId?: string;
  /** Business-local calendar date, 'YYYY-MM-DD'. */
  date?: string;

  /**
   * A time of day the customer asked for in words — "saturday afternoon".
   *
   * A collected selection like any other, and stored for the same reason `date` is:
   * it has to survive the questions still to be asked. A customer who says
   * "afternoon" and is then asked which staff member must not lose the afternoon on
   * the way through, and one who replies NO at the confirmation should see other
   * afternoon times rather than the whole day again.
   *
   * Set only by the free-text path (fsm/intent.ts). The menu never collects one:
   * there is no numbered list of times of day, and adding one would trade the step
   * this is meant to save for a step of its own.
   */
  within?: TimeWindow;
  /** UTC instant, ISO. */
  slotStart?: string;
  /** Proves ownership of the soft hold at confirm time. */
  holdToken?: string;
  /** The staff member the hold actually landed on, once ANY_STAFF is resolved. */
  heldStaffId?: string;

  /**
   * What the numbered list the customer is looking at actually maps to.
   *
   * Storing the ids rather than re-deriving the list on their reply is what
   * makes "2" mean the same thing it meant when it was printed. Re-querying
   * would silently re-map every option if a service were added, a staff member
   * deactivated, or — far more likely — a slot taken between the two messages.
   */
  options?: string[];

  /** Resets to 0 on every valid input. At 3 the customer is offered a human. */
  invalidCount: number;

  /**
   * An existing booking in play: the one being cancelled, or the one being
   * moved. On the reschedule path its presence is what tells the commit step to
   * release the old slot once the new booking exists.
   */
  bookingId?: string;

  /** Which command opened the booking picker. Only set alongside SELECTING_BOOKING. */
  intent?: 'cancel' | 'reschedule';

  /**
   * Whether this conversation began with a numbered menu or a parsed sentence.
   *
   * Absent means the menu — the overwhelming majority, and the default the recorder
   * applies, so nothing has to set it for the common case.
   *
   * It lives here because the FlowRun row is written turn by turn, and the fact that
   * needs recording was established on the FIRST turn. Redis holds it for the 30
   * minutes the conversation lasts; the durable copy goes on the row. That split is
   * milestone 3.9's whole lesson applied one milestone later: state that only ever
   * holds the present cannot answer a question about the past.
   */
  opener?: FlowOpener;
}

/** docs/fsm-design.md §4.2 — enough to absorb typos, few enough to escape a loop. */
export const MAX_INVALID_INPUT = 3;
