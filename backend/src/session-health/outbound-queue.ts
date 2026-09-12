import type { Redis } from 'ioredis';
import type { MessagingProvider } from '@scalivo/shared';
import { logger } from '../lib/logger.js';

/**
 * Messages that could not be sent because the session was down.
 *
 * Without this, an outage is not just "customers cannot book" — it is "every
 * confirmation and reminder generated during the outage is lost forever". The
 * customer who booked at 9am never learns their 3pm appointment exists, and
 * nobody ever finds out, because the send failed into a log line.
 *
 * A Redis LIST per business, drained when the session comes back. Order is
 * preserved: a confirmation must not arrive after the reminder for the same
 * appointment.
 */

const queueKey = (businessId: string) => `outbox:${businessId}`;

/**
 * A queue that grows without bound during a long outage becomes its own
 * incident. At the cap the OLDEST entries are dropped — a two-day-old reminder
 * for an appointment that has already happened is worse than nothing.
 */
const MAX_QUEUED = 500;

/** Enough for a transient blip; beyond it the message is stale, not unlucky. */
const MAX_ATTEMPTS = 5;

export interface QueuedMessage {
  sessionId: string;
  /** The LID or phone to reply to. */
  to: string;
  text: string;
  queuedAt: string;
  attempts: number;
}

export async function enqueue(
  redis: Redis,
  businessId: string,
  message: Omit<QueuedMessage, 'queuedAt' | 'attempts'>,
): Promise<void> {
  const key = queueKey(businessId);
  await redis.rpush(key, JSON.stringify({ ...message, queuedAt: new Date().toISOString(), attempts: 0 }));
  // Trim from the FRONT: keep the newest MAX_QUEUED, drop the stalest.
  await redis.ltrim(key, -MAX_QUEUED, -1);

  logger.info({ businessId, depth: await redis.llen(key) }, 'queued an outbound message');
}

export async function queueDepth(redis: Redis, businessId: string): Promise<number> {
  return redis.llen(queueKey(businessId));
}

/**
 * Send everything waiting, oldest first.
 *
 * A failure re-queues at the FRONT and stops the drain, rather than continuing
 * down the list. If the session dropped again mid-drain, pushing on would burn
 * every message's attempt counter against a session that is not there — and
 * would deliver them out of order if it recovered halfway.
 */
export async function drain(
  redis: Redis,
  provider: MessagingProvider,
  businessId: string,
): Promise<{ sent: number; remaining: number }> {
  const key = queueKey(businessId);
  let sent = 0;

  for (;;) {
    const raw = await redis.lpop(key);
    if (!raw) break;

    let message: QueuedMessage;
    try {
      message = JSON.parse(raw) as QueuedMessage;
    } catch {
      continue; // an entry we cannot parse is an entry we cannot send
    }

    try {
      await provider.sendText(message.sessionId, message.to, message.text);
      sent += 1;
    } catch (err) {
      const attempts = message.attempts + 1;

      if (attempts >= MAX_ATTEMPTS) {
        logger.error(
          { err, businessId, to: message.to, attempts },
          'dropping an outbound message after repeated failures',
        );
        continue;
      }

      // Back to the front, and stop — see the note above.
      await redis.lpush(key, JSON.stringify({ ...message, attempts }));
      logger.warn({ err, businessId, attempts }, 'drain stopped, session still unhealthy');
      break;
    }
  }

  const remaining = await redis.llen(key);
  if (sent > 0) logger.info({ businessId, sent, remaining }, 'drained the outbound queue');
  return { sent, remaining };
}
