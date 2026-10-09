import express, { type Router } from 'express';
import { z } from 'zod';
import { DateTime } from 'luxon';
import { Business } from '../models/Business.js';
import { requireAuth, requireTenant } from '../auth/middleware.js';
import { fieldErrors, param } from '../http/params.js';
import { buildReport, MAX_ANALYTICS_DAYS } from './report.js';

/**
 * Analytics over HTTP.
 *
 * The only real work here is refusing a range nobody meant: a mistyped year
 * turns one screen into a full-collection scan, and that failure surfaces as a
 * slow dashboard rather than as an error anyone goes looking for. Same cap, same
 * reasoning as the calendar's.
 */

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

const reportQuery = z.object({
  /** Business-local, both inclusive. */
  from: z.string().regex(ISO_DATE, 'expected YYYY-MM-DD').refine((value) => DateTime.fromISO(value).isValid, 'invalid date'),
  to: z.string().regex(ISO_DATE, 'expected YYYY-MM-DD').refine((value) => DateTime.fromISO(value).isValid, 'invalid date'),
  granularity: z.enum(['day', 'week', 'month']).default('day'),
});

export function createAnalyticsRouter(): Router {
  const router = express.Router();
  const guard = [requireAuth, requireTenant()] as const;

  router.get('/:businessId/analytics', ...guard, async (req, res) => {
    const parsed = reportQuery.safeParse(req.query);
    if (!parsed.success) {
      res.status(400).json({ error: 'invalid query', fields: fieldErrors(parsed.error) });
      return;
    }

    const { from, to, granularity } = parsed.data;

    if (to < from) {
      res.status(400).json({ error: 'the range ends before it starts' });
      return;
    }

    // Days rather than milliseconds: DST makes a "day" 23 or 25 hours long in
    // some zones, and a cap that quietly changes with the clocks is a cap that
    // fails a test twice a year.
    const span = DateTime.fromISO(to).diff(DateTime.fromISO(from), 'days').days;
    if (span > MAX_ANALYTICS_DAYS) {
      res.status(400).json({ error: `range may not exceed ${MAX_ANALYTICS_DAYS} days` });
      return;
    }

    const businessId = param(req, 'businessId');
    const business = await Business.findById(businessId).select('timezone');
    if (!business) {
      res.status(404).json({ error: 'business not found' });
      return;
    }

    res.json(
      await buildReport({
        businessId,
        timezone: business.timezone,
        from,
        to,
        granularity,
      }),
    );
  });

  return router;
}
