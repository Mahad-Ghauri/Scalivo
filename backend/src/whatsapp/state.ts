import type { Redis } from 'ioredis';
import type { Conversation } from './fsm/states.js';

/**
 * Where a half-finished booking conversation lives.
 *
 * Redis, not Mongo: this is ephemeral by design. An abandoned conversation must
 * disappear on its own, and a TTL does that without a sweeper job. Nothing here
 * is a record — the moment anything matters it becomes a Booking.
 */

/** docs/fsm-design.md §3. Long enough to survive a customer being interrupted. */
const CONVERSATION_TTL_SECONDS = 30 * 60;

/**
 * Short, because it only spans one message's processing. A lock that outlived a
 * crash would freeze the customer out of their own conversation until it expired.
 */
const LOCK_TTL_SECONDS = 10;

const conversationKey = (businessId: string, clientId: string) =>
  `conv:${businessId}:${clientId}`;

const lockKey = (businessId: string, clientId: string) =>
  `lock:conv:${businessId}:${clientId}`;

export async function readConversation(
  redis: Redis,
  businessId: string,
  clientId: string,
): Promise<Conversation | null> {
  const raw = await redis.get(conversationKey(businessId, clientId));
  if (!raw) return null;

  try {
    return JSON.parse(raw) as Conversation;
  } catch {
    // A payload we cannot parse is a payload from an older shape. Starting the
    // customer over beats crashing on every message they send from now on.
    return null;
  }
}

/** Every write refreshes the TTL — the 30 minutes is idle time, not total time. */
export async function writeConversation(
  redis: Redis,
  businessId: string,
  clientId: string,
  conversation: Conversation,
): Promise<void> {
  await redis.set(
    conversationKey(businessId, clientId),
    JSON.stringify(conversation),
    'EX',
    CONVERSATION_TTL_SECONDS,
  );
}

export async function clearConversation(
  redis: Redis,
  businessId: string,
  clientId: string,
): Promise<void> {
  await redis.del(conversationKey(businessId, clientId));
}

/**
 * Serialise one customer's messages.
 *
 * Two messages sent a second apart otherwise race on the same state: both read
 * SELECTING_SLOT, both pick a slot, both try to hold. SPEC §1.4 asks for this
 * and does not say where it goes — it goes here, around the whole turn.
 *
 * Returns null when someone else holds it. The caller drops the message rather
 * than queueing: a customer who double-taps send meant to send once, and
 * processing the second copy after the first would answer a question they have
 * already moved past.
 */
export async function acquireConversationLock(
  redis: Redis,
  businessId: string,
  clientId: string,
): Promise<(() => Promise<void>) | null> {
  const key = lockKey(businessId, clientId);
  const token = `${process.pid}-${Date.now()}-${Math.random()}`;

  const ok = await redis.set(key, token, 'EX', LOCK_TTL_SECONDS, 'NX');
  if (ok !== 'OK') return null;

  return async () => {
    // Release only our own lock: ours may have expired and been re-acquired,
    // and a blind DEL would then unlock someone else's turn mid-write.
    await redis.eval(
      `if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('DEL', KEYS[1]) end return 0`,
      1,
      key,
      token,
    );
  };
}

/**
 * An outstanding question the customer's next message probably answers.
 *
 * This exists because a bare `4` is ambiguous — a menu pick, or a star rating.
 * State alone cannot resolve it, so an open prompt is recorded separately and
 * the interceptor chain checks it before the FSM runs. See fsm-design.md §6.3.
 */
const pendingPromptKey = (businessId: string, clientId: string) =>
  `prompt:${businessId}:${clientId}`;

export interface PendingPrompt {
  kind: 'rating';
  bookingId: string;
}

export async function readPendingPrompt(
  redis: Redis,
  businessId: string,
  clientId: string,
): Promise<PendingPrompt | null> {
  const raw = await redis.get(pendingPromptKey(businessId, clientId));
  if (!raw) return null;

  try {
    return JSON.parse(raw) as PendingPrompt;
  } catch {
    return null;
  }
}

export async function writePendingPrompt(
  redis: Redis,
  businessId: string,
  clientId: string,
  prompt: PendingPrompt,
  ttlSeconds: number,
): Promise<void> {
  await redis.set(
    pendingPromptKey(businessId, clientId),
    JSON.stringify(prompt),
    'EX',
    ttlSeconds,
  );
}

export async function clearPendingPrompt(
  redis: Redis,
  businessId: string,
  clientId: string,
): Promise<void> {
  await redis.del(pendingPromptKey(businessId, clientId));
}
