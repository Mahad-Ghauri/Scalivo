import { readFileSync } from 'node:fs';
import { type App, cert, initializeApp } from 'firebase-admin/app';
import { type BatchResponse, getMessaging } from 'firebase-admin/messaging';
import { env } from '../config/env.js';
import { User } from '../models/User.js';
import { logger } from '../lib/logger.js';

/**
 * Push notifications to the owner's phone.
 *
 * Two things worth knowing before reading further:
 *
 * 1. **This needs a SERVICE ACCOUNT key, not `google-services.json`.** The app's
 *    config file identifies the client; sending requires a server credential
 *    from Firebase Console → Project Settings → Service accounts → Generate new
 *    private key. Without it every call here degrades to a log line rather than
 *    throwing, so the rest of Session Health works and lights up when the
 *    credential appears.
 *
 * 2. **The channel id is not cosmetic.** Android lets a person mute a channel,
 *    not a notification. Bookings and outage alerts are separate channels so an
 *    owner can silence the 11pm booking ping and still be unable to silence
 *    "WhatsApp is down". See app/lib/push/push_service.dart.
 */

export const PUSH_CHANNEL = {
  BOOKINGS: 'scalivo.bookings',
  SESSION_HEALTH: 'scalivo.session_health',
  /**
   * The agent's briefings (SPEC §11). A third channel for the same reason there
   * is a second one: an owner who does not want a summary every morning must be
   * able to silence that WITHOUT silencing the outage alarm. One channel for both
   * would make the daily briefing the thing that hides "customers cannot book".
   */
  BRIEFING: 'scalivo.briefings',
} as const;

let app: App | null = null;
let initialised = false;

/**
 * Absent credentials are a configuration state, not an error — so this reports
 * once and then stays quiet rather than logging on every alert.
 */
function firebase(): App | null {
  if (initialised) return app;
  initialised = true;

  const raw = env.FIREBASE_SERVICE_ACCOUNT;
  if (!raw) {
    logger.warn(
      'FIREBASE_SERVICE_ACCOUNT is not set — push notifications will be logged, not sent. ' +
        'Generate a service account key in Firebase Console → Project Settings → Service accounts.',
    );
    return null;
  }

  try {
    // Accepts either the JSON itself or a path to it: the JSON suits a hosted
    // env var, the path suits a local file that must never reach git.
    const json = raw.trimStart().startsWith('{') ? raw : readFileSync(raw, 'utf8');
    app = initializeApp({ credential: cert(JSON.parse(json)) });
    logger.info('firebase admin initialised — push notifications are live');
    return app;
  } catch (err) {
    logger.error({ err }, 'could not initialise firebase admin — push will be logged, not sent');
    return null;
  }
}

export interface PushMessage {
  title: string;
  body: string;
  channel: (typeof PUSH_CHANNEL)[keyof typeof PUSH_CHANNEL];
  /** Where tapping the notification should land the owner, e.g. '/qr'. */
  route?: string;
}

/**
 * Push to every device belonging to a business's owners.
 *
 * Returns how many devices accepted it. Zero is meaningful to the caller: it is
 * the signal to escalate to the next tier, because nothing reached anybody.
 */
export async function pushToOwners(businessId: string, message: PushMessage): Promise<number> {
  const owners = await User.find(
    { businessIds: businessId, role: 'owner' },
    { fcmTokens: { $slice: 20 } },
  )
    .limit(100)
    .lean()
    .maxTimeMS(5000);
  const tokens = [...new Set(owners.flatMap((owner) => owner.fcmTokens))].slice(0, 500);

  if (tokens.length === 0) {
    logger.warn({ businessId }, 'no registered devices to push to');
    return 0;
  }

  const fb = firebase();
  if (!fb) {
    logger.warn(
      { businessId, channel: message.channel, devices: tokens.length },
      '[push not configured] would send',
    );
    return 0;
  }

  const response = await getMessaging(fb).sendEachForMulticast({
    tokens,
    notification: { title: message.title, body: message.body },
    // The route travels in DATA, not in the notification: notification fields
    // are dropped when the app is foregrounded, and this must work either way.
    data: { route: message.route ?? '/', channel: message.channel, businessId },
    android: {
      // A session-down alert that waits for the next maintenance window is
      // useless; a booking ping that wakes someone at 11pm is rude.
      priority: message.channel === PUSH_CHANNEL.SESSION_HEALTH ? 'high' : 'normal',
      notification: { channelId: message.channel },
    },
    // iOS has no channels, so urgency is per-message. Omit `sound` entirely for
    // bookings rather than sending it as undefined — a silent push is the point.
    ...(message.channel === PUSH_CHANNEL.SESSION_HEALTH
      ? { apns: { payload: { aps: { sound: 'default' } } } }
      : {}),
  });

  await pruneDeadTokens(businessId, tokens, response);
  return response.successCount;
}

/**
 * Drop tokens Firebase says are gone.
 *
 * Tokens rotate silently when an app is reinstalled or restored to a new phone.
 * Left in place they accumulate, and every alert then reports partial failure
 * against devices that no longer exist — which is exactly the noise that trains
 * someone to ignore a real one.
 */
async function pruneDeadTokens(
  businessId: string,
  tokens: string[],
  response: BatchResponse,
): Promise<void> {
  const dead = response.responses
    .map((r, i) => (!r.success && isUnregistered(r.error) ? tokens[i]! : null))
    .filter((t): t is string => t !== null);

  if (dead.length === 0) return;

  await User.updateMany(
    { businessIds: businessId, role: 'owner', fcmTokens: { $in: dead } },
    { $pull: { fcmTokens: { $in: dead } } },
    { maxTimeMS: 5000 },
  );
  logger.info({ count: dead.length }, 'pruned dead device tokens');
}

function isUnregistered(error: { code?: string } | undefined): boolean {
  return (
    error?.code === 'messaging/registration-token-not-registered' ||
    error?.code === 'messaging/invalid-registration-token'
  );
}
