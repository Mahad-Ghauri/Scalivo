import { enqueueInbound, startInboundWorker } from './messaging/inbound-queue.js';
import express, { type Express, type ErrorRequestHandler } from 'express';
import { env } from './config/env.js';
import { connectAll, healthCheck, redis } from './config/db.js';
import { createMessagingProvider, createWebhookRouter } from './messaging/index.js';
import { securityHeaders } from './http/headers.js';
import { createAuthRouter } from './auth/routes.js';
import { createBusinessRouter } from './businesses/routes.js';
import { createCatalogRouter } from './catalog/routes.js';
import { createCrmRouter } from './crm/routes.js';
import { createReviewRouter } from './reviews/routes.js';
import { createAnalyticsRouter } from './analytics/routes.js';
import { createGrowRouter } from './grow/routes.js';
import { createRetentionRouter } from './retention/routes.js';
import { createAgentRouter } from './agent/routes.js';
import { createBookingRouter } from './bookings/routes.js';
import { createCalendarRouter } from './calendar/routes.js';
import { createPublicRouter } from './public/routes.js';
import { handleInboundMessage } from './whatsapp/router.js';
import { handleSessionQr, handleSessionStatus } from './session-health/monitor.js';
import { startReconcileJob } from './session-health/reconcile.js';
import { handleMessageAck } from './notifications/ack.js';
import { startReminderJob } from './notifications/reminders.js';
import { startReviewRequestJob } from './reviews/request.js';
import { startNudgeJob } from './retention/nudges.js';
import { startCampaignJob } from './retention/campaigns.js';
import { startAgentJob } from './agent/job.js';
import { logger } from './lib/logger.js';
import { createDepositRouter } from './payments/routes.js';
import { startDepositExpiryJob } from './payments/deposits.js';
import { ensurePaymentSchema } from './payments/ledger.js';
import { createPaymentProvider, usePaymentProvider } from './payments/registry.js';

export function createApp(): Express {
  const app = express();
  // First, so a response written by any route below already carries them —
  // including the ones that answer before reaching a handler.
  app.use(securityHeaders);
  usePaymentProvider(createPaymentProvider());
  const provider = createMessagingProvider();

  // NOTE: express.json() is applied per-route, NOT globally. The webhook needs
  // the RAW request bytes to verify its HMAC, and a global JSON parser eats
  // them. See messaging/webhook.ts.
  app.use(
    '/webhooks',
    createWebhookRouter({
      provider,
      accept: (events) => enqueueInbound(redis, events),
    }),
  );

  // Start once per application; verified inbound deliveries survive worker failures.
  startInboundWorker(redis, handleProviderEvent);

  async function handleProviderEvent(event: import('@scalivo/shared').ProviderEvent,
  ): Promise<void> {
        logger.info({ kind: event.kind, sessionId: event.payload.sessionId }, 'inbound provider event');

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
      }

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
        res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS');
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

  app.use('/auth', createAuthRouter(redis));
  app.use('/businesses', createBusinessRouter(provider));
  // Also under /businesses — every one of these scopes by :businessId, so
  // requireTenant guards the catalogue, availability and booking exactly as it
  // guards the session routes.
  app.use('/businesses', createCatalogRouter());
  app.use('/businesses', createCrmRouter());
  app.use('/businesses', createReviewRouter());
  app.use('/businesses', createAnalyticsRouter());
  app.use('/businesses', createGrowRouter());
  app.use('/businesses', createRetentionRouter({ redis, provider }));
  app.use('/businesses', createAgentRouter({ redis, provider }));
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

  const errors: ErrorRequestHandler = (err: unknown, _req, res, next) => {
    if (res.headersSent) {
      next(err);
      return;
    }
    logger.error({ err }, 'request failed');
    res.status(500).json({ error: 'Something went wrong. Try again.' });
  };
  app.use(errors);
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

  /**
   * Retention (SPEC §6). Two passes, both SINGLE INSTANCE like everything above,
   * and here the rule is stricter than for the others: these are the only jobs
   * that message people who are not expecting to hear from us. A second replica
   * would not merely duplicate work — it would double the unsolicited volume
   * leaving one WhatsApp number, which is how the number gets restricted and
   * every booking for that business stops.
   *
   * The spacing itself is enforced in Redis rather than by the tick interval
   * (retention/throttle.ts), so the two passes share one allowance and neither
   * can burst on its own.
   */
  startNudgeJob({ redis, provider: createMessagingProvider() });
  startCampaignJob({ redis, provider: createMessagingProvider() });

  /**
   * The agent (SPEC §11). Every five minutes, SINGLE INSTANCE like the rest —
   * though this is the one pass where a second instance would be merely
   * embarrassing rather than damaging: the unique claim on each briefing means the
   * loser's insert fails, so the owner gets one notification either way.
   *
   * It runs LAST because it reads what the others wrote. The daily briefing
   * counts today's bookings, the weekly summary reads the same analytics the
   * dashboard does, and the win-back suggestion asks retention who is reachable.
   */
  startAgentJob({ redis, provider: createMessagingProvider() });

  app.listen(env.PORT, () => logger.info({ port: env.PORT }, 'scalivo backend listening'));
}

main().catch((err) => {
  logger.error({ err }, 'failed to start');
  process.exit(1);
});
