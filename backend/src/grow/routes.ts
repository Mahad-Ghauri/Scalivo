import express, { type Router } from 'express';
import { z } from 'zod';
import { DateTime } from 'luxon';
import { Business } from '../models/Business.js';
import { requireAuth, requireTenant } from '../auth/middleware.js';
import { fieldErrors, param } from '../http/params.js';
import { boostState, startBoost, stopBoost } from './boost.js';
import { funnelReport } from './funnel.js';

/** The owner's side of Grow. The profile page's beacons land on the public router instead. */

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/** Same reasoning as analytics: a mistyped year is a full scan, not a report. */
const MAX_FUNNEL_DAYS = 366;

const funnelQuery = z.object({
  from: z.string().regex(ISO_DATE, 'expected YYYY-MM-DD').refine((value) => DateTime.fromISO(value).isValid, 'invalid date'),
  to: z.string().regex(ISO_DATE, 'expected YYYY-MM-DD').refine((value) => DateTime.fromISO(value).isValid, 'invalid date'),
});

export function createGrowRouter(): Router {
  const router = express.Router();
  const guard = [requireAuth, requireTenant()] as const;

  router.get('/:businessId/grow/funnel', ...guard, async (req, res) => {
    const parsed = funnelQuery.safeParse(req.query);
    if (!parsed.success) {
      res.status(400).json({ error: 'invalid query', fields: fieldErrors(parsed.error) });
      return;
    }
    const { from, to } = parsed.data;
    if (to < from) {
      res.status(400).json({ error: 'the range ends before it starts' });
      return;
    }
    if (DateTime.fromISO(to).diff(DateTime.fromISO(from), 'days').days > MAX_FUNNEL_DAYS) {
      res.status(400).json({ error: `range may not exceed ${MAX_FUNNEL_DAYS} days` });
      return;
    }

    const businessId = param(req, 'businessId');
    const business = await Business.findById(businessId).select('timezone');
    if (!business) {
      res.status(404).json({ error: 'not found' });
      return;
    }

    res.json(await funnelReport({ businessId, timezone: business.timezone, from, to }));
  });

  router.get('/:businessId/grow/boost', ...guard, async (req, res) => {
    const business = await Business.findById(param(req, 'businessId')).select('boost');
    if (!business) {
      res.status(404).json({ error: 'not found' });
      return;
    }
    res.json(boostState(business));
  });

  router.post('/:businessId/grow/boost', ...guard, async (req, res) => {
    const result = await startBoost(param(req, 'businessId'));
    if (!result.ok) {
      res
        .status(result.reason === 'not_found' ? 404 : 409)
        .json({
          error: result.reason === 'not_found' ? 'not found' : 'publish your listing before boosting it',
          reason: result.reason,
        });
      return;
    }
    res.json(result.boost);
  });

  router.delete('/:businessId/grow/boost', ...guard, async (req, res) => {
    const boost = await stopBoost(param(req, 'businessId'));
    if (!boost) {
      res.status(404).json({ error: 'not found' });
      return;
    }
    res.json(boost);
  });

  return router;
}
