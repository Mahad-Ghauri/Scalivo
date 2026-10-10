import { isCalendarDate } from '../lib/time.js';
import express, { type Request, type Response, type Router } from 'express';
import { z } from 'zod';
import type { Redis } from 'ioredis';
import {
  ANY_STAFF,
  type MeRebookError,
  type MessagingProvider,
  type PublicHold,
  REVIEW_COMMENT_MAX_LENGTH,
} from '@scalivo/shared';
import { fieldErrors, param } from '../http/params.js';
import { TOO_MANY, rateLimit, safely } from '../http/guards.js';
import { getAvailability } from '../bookings/availability.js';
import { holdSlot } from '../bookings/create.js';
import { bookAsClient, toPublicSlot } from '../public/booking.js';
import { attachComment, recordRating } from '../reviews/record.js';
import { clearPendingPrompt } from '../whatsapp/state.js';
import { logger } from '../lib/logger.js';
import { resolveMeToken } from './token.js';
import { meView } from './view.js';
import { Booking } from '../models/Booking.js';
import { Client } from '../models/Client.js';
import { ClientProfile } from '../models/ClientProfile.js';
import { AppointmentHolder } from '../models/AppointmentHolder.js';
import { holderBody, saveHolder } from '../crm/holders.js';
import { ConfigurationConflict } from '../bookings/configuration.js';
import { newMeToken } from './token.js';
import { beginVerification, finishVerification, verifiedContact } from '../public/verification.js';
import { normalisePhone } from '../lib/phone.js';
import { setBookingOutcome } from '../bookings/outcome.js';
import { rescheduleBooking } from '../calendar/reschedule.js';
import { BOOKING_STATUS } from '@scalivo/shared';

/**
 * The customer's own page — milestone 3.3.
 *
 * Every handler here starts the same way: resolve the token to a businessId and
 * a clientId, then work only from those. Nothing in the request names a business,
 * a customer or a booking belonging to anyone else, which is why this surface
 * cannot read across tenants rather than merely trying not to.
 *
 * **It deliberately does NOT inherit the public router's PUBLISHED gate.**
 * `Business.published` defaults to false, so an unpublished business is the
 * ordinary case, not a broken one — a salon taking WhatsApp bookings with no
 * marketplace listing is exactly the pilot. Gating this on publication would
 * hide a customer's own appointments because their salon never filled in a
 * category. Publication decides who may be DISCOVERED by strangers; it has
 * nothing to say about a customer the business already has.
 *
 * That is also why availability and holds are re-exposed here instead of the
 * page reusing `/public/businesses/:slug/...`: those are published-only, so
 * rebooking through them would work for some businesses and not others.
 *
 * **Nothing here logs the token.** It is a durable credential (see token.ts), so
 * a log line carrying it is a credential at rest in a log aggregator. The
 * handlers log the resolved businessId instead, which is what an operator
 * actually needs.
 */

const objectId = z.string().regex(/^[a-f0-9]{24}$/i, 'not a valid id');

const availabilityQuery = z.object({
  serviceId: objectId,
  date: z.string().refine(isCalendarDate, 'Choose a valid calendar date'),
  staffId: z.union([objectId, z.literal(ANY_STAFF)]).default(ANY_STAFF),
});

const holdBody = z.object({
  serviceId: objectId,
  startsAt: z.string().datetime({ offset: true }),
  staffId: z.union([objectId, z.literal(ANY_STAFF)]).default(ANY_STAFF),
});

const bookingBody = z.object({
  serviceId: objectId,
  staffId: objectId,
  startsAt: z.string().datetime({ offset: true }),
  holdToken: z.string().uuid(),
  appointmentHolderId: objectId.optional(),
});

const reviewBody = z.object({
  bookingId: objectId,
  rating: z.number().int().min(1).max(5),
  comment: z.string().trim().max(REVIEW_COMMENT_MAX_LENGTH).optional(),
});

const STATUS: Record<MeRebookError, number> = {
  slot_taken: 409,
  hold_expired: 409,
  invalid_slot: 400,
  outside_hours: 400,
  too_soon: 400,
  beyond_horizon: 400,
  no_staff: 400,
  rate_limited: 429,
};

/** Written for the customer. The page shows these as they are. */
const MESSAGE: Record<MeRebookError, string> = {
  slot_taken: 'Someone just booked that time. Pick another.',
  hold_expired: 'Your time was only held for two minutes. Pick it again to continue.',
  invalid_slot: 'That time is not bookable.',
  outside_hours: 'That time is outside opening hours.',
  too_soon: 'That time is too soon to book online.',
  beyond_horizon: 'That date is too far ahead to book.',
  no_staff: 'Nobody is available for that service at that time.',
  rate_limited: TOO_MANY,
};

const refuse = (res: Response, reason: MeRebookError, extra: object = {}) =>
  res.status(STATUS[reason]).json({ error: MESSAGE[reason], reason, ...extra });

/**
 * The token is the only credential, so this is the only gate.
 *
 * Answers 404 rather than 401 on a token that resolves to nothing: there is no
 * "log in" to offer, and distinguishing "wrong token" from "no such page" would
 * confirm to someone guessing that a given string was close.
 */
async function holderOf(
  req: Request,
  res: Response,
): Promise<{ businessId: string; clientId: string } | null> {
  const holder = await resolveMeToken(param(req, 'token'));
  if (!holder) res.status(404).json({ error: 'not found' });
  return holder;
}

export function createMeRouter(redis: Redis, provider: MessagingProvider): Router {
  const router = express.Router();
  const json = express.json({ limit: '4kb' });
  const verifiedHolder = async (req: Request, res: Response) => {
    const holder = await holderOf(req, res);
    if (!holder) return null;
    const proof = z
      .string()
      .regex(/^[A-Za-z0-9_-]{32}$/)
      .safeParse(req.body?.verificationProof);
    const client = await Client.findById(holder.clientId).select('phone').lean().maxTimeMS(5000);
    const contact = proof.success
      ? await verifiedContact(redis, holder.businessId, proof.data)
      : null;
    if (
      !contact ||
      (contact.clientId
        ? contact.clientId !== holder.clientId
        : !client?.phone || contact.phone !== normalisePhone(client.phone))
    ) {
      res.status(401).json({ error: 'Verify your WhatsApp number to manage appointments' });
      return null;
    }
    return holder;
  };

  /**
   * Personal, and never cached by anything between here and the browser. A
   * shared cache holding this would serve one customer's appointments to the
   * next person behind the same proxy.
   */
  router.use((_req, res, next) => {
    res.setHeader('Cache-Control', 'private, no-store');
    // The token is in the path, so an outbound link would leak it in Referer.
    res.setHeader('Referrer-Policy', 'no-referrer');
    next();
  });
  router.post(
    '/:token/verification',
    rateLimit(redis, 'me-verify', 10, 3600),
    json,
    safely(async (req, res) => {
      const holder = await holderOf(req, res);
      if (!holder) return;
      const client = await Client.findById(holder.clientId)
        .select('phone lids')
        .lean()
        .maxTimeMS(5000);
      if (!client?.phone && !client?.lids?.length) {
        res
          .status(409)
          .json({ error: 'Please message the business on WhatsApp to verify your identity' });
        return;
      }
      const result = await beginVerification(
        redis,
        provider,
        holder.businessId,
        client.phone ?? null,
        { clientId: holder.clientId, lid: client.lids?.[0] ?? null },
      );
      if (!result.ok) {
        res
          .status(result.reason === 'rate_limited' ? 429 : 503)
          .json({
            error: 'Verification is unavailable. Wait and try again or contact the business.',
          });
        return;
      }
      res.status(201).json(result);
    }),
  );
  router.post(
    '/:token/verification/confirm',
    rateLimit(redis, 'me-verify-confirm', 60, 600),
    json,
    safely(async (req, res) => {
      const holder = await holderOf(req, res);
      const parsed = z
        .object({
          challengeId: z.string().uuid(),
          code: z
            .string()
            .regex(/^\d{6}$/)
            .optional(),
        })
        .safeParse(req.body);
      if (!holder) return;
      if (!parsed.success) {
        res.status(400).json({ error: 'Enter the six-digit code' });
        return;
      }
      const proof = await finishVerification(
        redis,
        holder.businessId,
        parsed.data.challengeId,
        parsed.data.code,
      );
      if (!proof) {
        res.status(400).json({ error: 'Verification is incomplete or expired' });
        return;
      }
      res.json({ verificationProof: proof });
    }),
  );
  router.get(
    '/:token/holders',
    rateLimit(redis, 'me-holders', 120, 600),
    safely(async (req, res) => {
      const holder = await holderOf(req, res);
      if (!holder) return;
      const holders = await AppointmentHolder.find({ ...holder, active: true })
        .limit(20)
        .lean()
        .maxTimeMS(5000);
      res.json({
        holders: holders.map((person) => ({
          id: String(person._id),
          name: person.name,
          active: person.active,
        })),
      });
    }),
  );
  router.post(
    '/:token/holders',
    rateLimit(redis, 'me-holder-save', 30, 3600),
    json,
    safely(async (req, res) => {
      const holder = await verifiedHolder(req, res);
      if (!holder) return;
      const parsed = holderBody.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: 'Enter the appointment-holder name' });
        return;
      }
      try {
        res.status(201).json(await saveHolder(holder.businessId, holder.clientId, parsed.data));
      } catch (error) {
        if (error instanceof ConfigurationConflict) {
          res.status(409).json({ error: error.reason });
          return;
        }
        throw error;
      }
    }),
  );
  router.patch(
    '/:token/holders/:holderId',
    rateLimit(redis, 'me-holder-save', 30, 3600),
    json,
    safely(async (req, res) => {
      const holder = await verifiedHolder(req, res);
      if (!holder) return;
      const parsed = holderBody.safeParse(req.body);
      const id = objectId.safeParse(param(req, 'holderId'));
      if (!parsed.success || !id.success) {
        res.status(400).json({ error: 'Enter an appointment-holder name' });
        return;
      }
      try {
        const saved = await saveHolder(holder.businessId, holder.clientId, parsed.data, id.data);
        if (!saved) {
          res.status(404).json({ error: 'not found' });
          return;
        }
        res.json(saved);
      } catch (error) {
        if (error instanceof ConfigurationConflict) {
          res.status(409).json({ error: error.reason });
          return;
        }
        throw error;
      }
    }),
  );
  router.post(
    '/:token/revoke',
    rateLimit(redis, 'me-revoke', 5, 3600),
    json,
    safely(async (req, res) => {
      const holder = await verifiedHolder(req, res);
      if (!holder) return;
      const token = newMeToken();
      const profile = await ClientProfile.findOneAndUpdate(
        { ...holder, meToken: param(req, 'token') },
        { $set: { meToken: token, meTokenExpiresAt: new Date(Date.now() + 180 * 86400000) } },
        { new: true },
      ).maxTimeMS(5000);
      if (!profile) {
        res.status(409).json({ error: 'The link has changed' });
        return;
      }
      res.json({ customerToken: token });
    }),
  );
  router.post(
    '/:token/bookings/:bookingId/cancel',
    rateLimit(redis, 'me-cancel', 20, 3600),
    json,
    safely(async (req, res) => {
      const holder = await verifiedHolder(req, res);
      if (!holder) return;
      const parsed = objectId.safeParse(param(req, 'bookingId'));
      if (!parsed.success) {
        res.status(404).json({ error: 'not found' });
        return;
      }
      const booking = await Booking.findOne({ _id: parsed.data, ...holder }).maxTimeMS(5000);
      if (!booking) {
        res.status(404).json({ error: 'not found' });
        return;
      }
      if (booking.startsAt <= new Date()) {
        res
          .status(409)
          .json({ error: 'This appointment has started. Contact the business to change it.' });
        return;
      }
      const result = await setBookingOutcome(
        parsed.data,
        holder.businessId,
        BOOKING_STATUS.CANCELLED,
        {
          actor: 'customer',
          expectStatus: booking.status,
          expectRevision: booking.revision,
          futureOnly: true,
        },
      );
      if (!result.ok) {
        res.status(409).json({ error: 'The appointment has already changed' });
        return;
      }
      res.status(204).end();
    }),
  );
  router.post(
    '/:token/bookings/:bookingId/reschedule',
    rateLimit(redis, 'me-move', 20, 3600),
    json,
    safely(async (req, res) => {
      const holder = await verifiedHolder(req, res);
      if (!holder) return;
      const parsed = z
        .object({ startsAt: z.string().datetime({ offset: true }), staffId: objectId.optional() })
        .safeParse(req.body);
      if (!parsed.success || !objectId.safeParse(param(req, 'bookingId')).success) {
        res.status(400).json({ error: 'Choose a valid appointment time' });
        return;
      }
      const booking = await Booking.findOne({ _id: param(req, 'bookingId'), ...holder }).maxTimeMS(
        5000,
      );
      if (!booking) {
        res.status(404).json({ error: 'not found' });
        return;
      }
      if (booking.startsAt <= new Date()) {
        res
          .status(409)
          .json({ error: 'This appointment has started. Contact the business to change it.' });
        return;
      }
      const result = await rescheduleBooking(
        { redis, provider },
        {
          businessId: holder.businessId,
          bookingId: String(booking._id),
          clientId: holder.clientId,
          startsAt: new Date(parsed.data.startsAt),
          ...(parsed.data.staffId ? { staffId: parsed.data.staffId } : {}),
        },
      );
      if (!result.ok) {
        res
          .status(409)
          .json({
            error: 'That appointment could not be moved. Refresh availability and try again.',
            reason: result.reason,
          });
        return;
      }
      res.json(result);
    }),
  );
  router.get(
    '/:token/bookings/:bookingId/availability',
    rateLimit(redis, 'me-move-offers', 120, 600),
    safely(async (req, res) => {
      const holder = await holderOf(req, res);
      if (!holder) return;
      const parsed = z
        .object({ date: z.string().refine(isCalendarDate, 'Choose a valid calendar date') })
        .safeParse(req.query);
      if (!parsed.success || !objectId.safeParse(param(req, 'bookingId')).success) {
        res.status(400).json({ error: 'Choose a valid date' });
        return;
      }
      const booking = await Booking.findOne({ _id: param(req, 'bookingId'), ...holder }).maxTimeMS(
        5000,
      );
      if (!booking) {
        res.status(404).json({ error: 'not found' });
        return;
      }
      const slots = await getAvailability(redis, {
        businessId: holder.businessId,
        serviceId: booking.serviceId,
        staffId: booking.staffId,
        date: parsed.data.date,
        ignoreBookingId: String(booking._id),
      });
      res.json({ slots: slots.map(toPublicSlot) });
    }),
  );

  router.get(
    '/:token',
    // Generous: this is the page load, and a customer refreshing is not an attack.
    // Tight enough that the endpoint is not a token oracle to hammer.
    rateLimit(redis, 'me', 120, 10 * 60),
    safely(async (req, res) => {
      const holder = await holderOf(req, res);
      if (!holder) return;

      const view = await meView(holder.businessId, holder.clientId);
      if (!view) {
        res.status(404).json({ error: 'not found' });
        return;
      }
      res.json(view);
    }),
  );

  /** Open times for the customer's usual service, or any service of that business. */
  router.get(
    '/:token/availability',
    rateLimit(redis, 'me-availability', 240, 10 * 60),
    safely(async (req, res) => {
      const parsed = availabilityQuery.safeParse(req.query);
      if (!parsed.success) {
        res.status(400).json({ error: 'invalid query', fields: fieldErrors(parsed.error) });
        return;
      }
      const holder = await holderOf(req, res);
      if (!holder) return;

      /**
       * The serviceId comes from the request, so it is checked against the
       * token's business by `getAvailability` resolving it there — a service id
       * from another tenant loads no context and yields no slots.
       */
      const slots = await getAvailability(redis, { businessId: holder.businessId, ...parsed.data });
      res.json({ slots: slots.map(toPublicSlot) });
    }),
  );

  /**
   * Hold a time while the customer confirms. `source: 'web'` is fixed here, as
   * it is on the public router: the TTL is the web's two minutes and never
   * something a caller may pick.
   */
  router.post(
    '/:token/holds',
    rateLimit(redis, 'me-hold', 30, 10 * 60),
    json,
    safely(async (req, res) => {
      const parsed = holdBody.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: 'invalid hold', fields: fieldErrors(parsed.error) });
        return;
      }
      const holder = await holderOf(req, res);
      if (!holder) return;

      const result = await holdSlot(redis, {
        businessId: holder.businessId,
        serviceId: parsed.data.serviceId,
        staffId: parsed.data.staffId,
        startsAt: new Date(parsed.data.startsAt),
        source: 'web',
      });
      if (!result.ok) {
        refuse(res, result.reason);
        return;
      }

      const hold: PublicHold = {
        token: result.hold.token,
        staffId: result.hold.staffId,
        startsAt: result.hold.startsAt.toISOString(),
        expiresAt: result.hold.expiresAt.toISOString(),
      };
      res.status(201).json(hold);
    }),
  );

  /**
   * The rebook. One tap in the page's terms: the customer never re-enters a
   * name, a number, a service or a staff member — only a time.
   *
   * `clientId` comes from the token and is never in the body, which is the whole
   * reason this endpoint exists rather than the page posting to the public
   * booking route with a phone number it would have to be told.
   */
  router.post(
    '/:token/bookings',
    rateLimit(redis, 'me-book', 10, 60 * 60),
    json,
    safely(async (req, res) => {
      const parsed = bookingBody.safeParse(req.body);
      if (!parsed.success) {
        res
          .status(400)
          .json({ error: 'Check the highlighted fields.', fields: fieldErrors(parsed.error) });
        return;
      }
      const holder = await verifiedHolder(req, res);
      if (!holder) return;

      const result = await bookAsClient({ redis, provider }, holder.businessId, {
        clientId: holder.clientId,
        serviceId: parsed.data.serviceId,
        staffId: parsed.data.staffId,
        startsAt: new Date(parsed.data.startsAt),
        holdToken: parsed.data.holdToken,
        ...(parsed.data.appointmentHolderId
          ? { appointmentHolderId: parsed.data.appointmentHolderId }
          : {}),
      });

      if (!result.ok) {
        refuse(
          res,
          result.reason,
          result.reason === 'slot_taken' ? { alternatives: result.alternatives } : {},
        );
        return;
      }

      logger.info(
        { businessId: holder.businessId, bookingId: result.receipt.id },
        'rebooked from /me',
      );
      res.status(201).json(result.receipt);
    }),
  );

  /**
   * The review screen's answer.
   *
   * Straight into `recordRating`, which re-checks that the booking is completed
   * and belongs to this client at this business — so a bookingId in the body
   * buys nothing but the customer's own appointment. Rating twice is not an
   * error there and is not one here.
   */
  router.post(
    '/:token/reviews',
    rateLimit(redis, 'me-review', 20, 60 * 60),
    json,
    safely(async (req, res) => {
      const parsed = reviewBody.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: 'invalid review', fields: fieldErrors(parsed.error) });
        return;
      }
      const holder = await holderOf(req, res);
      if (!holder) return;

      const result = await recordRating({
        businessId: holder.businessId,
        clientId: holder.clientId,
        bookingId: parsed.data.bookingId,
        rating: parsed.data.rating,
      });

      if (!result.ok) {
        res.status(404).json({ error: 'There is nothing to rate here.', reason: result.reason });
        return;
      }

      // Only ever on a published review, exactly as the WhatsApp path does it:
      // attachComment refuses to make a private rating public.
      if (parsed.data.comment) {
        await attachComment(holder.businessId, parsed.data.bookingId, parsed.data.comment);
      }

      /**
       * Disarm the WhatsApp question, if one was outstanding.
       *
       * Not for correctness — `recordRating` is idempotent on the unique
       * bookingId, so a later `5` would be answered with the same thank-you.
       * It is so that a customer who rated here and then types `4` to pick the
       * fourth service gets the fourth service.
       */
      await clearPendingPrompt(redis, holder.businessId, holder.clientId).catch((err) =>
        logger.warn({ err, businessId: holder.businessId }, 'could not clear the rating prompt'),
      );

      res.status(201).json({ published: result.published, alreadyRated: result.alreadyRated });
    }),
  );

  return router;
}
