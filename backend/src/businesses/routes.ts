import express, { type Router } from 'express';
import { z } from 'zod';
import { type MessagingProvider, SESSION_INTENT, SESSION_STATUS } from '@scalivo/shared';
import { Business } from '../models/Business.js';
import { SlotOccupancy } from '../models/SlotOccupancy.js';
import { requireAuth, requireTenant } from '../auth/middleware.js';
import { logger } from '../lib/logger.js';
import { setupChecklist } from '../onboarding/readiness.js';
import { connectedPhone, provisionSession, type ProvisionFailure } from '../onboarding/provision.js';

/** How a provisioning refusal reaches the app. */
const PROVISION_STATUS: Record<ProvisionFailure, number> = {
  not_found: 404,
  // Not an error the owner caused — they already have what they asked for.
  already_linked: 409,
  session_taken: 409,
  gateway_unreachable: 502,
  webhook_rejected: 502,
};

const PROVISION_MESSAGE: Record<ProvisionFailure, string> = {
  not_found: 'not found',
  already_linked: 'a WhatsApp number is already connected',
  session_taken: 'that session belongs to another business',
  gateway_unreachable: 'could not reach the messaging gateway',
  webhook_rejected: 'the gateway would not accept our webhook address',
};

/**
 * Settings an owner can change after signup. Deliberately narrow: `slug` is
 * absent because it is the marketplace URL, and `category` because it decides
 * which template the business was seeded from.
 */
const settingsBody = z
  .object({
    name: z.string().trim().min(1).max(120),
    city: z.string().trim().min(1).max(80),
    timezone: z.string().min(1),
    // A change here re-grids the whole diary, so it is bounded to values that
    // divide an hour — a 7-minute increment would misalign every existing
    // occupancy row against every new one.
    slotIncrementMinutes: z.union([z.literal(5), z.literal(10), z.literal(15), z.literal(30)]),
    minNoticeMinutes: z.number().int().min(0).max(60 * 24 * 7),
    bookingHorizonDays: z.number().int().min(1).max(365),

    /**
     * Reminder schedule.
     *
     * Bounded at both ends for the same reason the booking window is. A lead
     * under five minutes arrives after the customer has already left for the
     * appointment; one over a week is a message about something they have not
     * thought about yet, on the one channel a business cannot afford to be
     * reported on. Duplicates are dropped rather than refused — two entries of
     * 1440 is a slip, not a request for two identical reminders.
     */
    reminders: z.object({
      enabled: z.boolean(),
      leadMinutes: z
        .array(z.number().int().min(5).max(60 * 24 * 7))
        .max(4)
        .transform((list) => [...new Set(list)].sort((a, b) => b - a)),
    }).partial(),
  })
  .partial();

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
   * Everything still standing between this business and a real booking.
   *
   * The onboarding screen renders this directly. It exists because each gap it
   * reports is otherwise invisible — see onboarding/readiness.ts.
   */
  router.get('/:businessId/setup', requireAuth, requireTenant(), async (req, res) => {
    res.json(await setupChecklist(String(req.params.businessId)));
  });

  /**
   * Settings. Two of these are load-bearing rather than cosmetic, so both are
   * checked here rather than trusted from the form.
   */
  router.patch('/:businessId', requireAuth, requireTenant(), express.json(), async (req, res) => {
    const parsed = settingsBody.safeParse(req.body);
    if (!parsed.success) {
      const fields: Record<string, string> = {};
      for (const issue of parsed.error.issues) {
        const key = issue.path.join('.') || '_';
        if (!fields[key]) fields[key] = issue.message;
      }
      res.status(400).json({ error: 'invalid settings', fields });
      return;
    }

    const businessId = String(req.params.businessId);

    // An unknown IANA zone makes every luxon conversion produce an invalid
    // DateTime, and availability then returns nothing for every day forever.
    // Nothing downstream reports it, so it is caught at the only edge it can be.
    if (parsed.data.timezone && !isKnownTimezone(parsed.data.timezone)) {
      res.status(400).json({
        error: 'invalid settings',
        fields: { timezone: 'not a known IANA timezone' },
      });
      return;
    }

    // Re-gridding a diary that already has bookings on it is not a settings
    // change, it is data corruption: existing occupancy rows sit on the old
    // increment's grid points, new ones on the new, and two genuinely
    // overlapping bookings stop colliding on the unique index — the single
    // guarantee the whole booking system rests on.
    if (parsed.data.slotIncrementMinutes !== undefined) {
      const business = await Business.findById(businessId);
      const changing = business?.slotIncrementMinutes !== parsed.data.slotIncrementMinutes;

      if (changing && (await hasFutureBookings(businessId))) {
        res.status(409).json({
          error: 'invalid settings',
          fields: {
            slotIncrementMinutes:
              'cannot change the slot size while there are upcoming bookings on the old grid',
          },
        });
        return;
      }
    }

    /**
     * `reminders` is flattened to dotted paths, everything else set as-is.
     *
     * `$set: { reminders: { enabled: false } }` REPLACES the subdocument, so
     * sending only the toggle would silently drop the lead times and every
     * business that touched the switch would fall back to the schema default.
     * Dotted paths set one field and leave its siblings alone.
     */
    const { reminders, ...flat } = parsed.data;
    const update: Record<string, unknown> = { ...flat };
    for (const [key, value] of Object.entries(reminders ?? {})) {
      update[`reminders.${key}`] = value;
    }

    const updated = await Business.findByIdAndUpdate(businessId, { $set: update }, { new: true });
    if (!updated) {
      res.status(404).json({ error: 'not found' });
      return;
    }

    logger.info({ businessId, changed: Object.keys(parsed.data) }, 'settings updated');
    res.json(updated);
  });

  /**
   * Provision a WhatsApp session for a business that has none.
   *
   * Separate from /link, which resumes one that already exists. The distinction
   * is the whole point — see onboarding/provision.ts.
   */
  router.post('/:businessId/whatsapp/session', requireAuth, requireTenant(), async (req, res) => {
    const result = await provisionSession(
      { provider },
      String(req.params.businessId),
      // Replacing a working session logs the owner's phone out of it, so it
      // takes a deliberate ?force=true rather than a second tap on Connect.
      { force: req.query.force === 'true' },
    );

    if (!result.ok) {
      res
        .status(PROVISION_STATUS[result.reason])
        .json({ error: PROVISION_MESSAGE[result.reason], reason: result.reason });
      return;
    }

    res.status(201).json({
      sessionId: result.sessionId,
      status: result.status,
      qrCode: result.qrCode,
    });
  });

  /**
   * How customers are told to reach the new number.
   *
   * This is not decoration. SPIKE FINDING #3/#4: WhatsApp silently drops first
   * contact to a brand-new number while the API still reports success, so a
   * business cannot reliably message its own customers first. Every early
   * conversation has to be started by the CUSTOMER, which makes the poster, the
   * bio link and the old-number away message the actual migration mechanism
   * rather than marketing extras.
   *
   * The QR is rendered client-side from `link` — the app already draws one, and
   * a PNG generated here would be a dependency and a cache for no gain.
   */
  router.get('/:businessId/invite', requireAuth, requireTenant(), async (req, res) => {
    const businessId = String(req.params.businessId);
    const business = await Business.findById(businessId);
    if (!business) {
      res.status(404).json({ error: 'not found' });
      return;
    }

    const phone = await connectedPhone({ provider }, businessId);
    if (!phone) {
      // Connect first. Answering with a wa.me link to no number would produce a
      // poster that silently goes nowhere.
      res.status(409).json({ error: 'no WhatsApp number connected yet', reason: 'not_connected' });
      return;
    }

    const greeting = 'Hi! I would like to book an appointment.';

    res.json({
      phone,
      /** Prefilled so the customer's first message is one the FSM understands. */
      link: `https://wa.me/${phone}?text=${encodeURIComponent(greeting)}`,
      /** For the old number's auto-reply, and for an Instagram bio. */
      awayMessage:
        `We have moved to WhatsApp for bookings! Message us on ` +
        `+${phone} to book with ${business.name} — it takes about a minute.`,
      posterHeadline: `Book ${business.name} on WhatsApp`,
    });
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

/**
 * Does this string name a zone the runtime actually knows?
 *
 * Asking Intl is the only honest check — a hardcoded list goes stale every time
 * a country changes its rules, and luxon reports an unknown zone by producing
 * invalid DateTimes rather than by throwing.
 */
function isKnownTimezone(zone: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: zone });
    return true;
  } catch {
    return false;
  }
}

/** Any occupancy still ahead of now — the rows a re-grid would strand. */
async function hasFutureBookings(businessId: string): Promise<boolean> {
  const existing = await SlotOccupancy.exists({ businessId, slotStart: { $gte: new Date() } });
  return existing !== null;
}
