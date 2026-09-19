import express, { type Router } from 'express';
import { z } from 'zod';
import type { Redis } from 'ioredis';
import {
  ANY_STAFF,
  BOOKING_STATUS,
  type BookingResult,
  type MessagingProvider,
} from '@scalivo/shared';
import { requireAuth, requireTenant } from '../auth/middleware.js';
import { logger } from '../lib/logger.js';
import { getAvailability, nextAvailable } from './availability.js';
import { createBooking, holdSlot, rescheduleBooking } from './create.js';
import { setBookingOutcome } from './outcome.js';
import { confirmBooking } from '../notifications/confirm.js';
import { fieldErrors, param } from '../http/params.js';
import { Booking } from '../models/Booking.js';

/** The owner can mark an appointment done or missed; cancel has its own route. */
const outcomeBody = z.object({
  outcome: z.enum([BOOKING_STATUS.COMPLETED, BOOKING_STATUS.NO_SHOW]),
});

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

const rescheduleBody = z.object({
  startsAt: z.string().datetime({ offset: true }),
  staffId: z.string().min(1),
  holdToken: z.string().min(1),
});

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

export function createBookingRouter(redis: Redis, provider: MessagingProvider): Router {
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

      /**
       * This route is owner-authenticated, so the booking is made on the
       * customer's behalf rather than by them — which makes it the same case as
       * a walk-in: nobody is waiting to say yes, and the only written record the
       * customer gets of a time someone else chose is the confirmation.
       *
       * It runs after the response is decided but before it is sent, so the app
       * receives the CONFIRMED status rather than a PENDING one it would have to
       * poll away. A confirmation that cannot be sent does not fail the booking;
       * it stays queued and the row records why.
       */
      const confirmed = await confirmBooking(
        { redis, provider },
        param(req, 'businessId'),
        result.booking.id,
      ).catch((err) => {
        logger.error({ err, bookingId: result.booking.id }, 'could not confirm booking');
        return null;
      });

      res.status(201).json({
        ...result.booking,
        ...(confirmed ? { status: BOOKING_STATUS.CONFIRMED } : {}),
      });
    } catch (err) {
      logger.error({ err, businessId: param(req, 'businessId') }, 'booking failed');
      res.status(500).json({ error: 'could not create the booking' });
    }
  });

  router.patch(
    '/:businessId/bookings/:bookingId/cancel',
    requireAuth,
    requireTenant(),
    async (req, res) => {
      // setBookingOutcome rather than cancelBooking: the boolean collapses
      // "already cancelled" and "never existed" into one answer, and the app
      // shows those very differently — a stale screen versus an error.
      const result = await setBookingOutcome(
        param(req, 'bookingId'),
        param(req, 'businessId'),
        BOOKING_STATUS.CANCELLED,
      );

      if (!result.ok) {
        res
          .status(result.reason === 'not_found' ? 404 : 409)
          .json({
            error: result.reason === 'not_found' ? 'not found' : 'already cancelled or completed',
            reason: result.reason,
          });
        return;
      }
      res.status(204).end();
    },
  );

  router.patch(
    '/:businessId/bookings/:bookingId/reschedule',
    requireAuth,
    requireTenant(),
    json,
    async (req, res) => {
      const parsed = rescheduleBody.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: 'invalid reschedule request', fields: fieldErrors(parsed.error) });
        return;
      }

      try {
        const result = await rescheduleBooking(redis, {
          businessId: param(req, 'businessId'),
          bookingId: param(req, 'bookingId'),
          startsAt: new Date(parsed.data.startsAt),
          staffId: parsed.data.staffId,
          holdToken: parsed.data.holdToken,
          override: true, // It's an owner-authenticated route, skip minNoticeMinutes
        });

        if (!result.ok) {
          const isNotFoundOrTerminal = result.reason === 'not_found' || result.reason === 'already_terminal';
          res.status(isNotFoundOrTerminal ? (result.reason === 'not_found' ? 404 : 409) : STATUS[result.reason]).json({
            error: isNotFoundOrTerminal ? (result.reason === 'not_found' ? 'not found' : 'already cancelled or completed') : MESSAGE[result.reason],
            reason: result.reason,
            ...(result.reason === 'slot_taken' ? { alternatives: result.alternatives } : {}),
          });
          return;
        }

        res.status(200).json(result.booking);
      } catch (err) {
        logger.error({ err, businessId: param(req, 'businessId'), bookingId: param(req, 'bookingId') }, 'reschedule failed');
        res.status(500).json({ error: 'could not reschedule the booking' });
      }
    }
  );

  /**
   * Mark an appointment done or missed. This is what feeds the CRM — until a
   * booking is completed nobody has visited, so without this endpoint every
   * profile stays at zero visits forever.
   *
   * `already_terminal` is deliberately not an error the app shows as a failure:
   * it means someone else got there first, which is a stale screen rather than
   * a problem.
   */
  router.post(
    '/:businessId/bookings/:bookingId/outcome',
    requireAuth,
    requireTenant(),
    json,
    async (req, res) => {
      const parsed = outcomeBody.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: 'invalid outcome', fields: fieldErrors(parsed.error) });
        return;
      }

      const bookingId = param(req, 'bookingId');
      const businessId = param(req, 'businessId');

      const booking = await Booking.findOne({ _id: bookingId, businessId });
      if (!booking) {
        res.status(404).json({ error: 'not found', reason: 'not_found' });
        return;
      }

      const TERMINAL: typeof booking.status[] = [BOOKING_STATUS.COMPLETED, BOOKING_STATUS.NO_SHOW, BOOKING_STATUS.CANCELLED];
      if (TERMINAL.includes(booking.status)) {
        res.status(409).json({ error: 'already marked', reason: 'already_terminal' });
        return;
      }

      if (booking.status !== BOOKING_STATUS.CONFIRMED) {
        res.status(400).json({ error: 'Booking must be confirmed before marking complete or no-show', reason: 'invalid_status' });
        return;
      }

      if (booking.startsAt.getTime() > Date.now()) {
        res.status(400).json({ error: 'Booking has not started yet', reason: 'not_yet_occurred' });
        return;
      }

      const result = await setBookingOutcome(
        bookingId,
        businessId,
        parsed.data.outcome,
      );

      if (!result.ok) {
        res
          .status(result.reason === 'not_found' ? 404 : 409)
          .json({ error: result.reason === 'not_found' ? 'not found' : 'already marked', reason: result.reason });
        return;
      }
      res.status(204).end();
    },
  );

  /**
   * Pending → confirmed, and the customer is told. Not a CRM event: nothing
   * about their history has changed yet.
   *
   * `changed: false` is a 409 rather than a 204 because the app renders the two
   * differently — a stale screen, not an error — and because confirming twice
   * must not read as having sent two confirmations. It has not: the dedupe claim
   * on the notification refuses the second.
   */
  router.post(
    '/:businessId/bookings/:bookingId/confirm',
    requireAuth,
    requireTenant(),
    async (req, res) => {
      const result = await confirmBooking(
        { redis, provider },
        param(req, 'businessId'),
        param(req, 'bookingId'),
      );

      if (!result.ok) {
        res
          .status(result.reason === 'not_found' ? 404 : 409)
          .json({ error: 'cannot confirm this booking', reason: result.reason });
        return;
      }
      if (!result.changed) {
        res.status(409).json({ error: 'not a pending booking' });
        return;
      }
      res.status(204).end();
    },
  );

  return router;
}
