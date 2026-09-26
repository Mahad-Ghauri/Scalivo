import {
  BROADCAST_DAILY_CAP,
  COLD_CONTACT_DAILY_CAP,
  MARKETING_KINDS,
} from '@scalivo/shared';
import { Notification } from '../models/Notification.js';
import { toBusinessLocal } from '../lib/time.js';

/**
 * How many unsolicited messages this number has already sent today, and how many
 * it may still send — SPEC §6.2, "throttled (randomised delays, daily caps)".
 *
 * The cap is per NUMBER per day, not per campaign. That is the whole point: two
 * campaigns and the automatic nudges all draw on one allowance, because the
 * thing being protected is the one WhatsApp account every booking for this
 * business depends on. A per-campaign cap would be three caps, which is no cap.
 *
 * Counted from the claim (`createdAt`), not from a successful send. A claimed
 * message is owed and will drain when the session returns, so treating a queued
 * one as free allowance would let an outage's backlog and a fresh campaign land
 * together the moment the number came back — the exact burst the cap exists to
 * prevent.
 *
 * The day is the BUSINESS's day. A cap that rolls over at UTC midnight rolls
 * over at 5am in Karachi, in the middle of the night that follows the afternoon
 * it was meant to limit.
 */

export interface DailyRoom {
  total: number;
  cold: number;
}

/** The start of the business's current local day, as an instant. */
export function localDayStart(timezone: string, now: Date): Date {
  return toBusinessLocal(now, timezone).startOf('day').toUTC().toJSDate();
}

export async function marketingRoomToday(
  businessId: string,
  timezone: string,
  now = new Date(),
): Promise<DailyRoom> {
  const since = localDayStart(timezone, now);
  const base = {
    businessId,
    kind: { $in: MARKETING_KINDS },
    createdAt: { $gte: since },
  } as const;

  const [total, cold] = await Promise.all([
    Notification.countDocuments(base),
    Notification.countDocuments({ ...base, coldContact: true }),
  ]);

  return {
    total: Math.max(0, BROADCAST_DAILY_CAP - total),
    cold: Math.max(0, COLD_CONTACT_DAILY_CAP - cold),
  };
}
