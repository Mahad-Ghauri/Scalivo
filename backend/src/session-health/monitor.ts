import type { Redis } from 'ioredis';
import {
  isSessionAlarm,
  type MessagingProvider,
  SESSION_INTENT,
  SESSION_STATUS,
  type SessionQrEvent,
  type SessionStatusEvent,
} from '@scalivo/shared';
import { Business } from '../models/Business.js';
import { logger } from '../lib/logger.js';
import { clearSessionAlarm, raiseSessionAlarm } from './alert.js';
import { drain, queueDepth } from './outbound-queue.js';
import { retryPending } from '../notifications/send.js';

/**
 * Watching a WhatsApp session for the moment it dies.
 *
 * SPIKE FINDING #2 is the whole reason this file is not three lines long. A
 * phone-side unlink emits:
 *
 *     17:29:32.899  session.qr      { qr: "data:image/png;base64,..." }
 *     17:29:32.903  session.status  { status: "qr_ready" }
 *
 * ...and nothing else. `session.disconnected` fired ZERO times across the entire
 * spike. A monitor watching for `disconnected` sits silent through a dead
 * session while the business quietly loses every customer who messages it.
 *
 * So the alarm is an **unsolicited qr_ready** — one arriving while we believe
 * the session is LIVE. That belief is `whatsapp.intent`, and it is the only
 * thing separating "this session just died" from "a human tapped Link ten
 * seconds ago". The two events are byte-identical on the wire.
 *
 * Also load-bearing: after an unlink the session still reports its original
 * `phone`, its original `connectedAt`, and `lastError: null`. **None of them is
 * a liveness signal.** Nothing here reads them.
 */

export interface MonitorDeps {
  redis: Redis;
  provider: MessagingProvider;
}

/**
 * A QR arriving is the earliest possible death signal — about 4ms ahead of the
 * status that follows it. Acting on it here rather than waiting for the status
 * buys nothing measurable, but it does mean a dropped status event cannot cause
 * a missed outage.
 */
export async function handleSessionQr(deps: MonitorDeps, event: SessionQrEvent): Promise<void> {
  const business = await Business.findOne({ 'whatsapp.sessionId': event.sessionId });
  if (!business) return;

  if (business.whatsapp?.intent !== SESSION_INTENT.LIVE) {
    // We asked for this one — the owner is linking. Not an alarm.
    logger.info({ sessionId: event.sessionId }, 'expected QR during linking');
    return;
  }

  logger.warn({ sessionId: event.sessionId }, 'UNSOLICITED QR — the session has been unlinked');
  await onSessionLost(deps, String(business._id), business.name, SESSION_STATUS.QR_READY);
}

export async function handleSessionStatus(
  deps: MonitorDeps,
  event: SessionStatusEvent,
): Promise<void> {
  const business = await Business.findOne({ 'whatsapp.sessionId': event.sessionId });
  if (!business) {
    logger.warn({ sessionId: event.sessionId }, 'status for an unknown session');
    return;
  }

  const businessId = String(business._id);
  const intent = business.whatsapp?.intent ?? SESSION_INTENT.STOPPED;
  const previous = business.whatsapp?.status;

  await Business.updateOne(
    { _id: business._id },
    { $set: { 'whatsapp.status': event.status, 'whatsapp.lastStatusChange': event.occurredAt } },
  );

  if (event.status === SESSION_STATUS.READY) {
    await onSessionReady(deps, businessId, intent, previous);
    return;
  }

  if (isSessionAlarm(event.status, intent)) {
    await onSessionLost(deps, businessId, business.name, event.status);
    return;
  }

  logger.info({ businessId, status: event.status, intent }, 'session status changed');
}

/**
 * Recovery. Two things happen, and the order matters: intent flips to LIVE
 * first, so a QR arriving a moment later is correctly read as an alarm.
 */
async function onSessionReady(
  deps: MonitorDeps,
  businessId: string,
  intent: string,
  previous: string | undefined,
): Promise<void> {
  await Business.updateOne(
    { _id: businessId },
    { $set: { 'whatsapp.intent': SESSION_INTENT.LIVE, 'whatsapp.reconnectAttempts': 0 } },
  );
  await clearSessionAlarm(deps.redis, businessId);

  if (previous !== SESSION_STATUS.READY) {
    logger.info({ businessId, from: previous, intent }, 'session recovered');
  }

  // Everything queued during the outage goes now. This is the half of Session
  // Health the owner never sees and cares about most: the confirmations that
  // would otherwise have been lost.
  //
  // Two queues, drained in this order deliberately. The Redis outbox holds
  // conversational replies — cheap, ordered, worthless once stale. The
  // notification rows hold confirmations and reminders, which are owed for days
  // and survive a restart that Redis would not. A customer who booked during the
  // outage should get the end of their conversation before the confirmation that
  // follows it, which is the order they would have arrived in.
  await drain(deps.redis, deps.provider, businessId);
  await retryPending(deps, businessId);
}

async function onSessionLost(
  deps: MonitorDeps,
  businessId: string,
  businessName: string,
  status: (typeof SESSION_STATUS)[keyof typeof SESSION_STATUS],
): Promise<void> {
  await Business.updateOne(
    { _id: businessId },
    {
      $set: { 'whatsapp.status': status, 'whatsapp.lastStatusChange': new Date() },
      $inc: { 'whatsapp.reconnectAttempts': 1 },
    },
  );

  await raiseSessionAlarm(deps.redis, {
    businessId,
    businessName,
    status,
    queuedMessages: await queueDepth(deps.redis, businessId),
  });
}
