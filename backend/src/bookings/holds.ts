import { randomUUID } from 'node:crypto';
import type { Redis } from 'ioredis';

/**
 * Soft holds: "someone is typing, don't offer this slot to anyone else."
 *
 * These are ADVISORY. They are not the double-booking guard — the occupancy
 * grid's unique index inside the booking transaction is, and it stays correct
 * even if Redis is empty, stale, or wiped. What holds buy is politeness: two
 * customers do not get offered the same 4:00 and one of them told "gone" after
 * choosing it.
 *
 * Everything here is Lua rather than a sequence of commands, because a hold
 * spans EVERY increment a service covers and partial acquisition is worse than
 * none. Acquiring 4:00 and 4:15 then losing 4:30 would leave two increments
 * blocked for a booking that will never happen — and two clients racing that way
 * can each strand the other. One script, all keys, all or nothing.
 */

/** A hold key is per staff member per grid point — the same shape as an occupancy row. */
function holdKey(businessId: string, staffId: string, slotStart: Date): string {
  return `hold:${businessId}:${staffId}:${slotStart.getTime()}`;
}

export function holdKeys(businessId: string, staffId: string, slots: Date[]): string[] {
  return slots.map((slot) => holdKey(businessId, staffId, slot));
}

/**
 * Set every key only if NONE of them exists.
 *
 * SET NX per key would be atomic per key and racy across the set; this checks
 * the whole span first, inside Redis's single-threaded execution, so no other
 * client can interleave between the check and the writes.
 */
const ACQUIRE = `
for i = 1, #KEYS do
  if redis.call('EXISTS', KEYS[i]) == 1 then return 0 end
end
for i = 1, #KEYS do
  redis.call('SET', KEYS[i], ARGV[1], 'EX', ARGV[2])
end
return 1
`;

/**
 * Delete only what we still own.
 *
 * The token check is the whole point: our hold may have expired and been
 * re-acquired by someone else between our last read and this call. A blind DEL
 * would hand that person's slot away.
 */
const RELEASE = `
local freed = 0
for i = 1, #KEYS do
  if redis.call('GET', KEYS[i]) == ARGV[1] then
    redis.call('DEL', KEYS[i])
    freed = freed + 1
  end
end
return freed
`;

/** Every key must still carry our token — a hold that partly expired is expired. */
const VERIFY = `
for i = 1, #KEYS do
  if redis.call('GET', KEYS[i]) ~= ARGV[1] then return 0 end
end
return 1
`;

export interface HoldHandle {
  token: string;
  staffId: string;
  keys: string[];
  expiresAt: Date;
}

/**
 * Try to hold a span for one staff member. Returns null when any increment is
 * already held — a normal outcome, not an error.
 */
export async function acquireHold(
  redis: Redis,
  businessId: string,
  staffId: string,
  slots: Date[],
  ttlSeconds: number,
): Promise<HoldHandle | null> {
  if (slots.length === 0) throw new Error('a hold must cover at least one slot');

  const token = randomUUID();
  const keys = holdKeys(businessId, staffId, slots);
  const ok = await redis.eval(ACQUIRE, keys.length, ...keys, token, String(ttlSeconds));

  if (ok !== 1) return null;
  return { token, staffId, keys, expiresAt: new Date(Date.now() + ttlSeconds * 1000) };
}

export async function releaseHold(redis: Redis, handle: HoldHandle): Promise<number> {
  return (await redis.eval(
    RELEASE,
    handle.keys.length,
    ...handle.keys,
    handle.token,
  )) as number;
}

export async function verifyHold(
  redis: Redis,
  businessId: string,
  staffId: string,
  slots: Date[],
  token: string,
): Promise<boolean> {
  const keys = holdKeys(businessId, staffId, slots);
  return (await redis.eval(VERIFY, keys.length, ...keys, token)) === 1;
}

/**
 * Which of these grid points are held by anyone, for availability to subtract.
 *
 * MGET over the exact candidate keys rather than KEYS/SCAN with a pattern:
 * availability already knows every grid point it is considering, and a pattern
 * scan on a shared Redis is O(keyspace) — fine on a dev box, a stall in
 * production.
 */
export async function heldSlots(
  redis: Redis,
  businessId: string,
  staffId: string,
  slots: Date[],
): Promise<Set<number>> {
  if (slots.length === 0) return new Set();

  const values = await redis.mget(...holdKeys(businessId, staffId, slots));
  const held = new Set<number>();
  values.forEach((value, i) => {
    if (value !== null) held.add(slots[i]!.getTime());
  });
  return held;
}
