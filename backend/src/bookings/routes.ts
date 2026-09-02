import express, { type Router } from 'express';
import { z } from 'zod';
import type { Redis } from 'ioredis';
import { ANY_STAFF, type BookingResult } from '@scalivo/shared';
import { requireAuth, requireTenant } from '../auth/middleware.js';
import { logger } from '../lib/logger.js';
import { getAvailability, nextAvailable } from './availability.js';
import { cancelBooking, createBooking, holdSlot } from './create.js';

/**
 * Booking over HTTP: the web and owner surfaces, and the shape the WhatsApp FSM
 * will call directly rather than over the wire.
 *
 * Mounted under /businesses/:businessId so requireTenant() runs before every
 * handler — a cross-tenant request is refused without a query being issued.
 */

const availabilityQuery = z.object({
  serviceId: z.string().min(1),
  /** Business-local calendar date, not an instant. */
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'expected YYYY-MM-DD'),
  staffId: z.string().min(1).optional(),
});

const holdBody = z.object({
  serviceId: z.string().min(1),
  startsAt: z.string().datetime({ offset: true }),
  staffId: z.string().min(1).default(ANY_STAFF),
  source: z.enum(['whatsapp', 'web', 'owner']).default('web'),
});

const bookingBody = z.object({
  serviceId: z.string().min(1),
  staffId: z.string().min(1),
  clientId: z.string().min(1),
  startsAt: z.string().datetime({ offset: true }),
  holdToken: z.string().min(1),
  source: z.enum(['whatsapp', 'web', 'owner']).default('web'),
});

/**
 * Express 5 types a route param as `string | string[]` because a wildcard can
 * repeat. Ours never do, but the narrowing has to happen somewhere — and
 * requireTenant has already refused anything that is not a plain string.
 */
function param(req: express.Request, name: string): string {
  const value = req.params[name];
  return typeof value === 'string' ? value : '';
}

function fieldErrors(error: z.ZodError): Record<string, string> {
  const fields: Record<string, string> = {};
  for (const issue of error.issues) {
    const key = issue.path[0];
    if (typeof key === 'string' && !fields[key]) fields[key] = issue.message;
  }
  return fields;
}

/**
 * How a refusal reaches the caller.
 *
 * 409 for slot_taken and hold_expired because both mean "the world moved", not
 * "you sent something wrong" — the client's correct response is to re-read
 * availability, and the app already treats 409 as a message worth showing.
 */
const STATUS: Record<Exclude<BookingResult, { ok: true }>['reason'], number> = {
  slot_taken: 409,
  hold_expired: 409,
  invalid_slot: 400,
  outside_hours: 400,
  too_soon: 400,
  beyond_horizon: 400,
  no_staff: 400,
};

const MESSAGE: Record<Exclude<BookingResult, { ok: true }>['reason'], string> = {
  slot_taken: 'That slot just went',
  hold_expired: 'That slot is no longer held for you',
  invalid_slot: 'That is not a bookable time',
  outside_hours: 'That time is outside working hours',
  too_soon: 'That is too soon to book',
  beyond_horizon: 'That is too far ahead to book',
  no_staff: 'Nobody is available for that service',
};

export function createBookingRouter(redis: Redis): Router {
  const router = express.Router();
  const json = express.json();

  /**
   * Held and booked slots are absent from this list, never marked unavailable
   * (SPEC §4.2). On WhatsApp the customer is reading a numbered list, and
   * offering a time they cannot have costs a whole round trip.
   */
  router.get('/:businessId/availability', requireAuth, requireTenant(), async (req, res) => {
    const parsed = availabilityQuery.safeParse(req.query);
    if (!parsed.success) {
      res.status(400).json({ error: 'invalid query', fields: fieldErrors(parsed.error) });
      return;
    }

    const { staffId, ...rest } = parsed.data;
    const slots = await getAvailability(redis, {
      businessId: param(req, 'businessId'),
      ...rest,
      ...(staffId ? { staffId } : {}),
    });
    res.json({ slots });
  });

  /** The next few openings, for "nothing that day" replies. */
  router.get('/:businessId/availability/next', requireAuth, requireTenant(), async (req, res) => {
    const serviceId = req.query.serviceId;
    if (typeof serviceId !== 'string') {
      res.status(400).json({ error: 'serviceId is required' });
      return;
    }

    const staffId = typeof req.query.staffId === 'string' ? req.query.staffId : '';
    const slots = await nextAvailable(redis, param(req, 'businessId'), serviceId, {
      ...(staffId ? { staffId } : {}),
    });
    res.json({ slots });
  });

  /**
   * Reserve while the customer decides. Answers with the staff member actually
   * held — the caller may have asked for ANY_STAFF, and the booking must name
   * a person.
   */
  router.post('/:businessId/holds', requireAuth, requireTenant(), json, async (req, res) => {
    const parsed = holdBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'invalid hold', fields: fieldErrors(parsed.error) });
      return;
    }

    const result = await holdSlot(redis, {
      businessId: param(req, 'businessId'),
      serviceId: parsed.data.serviceId,
      startsAt: new Date(parsed.data.startsAt),
      staffId: parsed.data.staffId,
      source: parsed.data.source,
    });

    if (!result.ok) {
      res.status(STATUS[result.reason]).json({ error: MESSAGE[result.reason], reason: result.reason });
      return;
    }
    res.status(201).json(result.hold);
  });

  router.post('/:businessId/bookings', requireAuth, requireTenant(), json, async (req, res) => {
    const parsed = bookingBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'invalid booking', fields: fieldErrors(parsed.error) });
      return;
    }

    try {
      const result = await createBooking(redis, {
        businessId: param(req, 'businessId'),
        ...parsed.data,
        startsAt: new Date(parsed.data.startsAt),
      });

      if (!result.ok) {
        res.status(STATUS[result.reason]).json({
          error: MESSAGE[result.reason],
          reason: result.reason,
          // Losing a race is normal traffic — send somewhere to go next, not
          // just a refusal.
          ...(result.reason === 'slot_taken' ? { alternatives: result.alternatives } : {}),
        });
        return;
      }

      res.status(201).json(result.booking);
    } catch (err) {
      logger.error({ err, businessId: param(req, 'businessId') }, 'booking failed');
      res.status(500).json({ error: 'could not create the booking' });
    }
  });

  router.post(
    '/:businessId/bookings/:bookingId/cancel',
    requireAuth,
    requireTenant(),
    async (req, res) => {
      const cancelled = await cancelBooking(param(req, 'bookingId'), param(req, 'businessId'));
      if (!cancelled) {
        res.status(404).json({ error: 'not found' });
        return;
      }
      res.status(204).end();
    },
  );

  return router;
}
