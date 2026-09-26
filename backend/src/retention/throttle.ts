import type { Redis } from 'ioredis';
import { BROADCAST_GAP_SECONDS } from '@scalivo/shared';
import { logger } from '../lib/logger.js';

/**
 * One gate per WhatsApp number, holding every unsolicited send apart by a random
 * interval — SPEC §6.2, "throttled (randomised delays, daily caps)".
 *
 * A gate rather than a sleep. The obvious implementation of "wait 90 seconds
 * between sends" is to wait inside the loop, and it is wrong in three ways at
 * once: it holds a request open for an hour, it loses the rest of the campaign
 * when the process restarts, and a second pass running concurrently waits in
 * parallel and sends in unison. A key with a TTL has none of those properties —
 * whoever comes next either gets the slot or comes back later, and a restart
 * costs nothing because the state is in Redis rather than on a stack.
 *
 * Shared between the nudges and the broadcasts deliberately: the thing being
 * spaced out is not a campaign, it is the NUMBER. Two independent throttles
 * would produce two well-behaved streams arriving together.
 *
 * Randomised because a fixed interval is itself a signature. A message every
 * 90.0 seconds for an hour is not something a person types.
 */

const key = (businessId: string) => `marketing:gate:${businessId}`;

/**
 * Take the next send slot, or decline.
 *
 * FAILS CLOSED on a Redis error, which is the opposite of how the funnel beacons
 * treat the same failure and is right for the opposite reason: there, losing a
 * count is the worst case; here, losing the spacing risks the number every
 * booking for this business depends on. A nudge that waits until Redis is back
 * costs nobody anything.
 */
export async function claimSendSlot(redis: Redis, businessId: string): Promise<boolean> {
  const { min, max } = BROADCAST_GAP_SECONDS;
  const seconds = min + Math.floor(Math.random() * (max - min + 1));

  try {
    return (await redis.set(key(businessId), '1', 'EX', seconds, 'NX')) === 'OK';
  } catch (err) {
    logger.error({ err, businessId }, 'marketing throttle unavailable — not sending');
    return false;
  }
}

/** Tests and the "send now" path: forget the current gap. Never called in anger. */
export async function clearSendSlot(redis: Redis, businessId: string): Promise<void> {
  await redis.del(key(businessId));
}
