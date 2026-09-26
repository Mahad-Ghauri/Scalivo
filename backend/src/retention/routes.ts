import express, { type Router } from 'express';
import mongoose from 'mongoose';
import { z } from 'zod';
import {
  CAMPAIGN_AUDIENCE,
  CAMPAIGN_MESSAGE_MAX,
  type NudgeReport,
} from '@scalivo/shared';
import { Business } from '../models/Business.js';
import { requireAuth, requireTenant } from '../auth/middleware.js';
import { fieldErrors, param } from '../http/params.js';
import * as copy from '../whatsapp/messages.js';
import { buildAudience } from './audience.js';
import {
  cancelCampaign,
  createCampaign,
  drainCampaign,
  listCampaigns,
} from './campaigns.js';
import { nudgeReport } from './nudges.js';
import type { SendDeps } from '../notifications/send.js';

/**
 * The owner's side of retention — SPEC §6.
 *
 * Three things an owner can do and one they can read: see who a broadcast would
 * reach, send it, stop it, and see what their nudges have been doing. Everything
 * else about this subsystem happens on a timer.
 *
 * The preview is a separate call from the send on purpose. "212 lapsed customers"
 * and "178 people who will actually get this" are different numbers, and putting
 * the second one in front of the owner BEFORE they commit is the difference
 * between a feature they trust and one they use once.
 */

/** A default range for the nudge report: long enough to contain a fortnight's quiet period. */
const DEFAULT_REPORT_DAYS = 30;

const audienceQuery = z.object({
  audience: z.enum([CAMPAIGN_AUDIENCE.AT_RISK, CAMPAIGN_AUDIENCE.LAPSED]),
});

const campaignBody = z.object({
  audience: z.enum([CAMPAIGN_AUDIENCE.AT_RISK, CAMPAIGN_AUDIENCE.LAPSED]),
  /**
   * The owner's own words, trimmed and bounded. Empty is refused rather than
   * silently replaced by the template: a blank broadcast is a mis-tap, and
   * sending something nobody wrote to two hundred people is not a recoverable
   * mistake.
   */
  message: z.string().trim().min(10).max(CAMPAIGN_MESSAGE_MAX),
});

const reportQuery = z.object({
  days: z.coerce.number().int().min(1).max(366).default(DEFAULT_REPORT_DAYS),
});

const settingsBody = z.object({ nudges: z.boolean() });

export function createRetentionRouter(deps: SendDeps): Router {
  const router = express.Router();
  const json = express.json();
  const guard = [requireAuth, requireTenant()] as const;

  /** What a broadcast would reach, and what it would not. Reads nothing, sends nothing. */
  router.get('/:businessId/retention/audience', ...guard, async (req, res) => {
    const parsed = audienceQuery.safeParse(req.query);
    if (!parsed.success) {
      res.status(400).json({ error: 'invalid query', fields: fieldErrors(parsed.error) });
      return;
    }

    const businessId = param(req, 'businessId');
    const business = await Business.findById(businessId).select('name timezone');
    if (!business) {
      res.status(404).json({ error: 'not found' });
      return;
    }

    const { preview } = await buildAudience(businessId, business.timezone, parsed.data.audience);

    res.json({
      ...preview,
      // The starting point for the message box. A blank box is where a feature
      // like this stops being used by the owner it was built for.
      suggested: copy.campaignTemplate(business.name),
    });
  });

  router.get('/:businessId/retention/campaigns', ...guard, async (req, res) => {
    res.json({ campaigns: await listCampaigns(param(req, 'businessId')) });
  });

  /**
   * Send one.
   *
   * Creates the campaign, then drains the first batch inline so the owner sees
   * something happen immediately — the throttle and the caps decide how much
   * that is, and the pass picks up the rest. Draining the WHOLE thing here would
   * hold the request open for however many hours 200 spaced-out messages take.
   */
  router.post('/:businessId/retention/campaigns', ...guard, json, async (req, res) => {
    const parsed = campaignBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'invalid campaign', fields: fieldErrors(parsed.error) });
      return;
    }

    const businessId = param(req, 'businessId');
    const business = await Business.findById(businessId).select('timezone whatsapp.sessionId');
    if (!business) {
      res.status(404).json({ error: 'not found' });
      return;
    }

    // No number, no broadcast. Refused rather than queued: a campaign claimed
    // against a business with no session would sit unsent while its audience
    // moved on, and the owner would believe it had gone out.
    if (!business.whatsapp?.sessionId) {
      res.status(409).json({
        error: 'connect your WhatsApp number before sending a broadcast',
        reason: 'no_session',
      });
      return;
    }

    const created = await createCampaign({
      businessId,
      timezone: business.timezone,
      audience: parsed.data.audience,
      message: parsed.data.message,
    });

    if ('error' in created) {
      res.status(409).json({
        error: 'nobody in that group can be messaged right now',
        reason: created.error,
      });
      return;
    }

    // Best-effort: the campaign exists and the pass owns it from here, so a
    // failure to send the first batch is not a failure to create the campaign.
    const sent = await drainCampaign(deps, created.campaignId).catch(() => 0);

    res.status(201).json({ ...created, sent });
  });

  router.post('/:businessId/retention/campaigns/:campaignId/cancel', ...guard, async (req, res) => {
    const campaignId = param(req, 'campaignId');
    if (!mongoose.isValidObjectId(campaignId)) {
      res.status(404).json({ error: 'not found' });
      return;
    }

    const stopped = await cancelCampaign(param(req, 'businessId'), campaignId);
    if (!stopped) {
      // Either it never existed here or it has already finished. Both mean the
      // same thing to the owner: there is nothing left to stop.
      res.status(409).json({ error: 'that campaign is no longer sending' });
      return;
    }
    res.json({ ok: true });
  });

  /** The automatic half: on or off, and what it has done. */
  router.get('/:businessId/retention/nudges', ...guard, async (req, res) => {
    const parsed = reportQuery.safeParse(req.query);
    if (!parsed.success) {
      res.status(400).json({ error: 'invalid query', fields: fieldErrors(parsed.error) });
      return;
    }

    const businessId = param(req, 'businessId');
    const business = await Business.findById(businessId).select('timezone retention');
    if (!business) {
      res.status(404).json({ error: 'not found' });
      return;
    }

    const { days } = parsed.data;
    res.json({
      enabled: business.retention?.nudges !== false,
      days,
      outcome: await nudgeReport(businessId, business.timezone, days),
    } satisfies NudgeReport);
  });

  router.patch('/:businessId/retention/nudges', ...guard, json, async (req, res) => {
    const parsed = settingsBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'invalid settings', fields: fieldErrors(parsed.error) });
      return;
    }

    const business = await Business.findByIdAndUpdate(
      param(req, 'businessId'),
      { $set: { 'retention.nudges': parsed.data.nudges } },
      { new: true },
    ).select('retention');

    if (!business) {
      res.status(404).json({ error: 'not found' });
      return;
    }
    res.json({ nudges: business.retention?.nudges !== false });
  });

  return router;
}
