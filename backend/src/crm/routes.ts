import express, { type Router } from 'express';
import mongoose, { type PipelineStage } from 'mongoose';
import { z } from 'zod';
import { BOOKING_STATUS, CLIENT_IMPORT_MAX_ROWS } from '@scalivo/shared';
import { Booking } from '../models/Booking.js';
import { Business } from '../models/Business.js';
import { importClients } from './import.js';
import { Client } from '../models/Client.js';
import { ClientProfile } from '../models/ClientProfile.js';
import { Service } from '../models/Service.js';
import { Staff } from '../models/Staff.js';
import { requireAuth, requireTenant } from '../auth/middleware.js';
import { logger } from '../lib/logger.js';
import { loadProfile, recomputeProfile, toTaggable } from './profile.js';
import { averageGapDays, computeTags, nextExpectedVisitAt,
  VIP_VISITS,
  VIP_SPEND_MINOR,
  NEW_MAX_VISITS,
  LAPSED_DAYS,
  AT_RISK_GAP_MULTIPLIER,
  MIN_VISITS_FOR_CADENCE,
  DAY_MS,
} from './tags.js';
import { param } from '../http/params.js';

/**
 * The CRM over HTTP.
 *
 * Every query starts from ClientProfile rather than from Client, and that is
 * the tenancy guarantee: Client is a global person, so a search that began
 * there could surface someone who has never dealt with this business at all.
 * Starting from the profile means the businessId filter is in the first query
 * rather than a filter applied after the fact.
 */

const PAGE_SIZE = 50;

const listQuery = z.object({
  /** Matches a name or a phone number. */
  q: z.string().trim().min(1).max(128).optional(),
  tag: z.enum(['new', 'vip', 'at_risk', 'lapsed']).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(PAGE_SIZE),
  skip: z.coerce.number().int().min(0).max(100000).default(0),
});

const notesBody = z.object({ notes: z.string().max(5000) });

/** Only the envelope is checked here; each row is judged on its own in import.ts. */
const importBody = z.object({
  rows: z.array(z.unknown()).min(1).max(CLIENT_IMPORT_MAX_ROWS),
});

export function createCrmRouter(): Router {
  const router = express.Router();
  const json = express.json();
  const guard = [requireAuth, requireTenant()] as const;

  /**
   * The customer list.
   *
   * Tags are derived before pagination, using the same thresholds as computeTags.
   * Search starts inside the tenant, so other businesses cannot exhaust matches.
   */
  router.get('/:businessId/clients', ...guard, async (req, res) => {
    const parsed = listQuery.safeParse(req.query);
    if (!parsed.success) {
      res.status(400).json({ error: 'invalid query' });
      return;
    }

    const businessId = param(req, 'businessId');
    const { q, tag, limit, skip } = parsed.data;

    const now = new Date();
    const stages: PipelineStage[] = [
      { $match: { businessId } },
      { $project: { clientId: 1, totalVisits: 1, lifetimeSpendMinor: 1, firstVisitAt: 1, lastVisitAt: 1, lastBookingAt: 1 } },
    ];
    if (tag === 'new') stages.push({ $match: { totalVisits: { $lte: NEW_MAX_VISITS } } });
    if (tag === 'vip')
      stages.push({
        $match: {
          $or: [
            { totalVisits: { $gte: VIP_VISITS } },
            { lifetimeSpendMinor: { $gte: VIP_SPEND_MINOR } },
          ],
        },
      });
    if (tag === 'lapsed' || tag === 'at_risk') {
      const cutoff = new Date(now.getTime() - LAPSED_DAYS * DAY_MS);
      stages.push({
        $match: { lastVisitAt: tag === 'lapsed' ? { $ne: null, $lte: cutoff } : { $gt: cutoff } },
      });
      if (tag === 'at_risk')
        stages.push({
          $match: {
            $expr: {
              $and: [
                { $gte: ['$totalVisits', MIN_VISITS_FOR_CADENCE] },
                { $ne: ['$firstVisitAt', null] },
                { $gt: ['$lastVisitAt', '$firstVisitAt'] },
                {
                  $gte: [
                    { $subtract: [now, '$lastVisitAt'] },
                    {
                      $multiply: [
                        AT_RISK_GAP_MULTIPLIER,
                        {
                          $divide: [
                            { $subtract: ['$lastVisitAt', '$firstVisitAt'] },
                            { $max: [1, { $subtract: ['$totalVisits', 1] }] },
                          ],
                        },
                      ],
                    },
                  ],
                },
              ],
            },
          },
        });
      stages.push(
        {
          $lookup: {
            from: Booking.collection.name,
            let: { clientId: '$clientId' },
            pipeline: [
              {
                $match: {
                  businessId,
                  startsAt: { $gte: now },
                  status: { $nin: [BOOKING_STATUS.CANCELLED, BOOKING_STATUS.NO_SHOW] },
                  $expr: { $eq: ['$clientId', '$$clientId'] },
                },
              },
              { $limit: 1 },
              { $project: { _id: 1 } },
            ],
            as: 'upcoming',
          },
        },
        { $match: { upcoming: { $size: 0 } } },
      );
    }
    if (q) {
      const escaped = q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      stages.push(
        {
          $lookup: {
            from: Client.collection.name,
            let: {
              id: { $convert: { input: '$clientId', to: 'objectId', onError: null, onNull: null } },
            },
            pipeline: [
              { $match: { $expr: { $eq: ['$_id', '$$id'] } } },
              { $project: { displayName: 1, phone: 1 } },
            ],
            as: 'person',
          },
        },
        {
          $match: {
        $or: [{ 'person.displayName': new RegExp(escaped, 'i') }, { 'person.phone': new RegExp(escaped) }],
      },
        },
      );
    }
    stages.push({
      $facet: {
        page: [
          { $sort: { lastBookingAt: -1, _id: 1 } },
          { $skip: skip },
          { $limit: limit },
          { $project: { _id: 1 } },
        ],
        count: [{ $count: 'total' }],
      },
    });
    const [result] = await ClientProfile.aggregate<{
      page: { _id: mongoose.Types.ObjectId }[];
      count: { total: number }[];
    }>(stages);
    const ids = result?.page.map((p) => p._id) ?? [];
    const total = result?.count[0]?.total ?? 0;
    const found = await ClientProfile.find({ businessId, _id: { $in: ids } });
    const byProfileId = new Map(found.map((p) => [String(p._id), p]));
    const profiles = ids.flatMap((id) => {
      const profile = byProfileId.get(String(id));
      return profile ? [profile] : [];
    });

    const clients = await Client.find({
      _id: { $in: profiles.map((p) => p.clientId) },
    });
    const byId = new Map(clients.map((c) => [String(c._id), c]));

    // One query for everyone's upcoming bookings instead of one per row — the
    // difference between a fast list and 50 round trips.
    const upcoming = await Booking.distinct('clientId', {
      businessId,
      clientId: { $in: profiles.map((p) => p.clientId) },
      startsAt: { $gte: now },
      status: { $nin: [BOOKING_STATUS.CANCELLED, BOOKING_STATUS.NO_SHOW] },
    });
    const booked = new Set(upcoming);

    const rows = profiles.map((p) => {
      const client = byId.get(p.clientId);
      const taggable = toTaggable(p);

      return {
        id: p.clientId,
        clientId: p.clientId,
        displayName: client?.displayName ?? null,
        phone: client?.phone ?? null,
        tags: computeTags(taggable, { hasUpcomingBooking: booked.has(p.clientId), now }),
        totalVisits: p.totalVisits,
        lifetimeSpendMinor: p.lifetimeSpendMinor,
        lastVisitAt: taggable.lastVisitAt,
        nextExpectedVisitAt: nextExpectedVisitAt(taggable),
        averageGapDays: averageGapDays(taggable),
        marketingOptOut: p.marketingOptOut,
      };
    });

    res.json({
      clients: rows,
      total,
    });
  });

  /** One profile, with the visit history the owner actually reads. */
  router.get('/:businessId/clients/:clientId', ...guard, async (req, res) => {
    const businessId = param(req, 'businessId');
    const clientId = param(req, 'clientId');

    if (!mongoose.isValidObjectId(clientId)) {
      res.status(404).json({ error: 'not found' });
      return;
    }

    const profile = await loadProfile(businessId, clientId);
    if (!profile) {
      res.status(404).json({ error: 'not found' });
      return;
    }

    const bookings = await Booking.find({ businessId, clientId })
      .sort({ startsAt: -1 })
      .limit(100);

    // Names resolved in two queries rather than per booking. A twenty-visit
    // client would otherwise cost forty round trips to render one screen.
    const [services, staff] = await Promise.all([
      Service.find({ _id: { $in: [...new Set(bookings.map((b) => b.serviceId))] } }),
      Staff.find({ _id: { $in: [...new Set(bookings.map((b) => b.staffId))] } }),
    ]);
    const serviceName = new Map(services.map((s) => [String(s._id), s.name]));
    const staffName = new Map(staff.map((s) => [String(s._id), s.name]));

    res.json({
      profile,
      history: bookings.map((b) => ({
        id: String(b._id),
        startsAt: b.startsAt,
        status: b.status,
        priceMinor: b.priceMinor,
        source: b.source,
        // Falls back rather than omitting: a retired service still has to show
        // a name against the visit it was booked for.
        serviceName: serviceName.get(b.serviceId) ?? 'Service',
        staffName: staffName.get(b.staffId) ?? 'Staff',
      })),
    });
  });

  /** Notes — the only thing in this whole subsystem a human types. */
  router.put('/:businessId/clients/:clientId/notes', ...guard, json, async (req, res) => {
    const parsed = notesBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'invalid notes' });
      return;
    }

    const clientId = param(req, 'clientId');
    if (!mongoose.isValidObjectId(clientId)) {
      res.status(404).json({ error: 'not found' });
      return;
    }

    const profile = await ClientProfile.findOneAndUpdate(
      { businessId: param(req, 'businessId'), clientId },
      { $set: { notes: parsed.data.notes } },
      { new: true },
    );
    if (!profile) {
      res.status(404).json({ error: 'not found' });
      return;
    }
    res.json({ notes: profile.notes });
  });

  /**
   * Rebuild the counters from the bookings.
   *
   * Exposed because the counters are a cache, and a cache with no way to repair
   * it is just a second source of truth that nobody can check. Cheap, safe to
   * run twice, and the first thing to try if a number looks wrong.
   */
  router.post('/:businessId/clients/:clientId/recompute', ...guard, async (req, res) => {
    const businessId = param(req, 'businessId');
    const clientId = param(req, 'clientId');

    if (!mongoose.isValidObjectId(clientId)) {
      res.status(404).json({ error: 'not found' });
      return;
    }

    await recomputeProfile(businessId, clientId);
    logger.info({ businessId, clientId }, 'profile recomputed on request');
    res.json(await loadProfile(businessId, clientId));
  });

  /**
   * Bulk import from the owner's own list — see crm/import.ts.
   *
   * `?dryRun=true` is the preview: the same validation and matching, nothing
   * written. The page runs it first so the owner sees "212 new, 14 already
   * yours, 3 rows with no number" before anything changes, and a bad column
   * mapping costs a second look rather than a cleanup.
   *
   * Row-level problems are results, not a 400: one typo in a 900-row sheet must
   * not refuse the other 899.
   */
  router.post(
    '/:businessId/clients/import',
    ...guard,
    // 2000 rows of name/phone/dates is a few hundred KB — past express's 100kb default.
    express.json({ limit: '2mb' }),
    async (req, res) => {
      const parsed = importBody.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({
          error: `send between 1 and ${CLIENT_IMPORT_MAX_ROWS} rows at a time`,
        });
        return;
      }

      const businessId = param(req, 'businessId');
      const business = await Business.findById(businessId).select('timezone');
      if (!business) {
        res.status(404).json({ error: 'not found' });
        return;
      }

      const result = await importClients({
        businessId,
        timezone: business.timezone ?? 'Asia/Karachi',
        rows: parsed.data.rows,
        dryRun: req.query.dryRun === 'true',
      });
      res.json(result);
    },
  );

  return router;
}
