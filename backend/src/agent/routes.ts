import express, { type Router } from 'express';
import mongoose, { type HydratedDocument, type InferSchemaType } from 'mongoose';
import { z } from 'zod';
import {
  BRIEFING_HOUR_RANGE,
  DEFAULT_BRIEFING_HOUR,
  type AgentSettings,
  type Briefing as BriefingDto,
  type BriefingFacts,
  type BriefingFeed,
} from '@scalivo/shared';
import { Briefing } from '../models/Briefing.js';
import { Business } from '../models/Business.js';
import { requireAuth, requireTenant } from '../auth/middleware.js';
import { fieldErrors, param } from '../http/params.js';
import { normalisePhone } from '../lib/phone.js';
import { env } from '../config/env.js';
import { briefBusiness } from './job.js';
import type { SendDeps } from '../notifications/send.js';

/**
 * The owner's side of the agent — SPEC §11.
 *
 * Small on purpose. The agent's whole promise is that there is nothing to open
 * (§11: "no dashboard to open"), so these routes exist for the three things a
 * push notification genuinely cannot do: keep a briefing the owner swiped away,
 * let them turn it off, and — in development — let it be demonstrated on demand
 * rather than at seven o'clock tomorrow morning.
 */

const DEFAULT_FEED_SIZE = 20;

const feedQuery = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(DEFAULT_FEED_SIZE),
});

/**
 * The development trigger's optional clock.
 *
 * Without it, the pass can only ever be exercised at whatever time it happens to
 * be — so the weekly summary is testable on Mondays and the 7am briefing is
 * testable between seven and eleven. Both of those are the code paths most worth
 * checking by hand, and neither should require waiting for a particular morning.
 */
const runBody = z.object({ at: z.coerce.date().optional() });

const settingsBody = z.object({
  enabled: z.boolean().optional(),
  hour: z.number().int().min(BRIEFING_HOUR_RANGE.min).max(BRIEFING_HOUR_RANGE.max).optional(),
  /**
   * Null clears it; a string is normalised to E.164 without '+'. Validated here
   * rather than trusted, because this is the one field in the agent that causes a
   * WhatsApp message to leave the business's number.
   */
  whatsappTo: z.string().trim().min(1).max(32).nullable().optional(),
});

export function createAgentRouter(deps: SendDeps): Router {
  const router = express.Router();
  const json = express.json();
  const guard = [requireAuth, requireTenant()] as const;

  /** The feed, newest first, with the settings beside it. */
  router.get('/:businessId/agent/briefings', ...guard, async (req, res) => {
    const parsed = feedQuery.safeParse(req.query);
    if (!parsed.success) {
      res.status(400).json({ error: 'invalid query', fields: fieldErrors(parsed.error) });
      return;
    }

    const businessId = param(req, 'businessId');
    const business = await Business.findById(businessId).select('agent');
    if (!business) {
      res.status(404).json({ error: 'not found' });
      return;
    }

    const [rows, unread] = await Promise.all([
      Briefing.find({ businessId }).sort({ scheduledFor: -1, _id: -1 }).limit(parsed.data.limit),
      Briefing.countDocuments({ businessId, readAt: null }),
    ]);

    res.json({
      settings: settingsOf(business),
      briefings: rows.map(toDto),
      unread,
    } satisfies BriefingFeed);
  });

  /**
   * Mark one as read.
   *
   * The Learning Layer's (3.4) only input, which is why it is a real endpoint now
   * and not a later addition: engagement is a fact about a moment, and a
   * subsystem that starts recording it next term has no history to learn from.
   */
  router.post('/:businessId/agent/briefings/:briefingId/read', ...guard, async (req, res) => {
    const briefingId = param(req, 'briefingId');
    if (!mongoose.isValidObjectId(briefingId)) {
      res.status(404).json({ error: 'not found' });
      return;
    }

    const updated = await Briefing.findOneAndUpdate(
      // businessId in the filter, not just the id: without it an owner of one
      // business could mark another's briefing read by guessing an id.
      { _id: briefingId, businessId: param(req, 'businessId'), readAt: null },
      { $set: { readAt: new Date() } },
      { new: true },
    );

    // Already read is not an error — two devices opening the same notification is
    // the ordinary case, and the second one has nothing to report.
    const record =
      updated ??
      (await Briefing.findOne({
        _id: briefingId,
        businessId: param(req, 'businessId'),
      }).select('readAt'));
    if (!record) {
      res.status(404).json({ error: 'not found' });
      return;
    }
    res.json({ readAt: record.readAt?.toISOString() ?? null });
  });

  router.patch('/:businessId/agent/settings', ...guard, json, async (req, res) => {
    const parsed = settingsBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'invalid settings', fields: fieldErrors(parsed.error) });
      return;
    }

    const { enabled, hour, whatsappTo } = parsed.data;
    const update: Record<string, unknown> = {};

    if (enabled !== undefined) update['agent.briefings'] = enabled;
    if (hour !== undefined) update['agent.hour'] = hour;

    if (whatsappTo !== undefined) {
      if (whatsappTo === null) {
        update['agent.whatsappTo'] = null;
      } else {
        const normalised = normalisePhone(whatsappTo);
        if (!normalised || !/^\d{8,15}$/.test(normalised)) {
          res.status(400).json({ error: 'that does not look like a phone number' });
          return;
        }
        update['agent.whatsappTo'] = normalised;
      }
    }

    if (Object.keys(update).length === 0) {
      res.status(400).json({ error: 'nothing to change' });
      return;
    }

    const business = await Business.findByIdAndUpdate(
      param(req, 'businessId'),
      { $set: update },
      { new: true },
    ).select('agent');

    if (!business) {
      res.status(404).json({ error: 'not found' });
      return;
    }

    res.json(settingsOf(business));
  });

  /**
   * Run the pass for this business now — development only.
   *
   * Not a convenience: the agent's acceptance test is "an owner wakes to a
   * briefing", and waiting until 7am to see whether the code works would make
   * every iteration a day long. Idempotent, because it goes through the same claim
   * as the timer — calling it twice cannot brief the same morning twice.
   *
   * Refused in production, where a route that manufactures owner notifications on
   * request is a way to push whatever the caller likes to somebody's phone.
   */
  router.post('/:businessId/agent/run', ...guard, json, async (req, res) => {
    if (env.NODE_ENV === 'production') {
      res.status(404).json({ error: 'not found' });
      return;
    }

    const parsed = runBody.safeParse(req.body ?? {});
    if (!parsed.success) {
      res.status(400).json({ error: 'invalid request', fields: fieldErrors(parsed.error) });
      return;
    }

    const business = await Business.findById(param(req, 'businessId'));
    if (!business) {
      res.status(404).json({ error: 'not found' });
      return;
    }

    const results = await briefBusiness(deps, business, parsed.data.at ?? new Date());
    res.json({
      sent: results.filter((result) => result.sent).length,
      // Naming what was skipped and why, because "sent: 0" on a demo is otherwise
      // indistinguishable from a broken agent.
      results,
    });
  });

  return router;
}

/**
 * Only the field this reads, and `| null` because that is genuinely what Mongoose
 * infers for a nested object — a business saved before `agent` existed has no
 * subdocument at all.
 */
type BusinessWithAgent = {
  agent?: { briefings?: boolean; hour?: number; whatsappTo?: string | null } | null;
};

function settingsOf(business: BusinessWithAgent): AgentSettings {
  return {
    enabled: business.agent?.briefings !== false,
    hour: business.agent?.hour ?? DEFAULT_BRIEFING_HOUR,
    whatsappTo: business.agent?.whatsappTo ?? null,
  };
}

/**
 * Spelled out rather than inferred from `findOne`, whose `T | null` return
 * collapses under `Awaited<ReturnType<…>>` to `{}` — a type that accepts every
 * field access and catches none of them. Same pattern as `remindBusiness`.
 */
type BriefingDoc = HydratedDocument<InferSchemaType<typeof Briefing.schema>>;

function toDto(row: BriefingDoc): BriefingDto {
  return {
    id: String(row._id),
    kind: row.kind as BriefingDto['kind'],
    alertType: (row.alertType ?? null) as BriefingDto['alertType'],
    scheduledFor: row.scheduledFor.toISOString(),
    headline: row.headline,
    body: row.body,
    // Mixed on the way in, typed on the way out. The writer is the only producer
    // and it is typed; this cast is where that guarantee is cashed in.
    facts: row.facts as BriefingFacts,
    phrasedBy: row.phrasedBy as BriefingDto['phrasedBy'],
    actions: row.actions.map((action) => ({ label: action.label, href: action.href })),
    readAt: row.readAt?.toISOString() ?? null,
    createdAt: (row.createdAt as Date).toISOString(),
  };
}
