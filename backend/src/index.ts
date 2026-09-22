import express, { type Express } from 'express';
import { env } from './config/env.js';
import { connectAll, healthCheck, redis } from './config/db.js';
import { createMessagingProvider, createWebhookRouter } from './messaging/index.js';
import { redisDedupe } from './messaging/webhook.js';
import { createAuthRouter } from './auth/routes.js';
import { createBusinessRouter } from './businesses/routes.js';
import { createCatalogRouter } from './catalog/routes.js';
import { createCrmRouter } from './crm/routes.js';
import { createReviewRouter } from './reviews/routes.js';
import { createAnalyticsRouter } from './analytics/routes.js';
import { createGrowRouter } from './grow/routes.js';
import { createBookingRouter } from './bookings/routes.js';
import { createCalendarRouter } from './calendar/routes.js';
import { createPublicRouter } from './public/routes.js';
import { handleInboundMessage } from './whatsapp/router.js';
import { handleSessionQr, handleSessionStatus } from './session-health/monitor.js';
import { startReconcileJob } from './session-health/reconcile.js';
import { handleMessageAck } from './notifications/ack.js';
import { startReminderJob } from './notifications/reminders.js';
import { startReviewRequestJob } from './reviews/request.js';
import { logger } from './lib/logger.js';
import { createDepositRouter } from './payments/routes.js';
import { startDepositExpiryJob } from './payments/deposits.js';
import { ensurePaymentSchema } from './payments/ledger.js';
import { createPaymentProvider, usePaymentProvider } from './payments/registry.js';

export function createApp(): Express {
  const app = express();
  usePaymentProvider(createPaymentProvider());
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

        // FINDING #3: the only evidence a message actually arrived. Every other
        // signal in the send path — including the provider's own 200 — is
        // consistent with WhatsApp having silently dropped it.
        if (event.kind === 'ack') {
          await handleMessageAck(event.payload);
          return;
        }

        if (event.kind === 'session-status') {
          await handleSessionStatus({ redis, provider }, event.payload);
        }
      },
    }),
  );

  // Lets the Flutter app run in a browser during development.
  //
  // A browser refuses a cross-origin call unless the server says otherwise, and
  // `flutter run -d chrome` serves the app from a localhost port that is not
  // ours. Native builds never send an Origin and never see any of this.
  //
  // Development only, and narrow even there: a reflected origin is only echoed
  // back when it is loopback, so this can never widen into a real deployment.
  if (env.NODE_ENV === 'development') {
    const LOOPBACK = /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/;

    app.use((req, res, next) => {
      const origin = req.headers.origin;
      if (origin && LOOPBACK.test(origin)) {
        res.setHeader('Access-Control-Allow-Origin', origin);
        // Without Vary, a cache could serve one origin's response to another.
        res.setHeader('Vary', 'Origin');
        res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');
        res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PATCH, DELETE, OPTIONS');
        // Every authenticated call carries an Authorization header, which makes
        // it non-simple — so the browser preflights nearly all of them.
        if (req.method === 'OPTIONS') {
          res.sendStatus(204);
          return;
        }
      }
      next();
    });
  }

  app.use('/auth', createAuthRouter());
  app.use('/businesses', createBusinessRouter(provider));
  // Also under /businesses — every one of these scopes by :businessId, so
  // requireTenant guards the catalogue, availability and booking exactly as it
  // guards the session routes.
  app.use('/businesses', createCatalogRouter());
  app.use('/businesses', createCrmRouter());
  app.use('/businesses', createReviewRouter());
  app.use('/businesses', createAnalyticsRouter());
  app.use('/businesses', createGrowRouter());
  app.use('/businesses', createBookingRouter(redis, provider));
  app.use('/businesses', createCalendarRouter(redis, provider));

  // Anonymous: the marketplace and web booking. Gated on `published`, not on a
  // tenant — see public/routes.ts for why it can never live under /businesses.
  app.use('/public', createPublicRouter(redis, provider));

  // Deposits (SPEC §12): the payment page's data under /public, and the
  // gateway's return under /payments. Both anonymous; see payments/routes.ts.
  const deposits = createDepositRouter({ redis, provider });
  app.use('/public', deposits.publicRouter);
  app.use('/payments', deposits.gatewayRouter);

  app.get('/health', async (_req, res) => {
    const report = await healthCheck();
    res.status(report.ok ? 200 : 503).json(report);
  });

  return app;
}

async function main() {
  await connectAll();
  // Before the app exists: the first payment return must find its tables.
  await ensurePaymentSchema();
  const app = createApp();

  // The webhook stream is the primary signal; this is the safety net under it.
  // Webhooks stop arriving in exactly the situations where something is wrong,
  // and without a poll the last thing we heard — "ready" — is believed forever.
  //
  // AUTO_START_SESSIONS requires a SINGLE instance, and so does this: two
  // replicas reconciling the same session would double every alert and risk a
  // forced logout by both resurrecting it.
  startReconcileJob({ redis, provider: createMessagingProvider() });

  // Every minute, not every hour: a reminder is due at a particular moment, and
  // the tick interval is the resolution at which "due" is honoured. It is also
  // what drains notifications owed from an outage whose recovery webhook never
  // arrived — SINGLE INSTANCE, like the reconcile job above.
  startReminderJob({ redis, provider: createMessagingProvider() });

  // Every five minutes rather than every minute: a rating request is due a
  // couple of hours after an appointment ends, and nobody can tell the
  // difference. SINGLE INSTANCE, like the two above.
  startReviewRequestJob({ redis, provider: createMessagingProvider() });

  // Every minute: a released slot is only worth something while it can still
  // be resold. SINGLE INSTANCE, like the others — two passes would both
  // inquire, and the loser's "slot released" message would be a duplicate.
  startDepositExpiryJob({ redis, provider: createMessagingProvider() });

  app.listen(env.PORT, () => logger.info({ port: env.PORT }, 'scalivo backend listening'));
}

main().catch((err) => {
  logger.error({ err }, 'failed to start');
  process.exit(1);
});
