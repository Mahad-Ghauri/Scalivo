import express, { type Router } from 'express';
import type { MessagingProvider, ProviderEvent } from '@scalivo/shared';
import { logger } from '../lib/logger.js';
import { InvalidSignatureError } from './OpenWAProvider.js';

/** Verify the delivery, persist it, then acknowledge it to the gateway. */
export function createWebhookRouter(opts: {
  provider: MessagingProvider;
  accept: (events: ProviderEvent[]) => Promise<void>;
}): Router {
  const router = express.Router();

  // The raw body is required: the HMAC is computed over the exact bytes sent,
  // and a JSON round-trip changes key order and unicode escaping. This is also
  // why express.json() is NOT applied globally in index.ts.
  router.post('/whatsapp', express.raw({ type: '*/*', limit: '512kb' }), async (req, res) => {
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

    try {
      await opts.accept(events);
      res.status(200).json({ ok: true });
    } catch (err) {
      logger.error({ err }, 'could not accept webhook delivery');
      res.status(503).json({ error: 'temporarily unavailable' });
    }
  });

  return router;
}
