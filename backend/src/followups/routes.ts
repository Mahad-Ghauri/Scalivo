import express, { type Router } from 'express';
import { z } from 'zod';
import { requireAuth, requireTenant } from '../auth/middleware.js';
import { fieldErrors, param } from '../http/params.js';
import { clearFollowUp, LIST_FILTER, listFollowUps, setFollowUp } from './service.js';

const objectId = z.string().regex(/^[a-f\d]{24}$/i);

const body = z.object({
  /** Days after the visit's start. 1 day to a year covers every real course. */
  afterDays: z.number().int().min(1).max(365),
  /** Defaults to the visit's own service. */
  serviceId: objectId.nullable().optional(),
  /** Omitted = same professional; null = anyone. */
  staffId: objectId.nullable().optional(),
  note: z.string().trim().max(200).nullable().optional(),
});

const STATUS: Record<string, number> = {
  not_found: 404,
  invalid_status: 409,
  already_closed: 409,
  invalid_service: 400,
  invalid_staff: 400,
};

export function createFollowUpRouter(): Router {
  const router = express.Router();
  const json = express.json({ limit: '8kb' });
  const guard = [requireAuth, requireTenant()] as const;

  /** Attach or replace a booking's follow-up (owner, at booking or at completion). */
  router.put('/:businessId/bookings/:bookingId/follow-up', ...guard, json, async (req, res) => {
    const parsed = body.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'invalid follow-up', fields: fieldErrors(parsed.error) });
      return;
    }
    const result = await setFollowUp({
      businessId: param(req, 'businessId'),
      bookingId: param(req, 'bookingId'),
      ...parsed.data,
    });
    if (!result.ok) {
      res
        .status(STATUS[result.reason] ?? 400)
        .json({ error: result.reason, reason: result.reason });
      return;
    }
    res.json({ followUp: result.followUp });
  });

  router.delete('/:businessId/bookings/:bookingId/follow-up', ...guard, async (req, res) => {
    const cleared = await clearFollowUp(param(req, 'businessId'), param(req, 'bookingId'));
    if (!cleared) {
      res.status(404).json({ error: 'no open follow-up', reason: 'not_found' });
      return;
    }
    res.status(204).end();
  });

  /** The owner's list. `?status=open` (default) | `lapsed` | `all`. */
  router.get('/:businessId/follow-ups', ...guard, async (req, res) => {
    const raw = typeof req.query.status === 'string' ? req.query.status : 'open';
    if (!(raw in LIST_FILTER)) {
      res.status(400).json({ error: 'invalid status' });
      return;
    }
    const items = await listFollowUps(param(req, 'businessId'), raw as keyof typeof LIST_FILTER);
    res.json({ followUps: items });
  });

  return router;
}
