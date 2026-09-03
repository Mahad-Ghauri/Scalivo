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

  // Already answering it — leave the conversation alone.
  if (conversation?.state === CONVERSATION_STATE.AWAITING_RATING) return conversation;

  return {
    ...(conversation ?? { invalidCount: 0 }),
    state: CONVERSATION_STATE.AWAITING_RATING,
    bookingId: pending.bookingId,
    invalidCount: 0,
  };
}
