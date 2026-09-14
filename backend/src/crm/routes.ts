import express, { type Router } from 'express';
import mongoose from 'mongoose';
import { z } from 'zod';
import { BOOKING_STATUS } from '@scalivo/shared';
import { Booking } from '../models/Booking.js';
import { Client } from '../models/Client.js';
import { ClientProfile } from '../models/ClientProfile.js';
import { Service } from '../models/Service.js';
import { Staff } from '../models/Staff.js';
import { requireAuth, requireTenant } from '../auth/middleware.js';
import { logger } from '../lib/logger.js';
import { loadProfile, recomputeProfile, toTaggable } from './profile.js';
import { averageGapDays, computeTags, nextExpectedVisitAt } from './tags.js';

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
  q: z.string().trim().min(1).optional(),
  tag: z.enum(['new', 'vip', 'at_risk', 'lapsed']).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(PAGE_SIZE),
  skip: z.coerce.number().int().min(0).default(0),
});

const notesBody = z.object({ notes: z.string().max(5000) });

function param(req: express.Request, name: string): string {
  const value = req.params[name];
  return typeof value === 'string' ? value : '';
}

export function createCrmRouter(): Router {
  const router = express.Router();
  const json = express.json();
  const guard = [requireAuth, requireTenant()] as const;

  /**
   * The customer list.
   *
   * Tags are computed per row rather than queried, so filtering by tag filters
   * the page in memory. That is a real limit and an honest one at pilot scale —
   * making it a database query would mean storing tags, and a stored LAPSED is
   * wrong the day after it is written.
   */
  router.get('/:businessId/clients', ...guard, async (req, res) => {
    const parsed = listQuery.safeParse(req.query);
    if (!parsed.success) {
      res.status(400).json({ error: 'invalid query' });
      return;
    }

    const businessId = param(req, 'businessId');
    const { q, tag, limit, skip } = parsed.data;

    // A text search has to go through Client (that is where names and phones
    // live), so it runs first and narrows the profile query — never the other
    // way round, which would read every profile and then filter.
    let clientFilter: Record<string, unknown> | null = null;
    if (q) {
      const escaped = q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const matches = await Client.find({
        $or: [{ displayName: new RegExp(escaped, 'i') }, { phone: new RegExp(escaped) }],
      })
        .select('_id')
        .limit(500);

      if (matches.length === 0) {
        res.json({ clients: [], total: 0 });
        return;
      }
      clientFilter = { clientId: { $in: matches.map((c) => String(c._id)) } };
    }

    const filter = { businessId, ...(clientFilter ?? {}) };

    const [profiles, total] = await Promise.all([
      ClientProfile.find(filter).sort({ lastBookingAt: -1 }).skip(skip).limit(limit),
      ClientProfile.countDocuments(filter),
    ]);

    const clients = await Client.find({
      _id: { $in: profiles.map((p) => p.clientId) },
    });
    const byId = new Map(clients.map((c) => [String(c._id), c]));

    // One query for everyone's upcoming bookings instead of one per row — the
    // difference between a fast list and 50 round trips.
    const upcoming = await Booking.distinct('clientId', {
      businessId,
      clientId: { $in: profiles.map((p) => p.clientId) },
      startsAt: { $gte: new Date() },
      status: { $nin: [BOOKING_STATUS.CANCELLED, BOOKING_STATUS.NO_SHOW] },
    });
    const booked = new Set(upcoming);

    const rows = profiles.map((p) => {
      const client = byId.get(p.clientId);
      const taggable = toTaggable(p);

      return {
        clientId: p.clientId,
        displayName: client?.displayName ?? null,
        phone: client?.phone ?? null,
        tags: computeTags(taggable, { hasUpcomingBooking: booked.has(p.clientId) }),
        totalVisits: p.totalVisits,
        lifetimeSpendMinor: p.lifetimeSpendMinor,
        lastVisitAt: taggable.lastVisitAt,
        nextExpectedVisitAt: nextExpectedVisitAt(taggable),
        averageGapDays: averageGapDays(taggable),
        marketingOptOut: p.marketingOptOut,
      };
    });

    res.json({
      clients: tag ? rows.filter((r) => r.tags.includes(tag)) : rows,
      total,
      // Named so the app does not present a filtered page as a filtered total.
      ...(tag ? { filteredWithinPage: true } : {}),
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

  return router;
}
