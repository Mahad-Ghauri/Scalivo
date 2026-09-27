import {
  FLOW_KIND,
  FLOW_OPENER,
  FLOW_OUTCOME,
  type FlowKind,
  type FlowOpener,
  type FlowOutcome,
} from '@scalivo/shared';
import { FlowRun } from '../models/FlowRun.js';
import { logger } from '../lib/logger.js';
import { CONVERSATION_STATE, MAX_INVALID_INPUT, type Conversation } from './fsm/states.js';

/**
 * Recording what happened to a booking conversation — milestone 3.9.
 *
 * One call per inbound message, from both paths that can move a customer: the
 * global-command interceptor and the FSM. Both, because a customer who types
 * CANCEL halfway through booking never reaches the FSM, and a flow left open by
 * that would later be read as an abandonment — turning the opt-out machinery
 * working correctly into evidence that the booking flow fails.
 *
 * The contract is uniform and deliberately dumb: here is the state before, here is
 * the state after, here is a booking id if one committed. This file decides what
 * that means for the funnel. Nothing above it needs to know the funnel exists.
 *
 * **Never throws.** Every caller is on the path that answers a real customer
 * mid-booking. A metrics write failing is a hole in a chart; letting it propagate
 * would drop the customer's message, and the point of measuring the booking flow
 * is not to break it.
 */

/**
 * How deep into booking each state is.
 *
 * A rank rather than a step count, because the path is not linear: a business with
 * one staff member skips staff selection entirely, so "third message" and "third
 * step of the funnel" are different numbers. Only the deepest rank reached is kept,
 * so a customer who goes back a step does not lose the progress they made.
 */
const BOOKING_DEPTH: Partial<Record<string, number>> = {
  [CONVERSATION_STATE.SELECTING_SERVICE]: 1,
  [CONVERSATION_STATE.SELECTING_STAFF]: 2,
  [CONVERSATION_STATE.SELECTING_DATE]: 3,
  [CONVERSATION_STATE.SELECTING_SLOT]: 4,
  [CONVERSATION_STATE.CONFIRMING]: 5,
  // Unreachable until a payment provider exists (machine.ts), and listed anyway:
  // the day it becomes reachable, a customer waiting on a deposit would otherwise
  // be in a non-booking state and this would close their flow as a deliberate exit.
  [CONVERSATION_STATE.AWAITING_DEPOSIT]: 6,
};

/**
 * How long an open flow stays claimable.
 *
 * The conversation's own TTL, and it has to be the same number: past it Redis has
 * dropped the state, so the customer's next message starts a genuinely new
 * conversation and must not attach itself to the one they abandoned last week. The
 * reader uses the same constant to decide what counts as abandoned, which is what
 * keeps the two halves from disagreeing about when a flow ended.
 */
export const FLOW_STALE_MS = 30 * 60 * 1000;

const depthOf = (state: string | null): number => (state === null ? 0 : (BOOKING_DEPTH[state] ?? 0));

const isBookingState = (state: string | null): boolean => depthOf(state) > 0;

export interface FlowStep {
  businessId: string;
  clientId: string;
  /** The conversation as it was read, before this message was handled. */
  before: Conversation | null;
  /** What the turn decided. Null means the conversation was cleared. */
  after: Conversation | null;
  /** Set when this turn committed an appointment. */
  bookingId?: string | undefined;
  at: Date;
}

export async function recordFlowStep(step: FlowStep): Promise<void> {
  try {
    await record(step);
  } catch (err) {
    logger.error(
      { err, businessId: step.businessId, clientId: step.clientId },
      'could not record a booking flow step — the completion funnel now has a gap',
    );
  }
}

async function record(step: FlowStep): Promise<void> {
  const { businessId, clientId, before, after, bookingId, at } = step;

  const open = await FlowRun.findOne({
    businessId,
    clientId,
    outcome: null,
    lastStepAt: { $gte: new Date(at.getTime() - FLOW_STALE_MS) },
  }).sort({ lastStepAt: -1 });

  const fromState = before?.state ?? null;
  const toState = after?.state ?? null;

  // A booking committed. This is the only outcome worth defending against a
  // missing row: if the flow was never opened (its first write failed), the
  // numerator would silently lose a success while the denominator kept the
  // attempt, and the funnel would read worse than the system performed.
  if (bookingId) {
    if (!open) {
      await FlowRun.create({
        businessId,
        clientId,
        startedAt: at,
        lastStepAt: at,
        startedState: fromState ?? CONVERSATION_STATE.CONFIRMING,
        furthestState: fromState ?? CONVERSATION_STATE.CONFIRMING,
        kind: kindOf(before),
        opener: openerOf(before, after),
        steps: 1,
        outcome: FLOW_OUTCOME.BOOKED,
        bookingId,
      });
      return;
    }

    await close(open, FLOW_OUTCOME.BOOKED, at, fromState, before, after, bookingId);
    return;
  }

  // Still booking: deepen the existing flow, or open one.
  if (isBookingState(toState)) {
    if (!open) {
      await FlowRun.create({
        businessId,
        clientId,
        startedAt: at,
        lastStepAt: at,
        startedState: toState,
        furthestState: toState,
        kind: kindOf(after),
        opener: openerOf(before, after),
        steps: 1,
        invalidInputs: 0,
      });
      return;
    }

    await FlowRun.updateOne({ _id: open._id }, {
      $set: {
        lastStepAt: at,
        // Deepest reached, never the latest: a customer who backs out of slot
        // selection to change service has still got as far as slot selection, and
        // overwriting it would move their drop-off point backwards.
        furthestState: depthOf(toState) > depthOf(open.furthestState) ? toState : open.furthestState,
        // A reschedule can only be recognised once the booking being moved is in
        // play, which may be a turn or two after the flow opened.
        ...(kindOf(after) === FLOW_KIND.RESCHEDULE ? { kind: FLOW_KIND.RESCHEDULE } : {}),
      },
      $inc: { steps: 1, invalidInputs: misreads(before, after) },
    });
    return;
  }

  // Off the booking path. Nothing to record unless a flow was in progress.
  if (!open) return;

  await close(open, outcomeOf(after), at, fromState, before, after, null);
}

/**
 * Why the flow ended, for a customer who is no longer in a booking state.
 *
 * The distinction this draws is the whole reason ESCALATED exists: both endings put
 * the customer in HELP, and the invalid counter is the only thing that says which
 * one happened. It is readable now and gone in a minute, when Redis drops the
 * conversation — so it is decided here rather than left to the report.
 */
function outcomeOf(after: Conversation | null): FlowOutcome {
  if (after?.state === CONVERSATION_STATE.HELP && after.invalidCount >= MAX_INVALID_INPUT) {
    return FLOW_OUTCOME.ESCALATED;
  }
  return FLOW_OUTCOME.LEFT;
}

/** A booking already in play means this flow is moving one, not making one. */
const kindOf = (conversation: Conversation | null): FlowKind =>
  conversation?.bookingId ? FLOW_KIND.RESCHEDULE : FLOW_KIND.NEW;

/**
 * Menu or sentence, read off the conversation the FSM just wrote.
 *
 * Only ever consulted when a row is CREATED, because entry is a fact about the
 * flow's first turn and cannot change afterwards. `before` is checked as well as
 * `after` for the one case where it matters: the turn that commits a booking clears
 * the conversation, so a flow whose opening write failed and whose first surviving
 * record is its success would otherwise lose the attribution with the state.
 *
 * Defaults to the menu, which is both the common case and the truth for every row
 * written before parsing existed.
 */
const openerOf = (before: Conversation | null, after: Conversation | null): FlowOpener =>
  after?.opener ?? before?.opener ?? FLOW_OPENER.MENU;

/**
 * Did the menu fail to understand this message?
 *
 * Read as an INCREASE rather than from the final value, because the counter resets
 * to zero on every valid input (machine.ts). Taking the value as it stands would
 * record nothing for a customer who fumbled twice and then succeeded — which is
 * exactly the customer worth counting.
 */
const misreads = (before: Conversation | null, after: Conversation | null): number =>
  (after?.invalidCount ?? 0) > (before?.invalidCount ?? 0) ? 1 : 0;

async function close(
  open: { _id: unknown; furthestState: string },
  outcome: FlowOutcome,
  at: Date,
  fromState: string | null,
  before: Conversation | null,
  after: Conversation | null,
  bookingId: string | null,
): Promise<void> {
  // The state they were in when it ended still counts as reached: a customer who
  // confirms from CONFIRMING got to CONFIRMING, and the final turn's `after` is
  // already off the booking path.
  const deepest =
    depthOf(fromState) > depthOf(open.furthestState) ? (fromState as string) : open.furthestState;

  await FlowRun.updateOne({ _id: open._id }, {
    $set: { lastStepAt: at, furthestState: deepest, outcome, bookingId },
    $inc: { steps: 1, invalidInputs: misreads(before, after) },
  });
}
