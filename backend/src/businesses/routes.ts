import express, { type Router } from 'express';
import { type MessagingProvider, SESSION_INTENT, SESSION_STATUS } from '@scalivo/shared';
import { Business } from '../models/Business.js';
import { requireAuth, requireTenant } from '../auth/middleware.js';
import { logger } from '../lib/logger.js';

export function createBusinessRouter(provider: MessagingProvider): Router {
  const router = express.Router();

  // requireTenant runs before the handler, so a cross-tenant request is refused
  // without a single query being issued. That ordering is the isolation
  // guarantee — a check after the read has already loaded the other tenant's row.
  router.get('/:businessId', requireAuth, requireTenant(), async (req, res) => {
    const business = await Business.findById(req.params.businessId);
    if (!business) {
      res.status(404).json({ error: 'not found' });
      return;
    }
    res.json(business);
  });

  /**
   * What the app's session banner reads.
   *
   * Deliberately answered from our own record rather than by calling OpenWA:
   * this is polled from every open app, and the webhook stream is already the
   * authority on status. Reaching through to the gateway here would add latency
   * and a second source of truth without adding information.
   */
  router.get('/:businessId/whatsapp', requireAuth, requireTenant(), async (req, res) => {
    const business = await Business.findById(req.params.businessId);
    if (!business) {
      res.status(404).json({ error: 'not found' });
      return;
    }

    res.json({
      sessionId: business.whatsapp?.sessionId ?? null,
      status: business.whatsapp?.status ?? null,
      intent: business.whatsapp?.intent ?? null,
      lastStatusChange: business.whatsapp?.lastStatusChange ?? null,
    });
  });

  /**
   * Asks the gateway for a linking QR, and records that we asked.
   *
   * The intent write is the load-bearing line, not the QR. SPIKE FINDING #2: a
   * qr_ready is either "a human just tapped Link" or "this session died and
   * nobody knows" — and the two are byte-identical on the wire. Flipping intent
   * to LINKING *before* the call is what lets Session Health tell them apart;
   * doing it after would leave a window where our own QR raises the alarm.
   */
  router.post('/:businessId/whatsapp/link', requireAuth, requireTenant(), async (req, res) => {
    const business = await Business.findById(req.params.businessId);
    if (!business) {
      res.status(404).json({ error: 'not found' });
      return;
    }

    const sessionId = business.whatsapp?.sessionId;
    if (!sessionId) {
      // Provisioning a session belongs to onboarding, not to this screen.
      res.status(409).json({ error: 'no whatsapp session provisioned for this business' });
      return;
    }

    await Business.updateOne(
      { _id: business._id },
      { $set: { 'whatsapp.intent': SESSION_INTENT.LINKING } },
    );

    try {
      const result = await provider.startSession(sessionId);

      await Business.updateOne(
        { _id: business._id },
        {
          $set: {
            'whatsapp.status': result.status,
            'whatsapp.lastStatusChange': new Date(),
            // Already linked — a restart recovers with no QR at all (proof #9),
            // so there is nothing for a human to scan and nothing to wait for.
            ...(result.status === SESSION_STATUS.READY
              ? { 'whatsapp.intent': SESSION_INTENT.LIVE }
              : {}),
          },
        },
      );

      logger.info({ businessId: String(business._id), status: result.status }, 'link requested');

      // qrCode is a PNG data URL when present. It is absent whenever the session
      // did not need a scan, which is a success, not a failure.
      res.json({ status: result.status, qrCode: result.qrCode ?? null });
    } catch (err) {
      await Business.updateOne(
        { _id: business._id },
        { $set: { 'whatsapp.intent': SESSION_INTENT.STOPPED } },
      );
      logger.error({ err, businessId: String(business._id) }, 'link failed');
      res.status(502).json({ error: 'could not reach the messaging gateway' });
    }
  });

  return router;
}
