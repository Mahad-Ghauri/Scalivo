import express, { type Router } from 'express';
import mongoose from 'mongoose';
import { z } from 'zod';
import { BOOKING_STATUS, type MessagingProvider, type RescheduleResult } from '@scalivo/shared';
import type { Redis } from 'ioredis';
import { BlockedTime } from '../models/BlockedTime.js';
import { Booking } from '../models/Booking.js';
import { Business } from '../models/Business.js';
import { requireAuth, requireTenant } from '../auth/middleware.js';
import { logger } from '../lib/logger.js';
import { getCalendar } from './view.js';
import { rescheduleBooking } from './reschedule.js';
import { createWalkIn } from './walkin.js';
import { fieldErrors, param } from '../http/params.js';
import { wallClockToUtc, isCalendarDate } from '../lib/time.js';
import { Resource } from '../models/Resource.js';
import { Staff } from '../models/Staff.js';
import { configureBooking } from '../bookings/configuration.js';

/**
 * The owner's diary over HTTP.
 *
 * Everything here is owner-facing and tenant-scoped by the mount point, so the
 * questions this file answers are about INPUT rather than authorisation: how
 * wide a range may be asked for, what a half-typed walk-in means, and how a
 * refusal is phrased so the app can tell "you were too slow" apart from "you
 * sent nonsense".
 */

const objectId = z.string().regex(/^[a-f\d]{24}$/i);

/**
 * A month either side is generous for a diary and cheap to serve. Without a cap
 * a mistyped year turns one screen into a full-collection scan, and the failure
 * shows up as a slow app rather than as an error anyone investigates.
 */
const MAX_RANGE_DAYS = 62;

const calendarQuery = z.object({
  from: z.string().refine(isCalendarDate, 'Choose a valid calendar date'),
  /** Inclusive. A day view sends the same date twice. */
  to: z.string().refine(isCalendarDate, 'Choose a valid calendar date'),
  staffId: objectId.optional(),
  includeCancelled: z.coerce.boolean().default(false),
});

const rescheduleBody = z.object({
  startsAt: z.string().datetime({ offset: true }),
  staffId: objectId.optional(),
  /** Owner override: notice period and roster only. Never the grid or a block. */
  override: z.boolean().default(false),
});

const walkInBody = z
  .object({
    serviceId: objectId,
    staffId: objectId,
    startsAt: z.string().datetime({ offset: true }),
    name: z.string().trim().min(1).max(120).optional(),
    phone: z.string().trim().min(1).max(32).optional(),
    clientId: objectId.optional(),
    appointmentHolderId: z
      .string()
      .regex(/^[a-f\d]{24}$/i)
      .optional(),
    additionalServices: z
      .array(
        z.object({
          serviceId: z.string().regex(/^[a-f\d]{24}$/i),
          staffId: z.string().regex(/^[a-f\d]{24}$/i),
        }),
      )
      .max(4)
      .optional(),
    requestId: z
      .string()
      .regex(/^[A-Za-z0-9_-]{32}$/)
      .optional(),
  })
  .refine((body) => Boolean(body.clientId ?? body.name ?? body.phone), {
    message: 'a walk-in needs a name, a phone number, or an existing client',
    path: ['name'],
  });

const blockInstant = z.union([
  z.string().datetime({ offset: true }),
  z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/),
]);

const blockBody = z
  .object({
    /** null blocks the whole business — a holiday, not one person's afternoon. */
    staffId: objectId.nullable().default(null),
    resourceId: z
      .string()
      .regex(/^[a-f\d]{24}$/i)
      .nullable()
      .default(null),
    startsAt: blockInstant,
    endsAt: blockInstant,
    reason: z.string().trim().max(200).optional(),
  })
  .refine((b) => new Date(b.endsAt) > new Date(b.startsAt), {
    message: 'endsAt must be after startsAt',
    path: ['endsAt'],
  })
  .refine((b) => !b.staffId || !b.resourceId, 'Choose staff or a resource, not both')
  .refine(
    (b) => Date.parse(b.endsAt) - Date.parse(b.startsAt) <= 366 * 86400000,
    'Block must be at most one year',
  );

/**
 * 409 means "the world moved while you were looking at it" — re-read and try
 * again. 404 and 400 mean the request itself was wrong. The app renders the two
 * groups very differently, and collapsing them would turn a normal busy-Saturday
 * outcome into an error dialog.
 */
const RESCHEDULE_STATUS: Record<Exclude<RescheduleResult, { ok: true }>['reason'], number> = {
  not_found: 404,
  already_terminal: 409,
  unchanged: 409,
  slot_taken: 409,
  invalid_slot: 400,
  outside_hours: 400,
  too_soon: 400,
  beyond_horizon: 400,
  no_staff: 400,
};

const RESCHEDULE_MESSAGE: Record<Exclude<RescheduleResult, { ok: true }>['reason'], string> = {
  not_found: 'That appointment no longer exists',
  already_terminal: 'That appointment has already been completed, missed or cancelled',
  unchanged: 'That is already the time and staff member for this appointment',
  slot_taken: 'That slot just went',
  invalid_slot: 'That is not a bookable time',
  outside_hours: 'That time is blocked or outside working hours',
  too_soon: 'That is too soon to book',
  beyond_horizon: 'That is too far ahead to book',
  no_staff: 'That staff member cannot perform this service',
};

export function createCalendarRouter(redis: Redis, provider: MessagingProvider): Router {
  const router = express.Router();
  const json = express.json();
  const guard = [requireAuth, requireTenant()] as const;

  /** Day, week or staff view — all the same query, differing only in range. */
  router.get('/:businessId/calendar', ...guard, async (req, res) => {
    const parsed = calendarQuery.safeParse(req.query);
    if (!parsed.success) {
      res.status(400).json({ error: 'invalid query', fields: fieldErrors(parsed.error) });
      return;
    }

    const { from, to, staffId, includeCancelled } = parsed.data;
    // Date-only strings compare correctly as strings in ISO form, and doing it
    // here rather than after the timezone conversion keeps the error about what
    // the caller actually sent.
    if (to < from) {
      res.status(400).json({ error: 'to must not be before from' });
      return;
    }

    const span = (Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000;
    if (span > MAX_RANGE_DAYS) {
      res.status(400).json({ error: `range must be ${MAX_RANGE_DAYS} days or fewer` });
      return;
    }

    const view = await getCalendar({
      businessId: param(req, 'businessId'),
      from,
      to,
      includeCancelled,
      ...(staffId ? { staffId } : {}),
    });

    if (!view) {
      res.status(404).json({ error: 'not found' });
      return;
    }
    res.json(view);
  });

  /**
   * Move an appointment.
   *
   * `notified` is reported separately from `ok` on purpose: the booking has
   * moved either way, and an owner whose customer could not be messaged needs to
   * know to pick up the phone rather than assume it was handled.
   */
  router.post('/:businessId/bookings/:bookingId/reschedule', ...guard, json, async (req, res) => {
    const parsed = rescheduleBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'invalid reschedule', fields: fieldErrors(parsed.error) });
      return;
    }

    try {
      const result = await rescheduleBooking(
        { redis, provider },
        {
          businessId: param(req, 'businessId'),
          bookingId: param(req, 'bookingId'),
          startsAt: new Date(parsed.data.startsAt),
          override: parsed.data.override,
          ...(parsed.data.staffId ? { staffId: parsed.data.staffId } : {}),
        },
      );

      if (!result.ok) {
        res.status(RESCHEDULE_STATUS[result.reason]).json({
          error: RESCHEDULE_MESSAGE[result.reason],
          reason: result.reason,
        });
        return;
      }

      res.json({ booking: result.booking, notified: result.notified });
    } catch (err) {
      logger.error({ err, businessId: param(req, 'businessId') }, 'reschedule failed');
      res.status(500).json({ error: 'could not move the appointment' });
    }
  });

  /** Someone at the desk. Same write path as WhatsApp — see walkin.ts. */
  router.post('/:businessId/walk-ins', ...guard, json, async (req, res) => {
    const parsed = walkInBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'invalid walk-in', fields: fieldErrors(parsed.error) });
      return;
    }

    const { serviceId, staffId, startsAt, name, phone, clientId } = parsed.data;

    try {
      const result = await createWalkIn(
        { redis, provider },
        {
          businessId: param(req, 'businessId'),
          serviceId,
          staffId,
          startsAt: new Date(startsAt),
          ...(name ? { name } : {}),
          ...(phone ? { phone } : {}),
          ...(clientId ? { clientId } : {}),
          ...(parsed.data.additionalServices
            ? { additionalServices: parsed.data.additionalServices }
            : {}),
          ...(parsed.data.requestId ? { requestId: parsed.data.requestId } : {}),
          ...(parsed.data.appointmentHolderId
            ? { appointmentHolderId: parsed.data.appointmentHolderId }
            : {}),
        },
      );

      if (!result.ok) {
        const status = result.reason === 'slot_taken' ? 409 : 400;
        res.status(status).json({ error: 'could not book the walk-in', reason: result.reason });
        return;
      }

      res
        .status(201)
        .json({ booking: result.booking, bookings: result.bookings, clientId: result.clientId });
    } catch (err) {
      logger.error({ err, businessId: param(req, 'businessId') }, 'walk-in failed');
      res.status(500).json({ error: 'could not book the walk-in' });
    }
  });

  /**
   * Declare time off-limits.
   *
   * Deliberately does NOT refuse when appointments already sit inside the range.
   * A block only ever removes future offers; it cannot double-book anything, and
   * the owner blocking Friday because of a funeral has not thereby cancelled the
   * three people already booked. Those appointments are returned instead, so the
   * app can show "3 appointments are inside this block" and let the owner move
   * or cancel them deliberately.
   */
  router.post('/:businessId/blocked-time', ...guard, json, async (req, res) => {
    const parsed = blockBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'invalid block', fields: fieldErrors(parsed.error) });
      return;
    }

    const businessId = param(req, 'businessId');
    const { staffId, resourceId, reason } = parsed.data;
    const business = await Business.findById(businessId).select('_id timezone').maxTimeMS(5000);
    if (!business) {
      res.status(404).json({ error: 'not found' });
      return;
    }

    let startsAt: Date, endsAt: Date;
    try {
      startsAt =
        parsed.data.startsAt.length === 16
          ? wallClockToUtc(parsed.data.startsAt, business.timezone)
          : new Date(parsed.data.startsAt);
      endsAt =
        parsed.data.endsAt.length === 16
          ? wallClockToUtc(parsed.data.endsAt, business.timezone)
          : new Date(parsed.data.endsAt);
      if (endsAt <= startsAt || endsAt.getTime() - startsAt.getTime() > 366 * 86400000)
        throw new Error('invalid block range');
    } catch {
      res.status(400).json({ error: 'Choose valid start and end times' });
      return;
    }

    // Another business's staff id would only make an orphan row here (every
    // block query is scoped by businessId), but it is refused all the same.
    if (staffId && !(await Staff.exists({ _id: staffId, businessId }).maxTimeMS(5000))) {
      res.status(400).json({ error: 'Choose a staff member in this business' });
      return;
    }
    if (
      resourceId &&
      !(await Resource.exists({ _id: resourceId, businessId, active: true }).maxTimeMS(5000))
    ) {
      res.status(400).json({ error: 'Choose an active resource in this business' });
      return;
    }
    const block = await configureBooking(businessId, async (session) => {
      const [created] = await BlockedTime.create(
        [{ businessId, staffId, resourceId, startsAt, endsAt, reason: reason ?? null }],
        { session },
      );
      return created!;
    });

    // Overlap on the appointment's own interval, not just its start — a
    // treatment that began before the block still runs into it.
    const contained = resourceId
      ? await Resource.find({ businessId, fixedRoomId: resourceId })
          .select('_id')
          .limit(201)
          .lean()
          .maxTimeMS(5000)
      : [];
    if (contained.length > 200) throw new Error('resource inventory exceeds limit');
    const affected = await Booking.find({
      businessId,
      ...(staffId ? { staffId } : {}),
      ...(resourceId
        ? { resourceIds: { $in: [resourceId, ...contained.map((asset) => String(asset._id))] } }
        : {}),
      status: { $nin: [BOOKING_STATUS.CANCELLED, BOOKING_STATUS.NO_SHOW] },
      startsAt: { $lt: endsAt },
      $expr: {
        $gt: [
          {
            $add: [
              '$startsAt',
              {
                $multiply: [
                  { $add: ['$durationMinutes', { $ifNull: ['$bufferMinutes', 0] }] },
                  60_000,
                ],
              },
            ],
          },
          startsAt,
        ],
      },
    })
      .select('_id startsAt durationMinutes staffId clientId serviceId')
      .limit(500)
      .maxTimeMS(5000);

    logger.info(
      { businessId, blockId: String(block._id), affected: affected.length },
      'blocked time created',
    );

    res.status(201).json({
      block: {
        id: String(block._id),
        staffId: block.staffId,
        resourceId: block.resourceId,
        startsAt: block.startsAt,
        endsAt: block.endsAt,
        reason: block.reason,
      },
      // Not an error — information the owner has to act on themselves.
      affectedBookings: affected.map((b) => ({
        id: String(b._id),
        staffId: b.staffId,
        clientId: b.clientId,
        serviceId: b.serviceId,
        startsAt: b.startsAt,
        durationMinutes: b.durationMinutes,
      })),
    });
  });

  router.delete('/:businessId/blocked-time/:blockId', ...guard, async (req, res) => {
    const blockId = param(req, 'blockId');
    if (!mongoose.isValidObjectId(blockId)) {
      res.status(404).json({ error: 'not found' });
      return;
    }

    const deleted = await configureBooking(param(req, 'businessId'), async (session) =>
      BlockedTime.deleteOne(
        {
          _id: blockId,
          businessId: param(req, 'businessId'),
        },
        { session },
      ),
    );
    if (deleted.deletedCount === 0) {
      res.status(404).json({ error: 'not found' });
      return;
    }
    res.status(204).end();
  });

  return router;
}
