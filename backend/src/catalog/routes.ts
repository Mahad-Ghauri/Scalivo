import express, { type Router } from 'express';
import mongoose from 'mongoose';
import { z } from 'zod';
import { Service } from '../models/Service.js';
import { Staff } from '../models/Staff.js';
import { requireAuth, requireTenant } from '../auth/middleware.js';
import { logger } from '../lib/logger.js';
import { workingHoursSchema } from './hours.js';

/**
 * The catalogue an owner configures before anyone can book: services, staff,
 * and the hours each person works.
 *
 * Mounted under /businesses/:businessId, so requireTenant() refuses a
 * cross-tenant request before a query is issued — the same ordering the booking
 * and session routes rely on.
 *
 * Nothing here hard-deletes. A Booking stores serviceId and staffId, so a
 * removed row turns finished appointments into blanks on the calendar and in a
 * client's visit history. Retiring is the only delete this system has.
 */

/** A day is 1440 minutes; a service longer than that can never fit inside hours. */
const MAX_DURATION_MINUTES = 1440;

const serviceBody = z.object({
  name: z.string().trim().min(1).max(80),
  durationMinutes: z.number().int().positive().max(MAX_DURATION_MINUTES),
  bufferMinutes: z.number().int().min(0).max(MAX_DURATION_MINUTES).default(0),
  /** Minor units (paisa). Integer because money is never a float. */
  priceMinor: z.number().int().min(0),
  depositRequired: z.boolean().default(false),
  depositAmountMinor: z.number().int().positive().nullable().default(null),
  displayOrder: z.number().int().min(0).default(0),
});

/**
 * A deposit flag with no amount is the failure this refuses: the FSM would ask
 * the customer to pay `null`, mid-booking, with no way back.
 */
const serviceCreate = serviceBody.refine(
  (s) => !s.depositRequired || s.depositAmountMinor !== null,
  { message: 'a service requiring a deposit needs a deposit amount', path: ['depositAmountMinor'] },
);

const serviceUpdate = serviceBody.partial().extend({ active: z.boolean().optional() });

const staffBody = z.object({
  name: z.string().trim().min(1).max(80),
  serviceIds: z.array(z.string().min(1)).default([]),
  workingHours: workingHoursSchema.default([]),
});

const staffUpdate = staffBody.partial().extend({ active: z.boolean().optional() });

function param(req: express.Request, name: string): string {
  const value = req.params[name];
  return typeof value === 'string' ? value : '';
}

/**
 * An id that is not a valid ObjectId makes Mongoose throw a CastError, which
 * Express turns into a 500. It is a 404 — the caller asked for something that
 * cannot exist — so it is caught before it reaches a query.
 */
function objectId(req: express.Request, name: string): string | null {
  const value = param(req, name);
  return mongoose.isValidObjectId(value) ? value : null;
}

function fieldErrors(error: z.ZodError): Record<string, string> {
  const fields: Record<string, string> = {};
  for (const issue of error.issues) {
    const key = issue.path.join('.') || '_';
    if (!fields[key]) fields[key] = issue.message;
  }
  return fields;
}

export function createCatalogRouter(): Router {
  const router = express.Router();
  const json = express.json();
  const guard = [requireAuth, requireTenant()] as const;

  // ── Services ─────────────────────────────────────────────────────────────

  /**
   * Retired services are excluded unless asked for. The owner's settings screen
   * wants them (to un-retire one); nothing else does.
   */
  router.get('/:businessId/services', ...guard, async (req, res) => {
    const services = await Service.find({
      businessId: param(req, 'businessId'),
      ...(req.query.includeInactive === 'true' ? {} : { active: true }),
    }).sort({ displayOrder: 1, name: 1 });

    res.json({ services });
  });

  router.post('/:businessId/services', ...guard, json, async (req, res) => {
    const parsed = serviceCreate.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'invalid service', fields: fieldErrors(parsed.error) });
      return;
    }

    const service = await Service.create({
      businessId: param(req, 'businessId'),
      ...parsed.data,
    });

    logger.info(
      { businessId: param(req, 'businessId'), serviceId: String(service._id) },
      'service created',
    );
    res.status(201).json(service);
  });

  router.patch('/:businessId/services/:serviceId', ...guard, json, async (req, res) => {
    const parsed = serviceUpdate.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'invalid service', fields: fieldErrors(parsed.error) });
      return;
    }

    // The businessId in the filter is the tenancy check. Finding by id alone
    // and checking afterwards would already have read another salon's row.
    const id = objectId(req, 'serviceId');
    const service = id
      ? await Service.findOne({ _id: id, businessId: param(req, 'businessId') })
      : null;
    if (!service) {
      res.status(404).json({ error: 'not found' });
      return;
    }

    // Merged against the stored document, not the patch: turning a deposit on
    // without an amount is just as broken when the flag arrives by itself.
    const merged = { ...service.toObject(), ...parsed.data };
    if (merged.depositRequired && merged.depositAmountMinor === null) {
      res.status(400).json({
        error: 'invalid service',
        fields: { depositAmountMinor: 'a service requiring a deposit needs a deposit amount' },
      });
      return;
    }

    service.set(parsed.data);
    await service.save();
    res.json(service);
  });

  /**
   * Retire, never remove. Answers 200 with the retired row rather than 204 so
   * the app can render the change without a refetch.
   */
  router.delete('/:businessId/services/:serviceId', ...guard, async (req, res) => {
    const id = objectId(req, 'serviceId');
    const service = id
      ? await Service.findOneAndUpdate(
          { _id: id, businessId: param(req, 'businessId') },
          { $set: { active: false } },
          { new: true },
        )
      : null;
    if (!service) {
      res.status(404).json({ error: 'not found' });
      return;
    }

    logger.info(
      { businessId: param(req, 'businessId'), serviceId: param(req, 'serviceId') },
      'service retired',
    );
    res.json(service);
  });

  // ── Staff ────────────────────────────────────────────────────────────────

  router.get('/:businessId/staff', ...guard, async (req, res) => {
    const staff = await Staff.find({
      businessId: param(req, 'businessId'),
      ...(req.query.includeInactive === 'true' ? {} : { active: true }),
    }).sort({ name: 1 });

    res.json({ staff });
  });

  router.post('/:businessId/staff', ...guard, json, async (req, res) => {
    const parsed = staffBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'invalid staff member', fields: fieldErrors(parsed.error) });
      return;
    }

    const businessId = param(req, 'businessId');
    const unknown = await unknownServiceIds(businessId, parsed.data.serviceIds);
    if (unknown.length > 0) {
      res.status(400).json({
        error: 'invalid staff member',
        fields: { serviceIds: `not services of this business: ${unknown.join(', ')}` },
      });
      return;
    }

    const member = await Staff.create({ businessId, ...parsed.data });
    logger.info({ businessId, staffId: String(member._id) }, 'staff created');
    res.status(201).json(member);
  });

  router.patch('/:businessId/staff/:staffId', ...guard, json, async (req, res) => {
    const parsed = staffUpdate.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'invalid staff member', fields: fieldErrors(parsed.error) });
      return;
    }

    const businessId = param(req, 'businessId');

    if (parsed.data.serviceIds) {
      const unknown = await unknownServiceIds(businessId, parsed.data.serviceIds);
      if (unknown.length > 0) {
        res.status(400).json({
          error: 'invalid staff member',
          fields: { serviceIds: `not services of this business: ${unknown.join(', ')}` },
        });
        return;
      }
    }

    const id = objectId(req, 'staffId');
    const member = id
      ? await Staff.findOneAndUpdate({ _id: id, businessId }, { $set: parsed.data }, { new: true })
      : null;
    if (!member) {
      res.status(404).json({ error: 'not found' });
      return;
    }
    res.json(member);
  });

  /**
   * Deactivate, never remove — and note this does NOT cancel their upcoming
   * bookings. Those appointments still exist, still occupy the grid, and the
   * owner still has to deal with them; making them vanish here would lose
   * customers their slot with no notification and no record.
   */
  router.delete('/:businessId/staff/:staffId', ...guard, async (req, res) => {
    const id = objectId(req, 'staffId');
    const member = id
      ? await Staff.findOneAndUpdate(
          { _id: id, businessId: param(req, 'businessId') },
          { $set: { active: false } },
          { new: true },
        )
      : null;
    if (!member) {
      res.status(404).json({ error: 'not found' });
      return;
    }

    logger.info(
      { businessId: param(req, 'businessId'), staffId: param(req, 'staffId') },
      'staff deactivated',
    );
    res.json(member);
  });

  return router;
}

/**
 * Which of these ids are not this business's services.
 *
 * A tenancy check on data the owner supplies: without it, one salon could
 * attach another's serviceId to its staff. Availability filters Staff by
 * businessId so it would never leak a booking, but it would quietly produce a
 * staff member qualified for a service that does not appear in their menu.
 */
async function unknownServiceIds(businessId: string, serviceIds: string[]): Promise<string[]> {
  if (serviceIds.length === 0) return [];

  // Malformed ids are filtered out before the query rather than after: $in with
  // one un-castable string makes the whole find throw, so a single typo would
  // 500 instead of naming the offending id.
  const wellFormed = serviceIds.filter((id) => mongoose.isValidObjectId(id));
  const found = await Service.find({ _id: { $in: wellFormed }, businessId }).select('_id');
  const ok = new Set(found.map((s) => String(s._id)));
  return serviceIds.filter((id) => !ok.has(id));
}
