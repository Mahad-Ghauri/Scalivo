import type { Redis } from 'ioredis';
import type { SessionStatus } from '@scalivo/shared';
import { Business } from '../models/Business.js';
import { PUSH_CHANNEL, pushToOwners } from '../push/fcm.js';
import { logger } from '../lib/logger.js';

/**
 * Telling the owner their WhatsApp is down.
 *
 * **Never over WhatsApp.** That is the channel that just broke; a message sent
 * through it either fails or, worse, silently succeeds into a session nobody is
 * reading. The escalation ladder is deliberately out-of-band.
 *
 * The ladder, in order: FCM push → email → the dashboard banner. The banner is
 * not really a tier — it is always true, because the app polls
 * `/businesses/:id/whatsapp` and reads the same status this writes. It is the
 * floor under the other two.
 */

/**
 * An outage that lasts an afternoon must not push every 30 seconds.
 *
 * This is the difference between an alert someone acts on and one they swipe
 * away. The reconcile job runs every 5 minutes and would otherwise re-alarm on
 * every pass, since the condition is still true.
 */
const ALERT_COOLDOWN_SECONDS = 30 * 60;

const cooldownKey = (businessId: string) => `alert:session:${businessId}`;

export interface SessionAlert {
  businessId: string;
  businessName: string;
  status: SessionStatus;
  /** Messages stuck behind the outage — makes the cost concrete for the owner. */
  queuedMessages: number;
}

export async function raiseSessionAlarm(redis: Redis, alert: SessionAlert): Promise<void> {
  // SET NX is the cooldown: the first alarm wins, later ones are no-ops until
  // it expires. Doing this in Redis rather than a timestamp comparison keeps it
  // correct when two workers observe the same drop at once.
  const first = await redis.set(cooldownKey(alert.businessId), '1', 'EX', ALERT_COOLDOWN_SECONDS, 'NX');
  if (first !== 'OK') return;

  logger.error(
    { businessId: alert.businessId, status: alert.status, queued: alert.queuedMessages },
    'SESSION DOWN — customers cannot book',
  );

  await Business.updateOne(
    { _id: alert.businessId },
    { $set: { 'whatsapp.lastAlertAt': new Date() } },
  );

  // Tier 1 — push. Returns 0 when nothing reached a device.
  const delivered = await pushToOwners(alert.businessId, {
    title: 'WhatsApp disconnected',
    body:
      alert.queuedMessages > 0
        ? `${alert.businessName} can't receive bookings. ${alert.queuedMessages} message(s) waiting. Tap to reconnect.`
        : `${alert.businessName} can't receive bookings right now. Tap to reconnect.`,
    channel: PUSH_CHANNEL.SESSION_HEALTH,
    // Straight to the QR screen. Landing on Home and making a worried owner
    // hunt for the fix wastes the minutes the alert just bought.
    route: '/qr',
  });

  if (delivered > 0) return;

  // Tier 2 — email. No provider is configured yet, and pretending otherwise
  // would be worse than saying so: this logs at error level so the gap is
  // visible in exactly the situation where it matters.
  logger.error(
    { businessId: alert.businessId },
    'push reached no devices and no email provider is configured — ' +
      'the dashboard banner is the only remaining signal',
  );
}

/** Recovery clears the cooldown, so a second outage alerts immediately. */
export async function clearSessionAlarm(redis: Redis, businessId: string): Promise<void> {
  await redis.del(cooldownKey(businessId));
}
