import express, { type Router } from 'express';
import type { MessagingProvider, ProviderEvent } from '@scalivo/shared';
import type { Redis } from 'ioredis';
import { logger } from '../lib/logger.js';
import { InvalidSignatureError } from './OpenWAProvider.js';

/**
 * Webhook delivery is AT-LEAST-ONCE. OpenWA retries, and a retry carries the
 * same idempotency key but a fresh deliveryId — so deduping on deliveryId
 * silently does nothing, and an inbound "3" could be processed twice, advancing
 * the booking FSM two steps from one customer message.
 */
export interface DedupeStore {
  /** True the first time this key is seen, false for a retry. */
  isFirstDelivery(key: string): Promise<boolean>;
}

/** Keys live a day — far longer than OpenWA's retry window, cheap to hold. */
export function redisDedupe(redis: Redis, ttlSeconds = 86_400): DedupeStore {
  return {
    async isFirstDelivery(key) {
      return (await redis.set(`webhook:seen:${key}`, '1', 'EX', ttlSeconds, 'NX')) === 'OK';
    },
  };
}

export function createWebhookRouter(opts: {
  provider: MessagingProvider;
  dedupe: DedupeStore;
  onEvent: (event: ProviderEvent) => Promise<void>;
}): Router {
  const router = express.Router();

  // The raw body is required: the HMAC is computed over the exact bytes sent,
  // and a JSON round-trip changes key order and unicode escaping. This is also
  // why express.json() is NOT applied globally in index.ts.
  router.post('/whatsapp', express.raw({ type: '*/*', limit: '5mb' }), async (req, res) => {
    let events: ProviderEvent[];

    // Verified BEFORE responding. HMAC costs microseconds, so this doesn't
    // violate "ack first" — that rule is about not making the sender wait on
    // database work. Answering 401 on a bad secret surfaces a misconfigured
    // webhook during setup instead of leaving it silently dropping messages.
    try {
      events = opts.provider.parseWebhook(req.body as Buffer, req.headers as Record<string, string>);
    } catch (err) {
      if (err instanceof InvalidSignatureError) {
        logger.warn({ ip: req.ip }, 'rejected webhook with invalid signature');
        res.status(401).json({ error: 'invalid signature' });
        return;
      }
      logger.warn({ err }, 'unparseable webhook body');
      res.status(400).json({ error: 'malformed payload' });
      return;
    }

    // Ack now; everything below is our problem, not the sender's. A non-2xx
    // here would push the delivery into OpenWA's retry path and eventually into
    // GET /api/webhooks/delivery-failures.
    res.status(200).json({ ok: true });

    const key = req.get('X-OpenWA-Idempotency-Key');
    if (key && !(await opts.dedupe.isFirstDelivery(key))) {
      logger.debug({ key }, 'dropped duplicate webhook delivery');
      return;
    }

    for (const event of events) {
      try {
        await opts.onEvent(event);
      } catch (err) {
        // Already acked, so this cannot be retried by the sender. Log loudly.
        logger.error({ err, kind: event.kind }, 'failed to handle webhook event');
      }
    }
  });

  return router;
}
