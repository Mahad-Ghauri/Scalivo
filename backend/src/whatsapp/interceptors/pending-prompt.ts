import type { Redis } from 'ioredis';
import { readPendingPrompt } from '../state.js';
import { CONVERSATION_STATE, type Conversation } from '../fsm/states.js';

/**
 * An open question the customer's reply probably answers.
 *
 * This exists for one concrete failure. After a visit the business asks "how was
 * it? reply 1–5". The customer replies `4`. But `4` is also a menu pick — and if
 * they happen to have an active booking conversation, or start one, the FSM will
 * read it as "book service #4".
 *
 * State cannot resolve that: both readings are legitimate for the state the
 * conversation is in. So the outstanding prompt is recorded separately and
 * consulted BEFORE the FSM, and an open rating request wins.
 *
 * The consequence of getting this wrong is subtle and nasty: shipping review
 * collection would quietly start breaking bookings, in production, for the
 * customers who engage most.
 */
export async function applyPendingPrompt(
  redis: Redis,
  businessId: string,
  clientId: string,
  conversation: Conversation | null,
): Promise<Conversation | null> {
  const pending = await readPendingPrompt(redis, businessId, clientId);
  if (!pending) return conversation;

  /**
   * Already in the middle of answering one — leave the conversation alone.
   *
   * AWAITING_REVIEW_COMMENT is here for a case that really happens: two
   * appointments completed the same afternoon, so a second rating request goes
   * out while the customer is still typing the comment for the first. Without
   * this, their sentence would be read as a rating for the other booking.
   */
  if (
    conversation?.state === CONVERSATION_STATE.AWAITING_RATING ||
    conversation?.state === CONVERSATION_STATE.AWAITING_REVIEW_COMMENT
  ) {
    return conversation;
  }

  /**
   * A reminder yields to a conversation already in progress.
   *
   * Unlike a rating, a reminder arrives unprompted by anything the customer is
   * doing — often while they are mid-way through booking something else. Their
   * "1" there answers the menu on screen, not a message that landed above it.
   * The prompt is left armed (the router clears it only when it was applied),
   * so the same "1" confirms the appointment once the flow is over.
   */
  if (pending.kind === 'reminder' && conversation) return conversation;

  return {
    ...(conversation ?? { invalidCount: 0 }),
    state:
      pending.kind === 'reminder'
        ? CONVERSATION_STATE.AWAITING_REMINDER_REPLY
        : CONVERSATION_STATE.AWAITING_RATING,
    bookingId: pending.bookingId,
    invalidCount: 0,
  };
}
