import express, { type Express } from 'express';
import { env } from './config/env.js';
import { connectAll, healthCheck, redis } from './config/db.js';
import { createMessagingProvider, createWebhookRouter } from './messaging/index.js';
import { redisDedupe } from './messaging/webhook.js';
import { createAuthRouter } from './auth/routes.js';
import { createBusinessRouter } from './businesses/routes.js';
import { createCatalogRouter } from './catalog/routes.js';
import { createCrmRouter } from './crm/routes.js';
import { createBookingRouter } from './bookings/routes.js';
import { handleInboundMessage } from './whatsapp/router.js';
import { handleSessionQr, handleSessionStatus } from './session-health/monitor.js';
import { startReconcileJob } from './session-health/reconcile.js';
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

        // Identity resolution now happens inside the router, as interceptor
        // stage 2 — it has to run after dedupe and before the conversation
        // lock, and only the router knows that ordering.
        if (event.kind === 'message') {
          await handleInboundMessage({ redis, provider }, event.payload);
          return;
        }

        // SPIKE FINDING #2: a QR arriving unsolicited is the death signal, ~4ms
        // ahead of the status that follows. `disconnected` fired zero times
        // across the whole spike — watching for it alone sits silent through a
        // dead session.
        if (event.kind === 'session-qr') {
          await handleSessionQr({ redis, provider }, event.payload);
          return;
        }

        if (event.kind === 'session-status') {
          await handleSessionStatus({ redis, provider }, event.payload);
        }
      },
    }),
  );

  app.use('/auth', createAuthRouter());
  app.use('/businesses', createBusinessRouter(provider));
  // Also under /businesses — every one of these scopes by :businessId, so
  // requireTenant guards the catalogue, availability and booking exactly as it
  // guards the session routes.
  app.use('/businesses', createCatalogRouter());
  app.use('/businesses', createCrmRouter());
  app.use('/businesses', createBookingRouter(redis));

  app.get('/health', async (_req, res) => {
    const report = await healthCheck();
    res.status(report.ok ? 200 : 503).json(report);
  });

  return app;
}

async function main() {
  await connectAll();
  const app = createApp();

  // The webhook stream is the primary signal; this is the safety net under it.
  // Webhooks stop arriving in exactly the situations where something is wrong,
  // and without a poll the last thing we heard — "ready" — is believed forever.
  //
  // AUTO_START_SESSIONS requires a SINGLE instance, and so does this: two
  // replicas reconciling the same session would double every alert and risk a
  // forced logout by both resurrecting it.
  startReconcileJob({ redis, provider: createMessagingProvider() });

  app.listen(env.PORT, () => logger.info({ port: env.PORT }, 'scalivo backend listening'));
}

main().catch((err) => {
  logger.error({ err }, 'failed to start');
  process.exit(1);
});
