import { isCalendarDate } from '../lib/time.js';
import { isUsableName } from '../lib/name.js';
import express, { type Request, type RequestHandler, type Router } from 'express';
import { z } from 'zod';
import type { Redis } from 'ioredis';
import {
  ANY_STAFF,
  FUNNEL_EVENTS,
  GROW_CHANNELS,
  type MessagingProvider,
  type PublicBookingError,
  type PublicHold,
} from '@scalivo/shared';
import { env } from '../config/env.js';
import { fieldErrors, param } from '../http/params.js';
import { TOO_MANY, rateLimit, safely } from '../http/guards.js';
import { createMeRouter } from '../me/routes.js';
import { getSequenceAvailability } from '../bookings/sequence.js';
import { getAvailability } from '../bookings/availability.js';
import { holdSlot } from '../bookings/create.js';
import {
  facets,
  featuredReviews,
  getBusinessBySlug,
  listBusinesses,
  listSlugs,
  publishedBusiness,
  publishedBusinessId,
} from './profiles.js';
import { recordFunnelEvent } from '../grow/funnel.js';
import { bookSequenceFromWeb, bookFromWeb, releaseWebHold, toPublicSlot } from './booking.js';
import { beginVerification, finishVerification, verifiedPhone } from './verification.js';
import { normalisePhone } from '../lib/phone.js';

/**
 * The anonymous surface: the marketplace reads, web booking, and the customer's
 * own page.
 *
 * Deliberately its own router, mounted at /public and never under /businesses.
 * Everything under /businesses is `requireAuth, requireTenant()`, and tenancy is
 * the one idea that cannot apply to a stranger. Here the equivalent gate is
 * PUBLISHED: every handler below resolves a business through a published-only
 * lookup, so an unpublished business is a 404 on every route, reads and writes
 * alike.
 *
 * Addressed by slug, not id. The slug is what is in the URL the customer
 * opened, and it means an internal id never has to leave the server just so the
 * booking form can name its business.
 *
 * `/me` (milestone 3.3) is mounted here for the CORS headers and nothing else —
 * its gate is a token, not publication, and me/routes.ts explains why it must
 * not inherit this one.
 */

/** A Mongo ObjectId. Checked up front: a malformed id reaching a query throws a CastError, i.e. a 500. */
const objectId = z.string().regex(/^[a-f0-9]{24}$/i, 'not a valid id');

const listQuery = z.object({
  q: z.string().trim().max(100).optional(),
  category: z.string().trim().max(40).optional(),
  city: z.string().trim().max(60).optional(),
});

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

const releaseBody = z.object({
  token: z.string().uuid(),
  serviceId: objectId,
  staffId: objectId,
  startsAt: z.string().datetime({ offset: true }),
});

const bookingBody = z.object({
  serviceId: objectId,
  staffId: objectId,
  startsAt: z.string().datetime({ offset: true }),
  holdToken: z.string().uuid(),
  name: z
    .string()
    .trim()
    .min(1, 'tell us your name')
    .max(80)
    .refine(isUsableName, 'Enter the name of the person receiving treatment'),
  phone: z.string().trim().min(7, 'enter your WhatsApp number').max(20),
  verificationProof: z.string().regex(/^[A-Za-z0-9_-]{32}$/),
  appointmentHolderId: objectId.optional(),
  // Attribution, not input the booking depends on: an unknown value is
  // "direct", never a refused booking.
  channel: z.enum(GROW_CHANNELS).optional().catch(undefined),
});

/**
 * A funnel beacon. The visitor id is a random value the browser made up and
 * kept — not a person, not a cookie anyone else can read — and exists only so a
 * reload is not a second visitor.
 */
const eventBody = z.object({
  type: z.enum(FUNNEL_EVENTS),
  channel: z.enum(GROW_CHANNELS).catch('direct'),
  visitorId: z.string().regex(/^[A-Za-z0-9_-]{16,64}$/),
});

/** Crawlers and link previewers that run scripts. Counting them would fill the funnel with nobody. */
const AUTOMATED = /bot|crawl|spider|slurp|headless|lighthouse|preview|facebookexternalhit/i;

const STATUS: Record<PublicBookingError, number> = {
  slot_taken: 409,
  hold_expired: 409,
  invalid_slot: 400,
  outside_hours: 400,
  too_soon: 400,
  beyond_horizon: 400,
  no_staff: 400,
  invalid_phone: 400,
  rate_limited: 429,
};

/** Written for the customer, not the developer — the web shows these as they are. */
const MESSAGE: Record<PublicBookingError, string> = {
  slot_taken: 'Someone just booked that time. Pick another.',
  hold_expired: 'Your time was only held for two minutes. Pick it again to continue.',
  invalid_slot: 'That time is not bookable.',
  outside_hours: 'That time is outside opening hours.',
  too_soon: 'That time is too soon to book online.',
  beyond_horizon: 'That date is too far ahead to book.',
  no_staff: 'Nobody is available for that service at that time.',
  invalid_phone: 'Enter a WhatsApp number we can send your confirmation to.',
  rate_limited: TOO_MANY,
};

const refuse = (res: express.Response, reason: PublicBookingError, extra: object = {}) =>
  res.status(STATUS[reason]).json({ error: MESSAGE[reason], reason, ...extra });

/**
 * The browser-facing part of CORS, for the booking steps.
 *
 * An allowlist, never a reflected wildcard. Development loopback origins are
 * already answered by the global middleware in index.ts.
 */
const cors: RequestHandler = (req, res, next) => {
  const origin = req.headers.origin;
  if (origin && env.WEB_ORIGINS.includes(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    if (req.method === 'OPTIONS') {
      res.sendStatus(204);
      return;
    }
  }
  next();
};

/** Resolve the slug to a PUBLISHED business, or answer 404 and return null. */
async function businessFor(req: Request, res: express.Response): Promise<string | null> {
  const id = await publishedBusinessId(param(req, 'slug'));
  if (!id) res.status(404).json({ error: 'not found' });
  return id;
}

export function createPublicRouter(redis: Redis, provider: MessagingProvider): Router {
  const router = express.Router();
  const json = express.json({ limit: '4kb' });

  router.use(cors);

  // Mounted inside this router so it picks up `cors` above, and nothing else.
  router.use('/me', createMeRouter(redis, provider));

  router.post(
    '/businesses/:slug/verification',
    rateLimit(redis, 'verify-start', 10, 3600),
    json,
    safely(async (req, res) => {
      const parsed = z.object({ phone: z.string().trim().min(7).max(20) }).safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: 'Enter your WhatsApp number' });
        return;
      }
      const businessId = await businessFor(req, res);
      if (!businessId) return;
      const result = await beginVerification(redis, provider, businessId, parsed.data.phone);
      if (!result.ok) {
        res
          .status(
            result.reason === 'rate_limited' ? 429 : result.reason === 'unavailable' ? 503 : 400,
          )
          .json({
            error:
              result.reason === 'rate_limited'
                ? TOO_MANY
                : 'Verification is unavailable. Check your number or contact the business.',
          });
        return;
      }
      res.status(201).json(result);
    }),
  );
  router.post(
    '/businesses/:slug/verification/confirm',
    rateLimit(redis, 'verify-confirm', 60, 600),
    json,
    safely(async (req, res) => {
      const parsed = z
        .object({
          challengeId: z.string().uuid(),
          code: z
            .string()
            .regex(/^\d{6}$/)
            .optional(),
        })
        .safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: 'Enter the six-digit code' });
        return;
      }
      const businessId = await businessFor(req, res);
      if (!businessId) return;
      const proof = await finishVerification(
        redis,
        businessId,
        parsed.data.challengeId,
        parsed.data.code,
      );
      if (!proof) {
        res
          .status(400)
          .json({
            error:
              'Verification is incomplete or expired. Check the code or send the WhatsApp message.',
          });
        return;
      }
      res.json({ verificationProof: proof });
    }),
  );

  /* ------------------------------------------------------------------ reads */

  router.get(
    '/businesses',
    safely(async (req, res) => {
      const parsed = listQuery.safeParse(req.query);
      if (!parsed.success) {
        res.status(400).json({ error: 'invalid query', fields: fieldErrors(parsed.error) });
        return;
      }
      res.json(await listBusinesses(parsed.data));
    }),
  );

  // Before /:slug, or "slugs" would be looked up as a business called "slugs".
  router.get(
    '/businesses/slugs',
    safely(async (_req, res) => {
      res.json(await listSlugs());
    }),
  );

  router.get(
    '/businesses/:slug',
    safely(async (req, res) => {
      const business = await getBusinessBySlug(param(req, 'slug'));
      if (!business) {
        res.status(404).json({ error: 'not found' });
        return;
      }
      res.json(business);
    }),
  );

  router.get(
    '/facets',
    safely(async (_req, res) => {
      res.json(await facets());
    }),
  );

  router.get(
    '/reviews',
    safely(async (req, res) => {
      const limit = Math.min(Math.max(Number(req.query.limit) || 8, 1), 24);
      res.json(await featuredReviews(limit));
    }),
  );

  /**
   * Profile views and booking-form starts, for the owner's Grow funnel.
   *
   * Sent as text/plain so the browser treats it as a simple request — no CORS
   * preflight doubling every page view — and with keepalive, so a customer who
   * taps away mid-send is still counted. Always 204: the page never waits on
   * this, and a refusal would tell a scraper nothing useful anyway.
   */
  router.post(
    '/businesses/:slug/events',
    // Generous: mobile carriers put whole neighbourhoods behind one address,
    // and losing a count is cheap next to losing a customer's booking.
    rateLimit(redis, 'event', 300, 10 * 60),
    express.text({ type: ['text/plain', 'application/json'], limit: '1kb' }),
    safely(async (req, res) => {
      if (AUTOMATED.test(req.get('user-agent') ?? '')) {
        res.status(204).end();
        return;
      }

      let raw: unknown;
      try {
        raw = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
      } catch {
        raw = null;
      }
      const parsed = eventBody.safeParse(raw);
      if (!parsed.success) {
        res.status(400).json({ error: 'invalid event' });
        return;
      }

      const business = await publishedBusiness(param(req, 'slug'));
      if (!business) {
        res.status(404).json({ error: 'not found' });
        return;
      }

      await recordFunnelEvent(redis, {
        businessId: business.id,
        timezone: business.timezone,
        ...parsed.data,
      });
      res.status(204).end();
    }),
  );

  /* ---------------------------------------------------------------- booking */

  /**
   * Open times for one service on one business-local day. Held and booked
   * times are absent, never marked unavailable (SPEC §4.2).
   */
  router.get(
    '/businesses/:slug/availability',
    safely(async (req, res) => {
      const parsed = availabilityQuery.safeParse(req.query);
      if (!parsed.success) {
        res.status(400).json({ error: 'invalid query', fields: fieldErrors(parsed.error) });
        return;
      }
      const businessId = await businessFor(req, res);
      if (!businessId) return;

      const slots = await getAvailability(redis, { businessId, ...parsed.data });
      res.json({ slots: slots.map(toPublicSlot) });
    }),
  );

  /**
   * Hold a time for two minutes while the customer types their details.
   * `source` is fixed to 'web' here — never taken from the request — so the
   * TTL is the web's, and a stranger cannot claim the five-minute WhatsApp one.
   */
  router.post(
    '/businesses/:slug/holds',
    rateLimit(redis, 'hold', 30, 10 * 60),
    json,
    safely(async (req, res) => {
      const parsed = holdBody.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: 'invalid hold', fields: fieldErrors(parsed.error) });
        return;
      }
      const businessId = await businessFor(req, res);
      if (!businessId) return;

      const result = await holdSlot(redis, {
        businessId,
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

  router.post(
    '/businesses/:slug/holds/release',
    json,
    safely(async (req, res) => {
      const parsed = releaseBody.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: 'invalid release', fields: fieldErrors(parsed.error) });
        return;
      }
      const businessId = await businessFor(req, res);
      if (!businessId) return;

      await releaseWebHold({ redis }, businessId, {
        ...parsed.data,
        startsAt: new Date(parsed.data.startsAt),
      });
      res.status(204).end();
    }),
  );

  router.post(
    '/businesses/:slug/sequences/availability',
    rateLimit(redis, 'sequence-offers', 60, 600),
    json,
    safely(async (req, res) => {
      const parsed = z
        .object({
          date: z.string().refine(isCalendarDate, 'Choose a valid calendar date'),
          steps: z
            .array(z.object({ serviceId: objectId, staffId: objectId }))
            .min(2)
            .max(5),
        })
        .safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: 'Choose services, staff and a valid date' });
        return;
      }
      const businessId = await businessFor(req, res);
      if (!businessId) return;
      const slots = await getSequenceAvailability(redis, {
        businessId,
        ...parsed.data,
        source: 'web',
      });
      res.json({
        slots: slots.map((slot) => ({ ...slot, startsAt: slot.startsAt.toISOString() })),
      });
    }),
  );
  router.post(
    '/businesses/:slug/sequences',
    rateLimit(redis, 'book', 10, 3600),
    json,
    safely(async (req, res) => {
      const parsed = bookingBody
        .pick({ name: true, phone: true, verificationProof: true, startsAt: true })
        .extend({
          steps: z
            .array(z.object({ serviceId: objectId, staffId: objectId }))
            .min(2)
            .max(5),
          requestId: z.string().regex(/^[A-Za-z0-9_-]{32}$/),
        })
        .safeParse(req.body);
      if (!parsed.success) {
        res
          .status(400)
          .json({ error: 'Check the booking details.', fields: fieldErrors(parsed.error) });
        return;
      }
      const businessId = await businessFor(req, res);
      if (!businessId) return;
      const verified = await verifiedPhone(redis, businessId, parsed.data.verificationProof);
      if (!verified || verified !== normalisePhone(parsed.data.phone)) {
        res
          .status(401)
          .json({
            error: 'Verify your WhatsApp number before booking',
            reason: 'verification_required',
          });
        return;
      }
      const result = await bookSequenceFromWeb({ redis, provider }, businessId, {
        ...parsed.data,
        startsAt: new Date(parsed.data.startsAt),
      });
      if (!result.ok) {
        refuse(res, result.reason);
        return;
      }
      res.status(201).json({ receipts: result.receipts });
    }),
  );

  router.post(
    '/businesses/:slug/bookings',
    rateLimit(redis, 'book', 10, 60 * 60),
    json,
    safely(async (req, res) => {
      const parsed = bookingBody.safeParse(req.body);
      if (!parsed.success) {
        res
          .status(400)
          .json({ error: 'Check the highlighted fields.', fields: fieldErrors(parsed.error) });
        return;
      }
      const businessId = await businessFor(req, res);
      if (!businessId) return;

      const verified = await verifiedPhone(redis, businessId, parsed.data.verificationProof);
      if (!verified || verified !== normalisePhone(parsed.data.phone)) {
        res
          .status(401)
          .json({
            error: 'Verify your WhatsApp number before booking',
            reason: 'verification_required',
          });
        return;
      }
      const result = await bookFromWeb({ redis, provider }, businessId, {
        ...parsed.data,
        startsAt: new Date(parsed.data.startsAt),
      });

      if (!result.ok) {
        refuse(
          res,
          result.reason,
          result.reason === 'slot_taken' ? { alternatives: result.alternatives } : {},
        );
        return;
      }
      res.status(201).json(result.receipt);
    }),
  );

  return router;
}
