import express, { type Express } from 'express';
import { env } from './config/env.js';
import { connectAll, healthCheck, redis } from './config/db.js';
import { createMessagingProvider, createWebhookRouter } from './messaging/index.js';
import { redisDedupe } from './messaging/webhook.js';
import { createAuthRouter } from './auth/routes.js';
import { createBusinessRouter } from './businesses/routes.js';
import { upsertClientFromMessage } from './auth/identity.js';
import { logger } from './lib/logger.js';

export function createApp(): Express {
  const app = express();
  const provider = createMessagingProvider();

  // NOTE: express.json() is applied per-route, NOT globally. The webhook needs
  // the RAW request bytes to verify its HMAC, and a global JSON parser eats
  // them. See messaging/webhook.ts.
  app.use(
    '/webhooks',
    createWebhookRouter({
      provider,
      dedupe: redisDedupe(redis),
      onEvent: async (event) => {
        logger.info({ kind: event.kind, ...event.payload }, 'inbound provider event');

        // Zero manual data entry starts here: a message from an unknown number
        // creates the client. Phase 1 hands the message on to the FSM next.
        if (event.kind === 'message' && !event.payload.fromMe) {
          const client = await upsertClientFromMessage(provider, event.payload);
          logger.info({ clientId: String(client._id) }, 'client resolved');
        }
      },
    }),
  );

  app.use('/auth', createAuthRouter());
  app.use('/businesses', createBusinessRouter());

  app.get('/health', async (_req, res) => {
    const report = await healthCheck();
    res.status(report.ok ? 200 : 503).json(report);
  });

  return app;
}

async function main() {
  await connectAll();
  const app = createApp();
  app.listen(env.PORT, () => logger.info({ port: env.PORT }, 'scalivo backend listening'));
}

main().catch((err) => {
  logger.error({ err }, 'failed to start');
  process.exit(1);
});
