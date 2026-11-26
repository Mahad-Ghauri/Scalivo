import { createHash, randomBytes } from 'node:crypto';
import express, { type Router } from 'express';
import type { Redis } from 'ioredis';
import mongoose from 'mongoose';
import { z } from 'zod';
import { requireAuth, requireTenant } from '../auth/middleware.js';
import { env } from '../config/env.js';
import { rateLimit } from '../http/guards.js';
import { fieldErrors, param } from '../http/params.js';
import { addMinutes, isCalendarDate, wallClockToUtc } from '../lib/time.js';
import { logger } from '../lib/logger.js';
import { Business } from '../models/Business.js';
import { Staff } from '../models/Staff.js';
import { toCsv, toIcal } from './format.js';
import { exportRows } from './rows.js';

/**
 * Getting appointments OUT of Scalivo: the Phase 5 rollback requirement.
 *
 *   GET  /businesses/:id/export/appointments.csv?from&to   owner, a date range
 *   GET  /businesses/:id/calendar-feed                      is a feed on?
 *   POST /businesses/:id/calendar-feed                      create / rotate → URL once
 *   DELETE /businesses/:id/calendar-feed                    revoke
 *   GET  /public/calendar/:token.ics[?staff=<id>]           the subscription itself
 */

const MAX_RANGE_DAYS = 366;
/** What the feed covers: recent history for context, and everything booked ahead. */
const FEED_PAST_DAYS = 30;
const FEED_FUTURE_DAYS = 365;

const csvQuery = z.object({
  from: z.string().refine(isCalendarDate, 'Use YYYY-MM-DD'),
  to: z.string().refine(isCalendarDate, 'Use YYYY-MM-DD'),
  staffId: z
    .string()
    .regex(/^[a-f\d]{24}$/i)
    .optional(),
  includeCancelled: z.enum(['true', 'false']).optional(),
});

export const hashFeedToken = (token: string) => createHash('sha256').update(token).digest('hex');

function feedBase(): string {
  return (env.CALENDAR_FEED_BASE_URL ?? env.PUBLIC_URL).replace(/\/+$/, '');
}

export function createExportRouter(): Router {
  const router = express.Router();
  const guard = [requireAuth, requireTenant()] as const;

  router.get('/:businessId/export/appointments.csv', ...guard, async (req, res) => {
    const parsed = csvQuery.safeParse(req.query);
    if (!parsed.success) {
      res.status(400).json({ error: 'invalid export range', fields: fieldErrors(parsed.error) });
      return;
    }
    const { from, to, staffId, includeCancelled } = parsed.data;
    if (from > to) {
      res
        .status(400)
        .json({ error: 'invalid export range', fields: { to: 'End date is before start date' } });
      return;
    }

    const business = await Business.findById(param(req, 'businessId')).select('name slug timezone');
    if (!business) {
      res.status(404).json({ error: 'not found' });
      return;
    }

    // Local whole days: `to` is inclusive, so the range ends at the next midnight.
    const start = wallClockToUtc(`${from}T00:00`, business.timezone);
    const end = addMinutes(wallClockToUtc(`${to}T00:00`, business.timezone), 24 * 60);
    if (end.getTime() - start.getTime() > MAX_RANGE_DAYS * 86_400_000 + 2 * 3_600_000) {
      res
        .status(400)
        .json({ error: 'invalid export range', fields: { to: 'Export at most a year at a time' } });
      return;
    }

    const rows = await exportRows({
      businessId: String(business._id),
      from: start,
      to: end,
      staffId,
      includeCancelled: includeCancelled === 'true',
    });

    const name = `${business.slug || 'appointments'}-${from}-to-${to}.csv`.replace(
      /[^a-zA-Z0-9._-]/g,
      '-',
    );
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${name}"`);
    res.setHeader('Cache-Control', 'no-store');
    res.send(toCsv(rows, business.timezone));
  });

  router.get('/:businessId/calendar-feed', ...guard, async (req, res) => {
    const business = await Business.findById(param(req, 'businessId')).select(
      'calendarFeed.createdAt calendarFeed.tokenHash',
    );
    res.json({
      enabled: !!business?.calendarFeed?.tokenHash,
      createdAt: business?.calendarFeed?.createdAt ?? null,
    });
  });

  /**
   * Create, or rotate. The raw token is returned ONCE — only its hash is kept —
   * so the owner copies the link now; a lost link is replaced, not recovered.
   * Rotating instantly cuts off every calendar subscribed to the old one.
   */
  router.post('/:businessId/calendar-feed', ...guard, async (req, res) => {
    const token = randomBytes(24).toString('base64url');
    const now = new Date();
    const updated = await Business.updateOne(
      { _id: param(req, 'businessId') },
      { $set: { 'calendarFeed.tokenHash': hashFeedToken(token), 'calendarFeed.createdAt': now } },
    );
    if (updated.matchedCount === 0) {
      res.status(404).json({ error: 'not found' });
      return;
    }
    logger.info({ businessId: param(req, 'businessId') }, 'calendar feed link issued');
    res.status(201).json({ url: `${feedBase()}/public/calendar/${token}.ics`, createdAt: now });
  });

  router.delete('/:businessId/calendar-feed', ...guard, async (req, res) => {
    await Business.updateOne(
      { _id: param(req, 'businessId') },
      { $set: { 'calendarFeed.tokenHash': null, 'calendarFeed.createdAt': null } },
    );
    res.status(204).end();
  });

  return router;
}

/** Mounted under /public: no login, the token in the path is the credential. */
export function createCalendarFeedRouter(redis: Redis): Router {
  const router = express.Router();

  router.get(
    '/calendar/:file',
    // Calendar apps poll every few minutes at most; this only stops guessing.
    rateLimit(redis, 'calendar-feed', 120, 3600),
    async (req, res) => {
      const match = /^([A-Za-z0-9_-]{32})\.ics$/.exec(param(req, 'file'));
      // One answer for every failure — never reveal whether a token existed.
      const notFound = () => res.status(404).type('text/plain').send('Not found');
      if (!match) return notFound();

      const business = await Business.findOne({
        'calendarFeed.tokenHash': hashFeedToken(match[1]!),
      }).select('name timezone');
      if (!business) return notFound();
      const businessId = String(business._id);

      const staffParam = typeof req.query.staff === 'string' ? req.query.staff : undefined;
      if (staffParam !== undefined) {
        const ok =
          mongoose.isValidObjectId(staffParam) &&
          (await Staff.exists({ _id: staffParam, businessId }));
        if (!ok) return notFound();
      }

      const now = new Date();
      const rows = await exportRows({
        businessId,
        from: new Date(now.getTime() - FEED_PAST_DAYS * 86_400_000),
        to: new Date(now.getTime() + FEED_FUTURE_DAYS * 86_400_000),
        staffId: staffParam,
        // Cancelled ones are left out rather than sent as CANCELLED: an event
        // that disappears is removed from the subscriber's calendar either way.
        includeCancelled: false,
      });

      res.setHeader('Content-Type', 'text/calendar; charset=utf-8');
      res.setHeader('Cache-Control', 'private, max-age=300');
      // Customer names and numbers: keep the feed out of search engines.
      res.setHeader('X-Robots-Tag', 'noindex, nofollow');
      res.send(
        toIcal(rows, {
          businessName: business.name,
          timezone: business.timezone,
          now,
          host: new URL(feedBase()).hostname,
        }),
      );
    },
  );

  return router;
}
