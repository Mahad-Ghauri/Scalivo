import type { Redis } from 'ioredis';
import { isSessionAlarm, type MessagingProvider, SESSION_INTENT, SESSION_STATUS } from '@scalivo/shared';
import { Business } from '../models/Business.js';
import { logger } from '../lib/logger.js';
import { raiseSessionAlarm } from './alert.js';
import { drain, queueDepth } from './outbound-queue.js';
import { recordTransition } from './history.js';

/**
 * The safety net under the webhook stream.
 *
 * Every signal Session Health depends on arrives as a webhook, and webhooks are
 * exactly the thing that stops arriving when something is wrong: the gateway
 * restarted, the network partitioned, our own process was down for the delivery
 * and its retries. In all of those the last thing we heard was "ready", and we
 * will believe it forever.
 *
 * So every 5 minutes we ASK, rather than waiting to be told. This is also the
 * only path that can notice a session that was never started — for example
 * after a container restart with AUTO_START_SESSIONS off, which the spike
 * confirmed needs an explicit start (proof #9).
 */

const INTERVAL_MS = 5 * 60 * 1000;

export interface ReconcileDeps {
  redis: Redis;
  provider: MessagingProvider;
}

export async function reconcileOnce(deps: ReconcileDeps): Promise<void> {
  // Only sessions we believe should be up. A STOPPED session reporting
  // 'disconnected' is not news, and alerting on it would train the owner to
  // ignore the alert that matters.
  const businesses = await Business.find({
    'whatsapp.sessionId': { $ne: null },
    'whatsapp.intent': SESSION_INTENT.LIVE,
  });

  for (const business of businesses) {
    const businessId = String(business._id);
    const sessionId = business.whatsapp?.sessionId;
    if (!sessionId) continue;

    let observed;
    try {
      observed = await deps.provider.getSessionStatus(sessionId);
    } catch (err) {
      // The gateway being unreachable is an infrastructure problem, not this
      // business's session dying. Alerting the owner would send them to re-scan
      // a QR that will never load. Log it and let the next pass decide.
      logger.error({ err, businessId }, 'could not reach the gateway during reconcile');
      continue;
    }

    const recorded = business.whatsapp?.status;

    if (observed !== recorded) {
      logger.warn(
        { businessId, recorded, observed },
        'reconcile found a status the webhook stream never delivered',
      );

      // `new Date()` rather than a measured moment, and the imprecision is
      // real: all we know is that it changed sometime in the last five minutes.
      // Recorded as `reconcile` so a run full of these is legible as a
      // webhook-delivery problem rather than read as precise uptime data.
      await recordTransition({
        businessId,
        sessionId,
        status: observed,
        previousStatus: recorded,
        intent: SESSION_INTENT.LIVE,
        source: 'reconcile',
        occurredAt: new Date(),
      });

      await Business.updateOne(
        { _id: business._id },
        { $set: { 'whatsapp.status': observed, 'whatsapp.lastStatusChange': new Date() } },
      );
    }

    if (isSessionAlarm(observed, SESSION_INTENT.LIVE)) {
      await raiseSessionAlarm(deps.redis, {
        businessId,
        businessName: business.name,
        status: observed,
        queuedMessages: await queueDepth(deps.redis, businessId),
      });
      continue;
    }

    // Healthy. A queue with anything in it means a recovery we missed — the
    // 'ready' webhook that would have drained it never arrived.
    if (observed === SESSION_STATUS.READY && (await queueDepth(deps.redis, businessId)) > 0) {
      logger.info({ businessId }, 'reconcile found a healthy session with a backlog');
      await drain(deps.redis, deps.provider, businessId);
    }
  }
}

/**
 * Start the loop. Returns a stop function so tests and shutdown can end it.
 *
 * `unref()` keeps the timer from holding the process open — without it a
 * container that finished its work would linger for up to five minutes.
 */
export function startReconcileJob(deps: ReconcileDeps): () => void {
  const run = () => {
    reconcileOnce(deps).catch((err) => logger.error({ err }, 'reconcile pass failed'));
  };

  const timer = setInterval(run, INTERVAL_MS);
  timer.unref();

  return () => clearInterval(timer);
}
