import { BOOST_DAYS, type BoostState } from '@scalivo/shared';
import { Business } from '../models/Business.js';
import { logger } from '../lib/logger.js';

/**
 * The listing boost (SPEC §10): one tap, and the business sorts first among
 * search results it already matches, labelled "Featured", for BOOST_DAYS.
 *
 * Free for now. Charging for it is a payments question (§12) for once there is
 * a marketplace worth paying to be at the top of; the mechanism does not change.
 */

export function boostState(business: { boost?: { until?: Date | null } | null }, now = new Date()): BoostState {
  const until = business.boost?.until ?? null;
  return { active: Boolean(until && until > now), until: until ? until.toISOString() : null };
}

export type BoostFailure = 'not_found' | 'not_published';

/**
 * Start a boost, or restart one that is running — a second tap resets the
 * clock to a full BOOST_DAYS rather than stacking, so there is never a boost
 * running months ahead that the owner has lost track of.
 */
export async function startBoost(
  businessId: string,
  now = new Date(),
): Promise<{ ok: true; boost: BoostState } | { ok: false; reason: BoostFailure }> {
  const until = new Date(now.getTime() + BOOST_DAYS * 24 * 60 * 60 * 1000);

  // Published is the condition of the write itself, not a check before it: a
  // business unpublished between the two would otherwise be boosted while
  // invisible, and sort first the moment it came back.
  const updated = await Business.findOneAndUpdate(
    { _id: businessId, published: true },
    { $set: { 'boost.until': until } },
    { new: true },
  ).select('boost');

  if (!updated) {
    const exists = await Business.exists({ _id: businessId });
    return { ok: false, reason: exists ? 'not_published' : 'not_found' };
  }

  logger.info({ businessId, until }, 'listing boost started');
  return { ok: true, boost: boostState(updated, now) };
}

export async function stopBoost(businessId: string, now = new Date()): Promise<BoostState | null> {
  const updated = await Business.findByIdAndUpdate(
    businessId,
    { $set: { 'boost.until': null } },
    { new: true },
  ).select('boost');
  if (!updated) return null;

  logger.info({ businessId }, 'listing boost stopped');
  return boostState(updated, now);
}
