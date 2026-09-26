import {
  PHRASED_BY,
  type AlertType,
  type BriefingFacts,
  type BriefingKind,
  type PhrasedBy,
} from '@scalivo/shared';
import { Briefing } from '../models/Briefing.js';
import { PUSH_CHANNEL, pushToOwners } from '../push/fcm.js';
import { isDuplicateKey } from '../lib/mongo.js';
import { logger } from '../lib/logger.js';
import type { SendDeps } from '../notifications/send.js';
import { rephrase } from './gemini.js';
import { template } from './templates.js';

/**
 * Getting a briefing to the owner — SPEC §11.1's action layer.
 *
 * The order of operations is the whole design, and it is the same claim-first
 * discipline as the reminders and the nudges:
 *
 *   claim → phrase → store → push
 *
 * **Claim before phrasing.** The insert is what makes this idempotent, so it
 * happens before the network call to Gemini rather than after. A pass that
 * overlaps itself, or a container restarting mid-briefing, then costs at most one
 * wasted rewrite instead of a second push about the same morning.
 *
 * **The record outlives the push.** A notification is swiped away and gone; the
 * dashboard feed is where a briefing can still be read on Tuesday. So the record
 * is the deliverable and the push is a pointer at it — which is also why a push
 * that reaches zero devices is logged but never retried. There is nothing to
 * retry: the briefing exists and the owner will see it when they open the app.
 *
 * **Never over WhatsApp by default.** Session Health's rule (§2.3) is that the
 * owner channel must not be the channel that breaks, and there is a sharper
 * reason here: the business's session runs on the owner's own phone, so a briefing
 * sent to the business number is the system messaging the device it is running
 * on. The optional copy below exists for the case the spec has in mind — a second
 * handset, a manager — and it never asks for a reply, because a reply from that
 * number arrives at the customer FSM and would be answered with a booking menu.
 */

export interface BriefingRequest {
  businessId: string;
  businessName: string;
  timezone: string;
  kind: BriefingKind;
  alertType?: AlertType | null;
  /** Unique per business per occasion — see Briefing.dedupeKey. */
  dedupeKey: string;
  /** The moment it was due, not the moment it is written. */
  scheduledFor: Date;
  facts: BriefingFacts;
  /** E.164 without '+', or null. See AgentSettings.whatsappTo. */
  whatsappTo?: string | null;
  sessionId?: string | null;
}

export type BriefingResult =
  | { sent: true; briefingId: string; phrasedBy: PhrasedBy; pushedTo: number }
  | { sent: false; reason: 'already_sent' };

export async function deliverBriefing(
  deps: SendDeps,
  request: BriefingRequest,
): Promise<BriefingResult> {
  const { businessId, dedupeKey, kind, facts, scheduledFor } = request;

  const plain = template(facts, request.businessName, request.timezone);

  let briefing;
  try {
    briefing = await Briefing.create({
      businessId,
      kind,
      alertType: request.alertType ?? null,
      dedupeKey,
      scheduledFor,
      headline: plain.headline,
      // Stored as the template wrote it. The rewrite replaces it below only once
      // it has been accepted, so a crash between here and there leaves a briefing
      // that is plainer than intended rather than one that is empty.
      body: plain.body,
      facts,
      phrasedBy: PHRASED_BY.TEMPLATE,
      actions: plain.actions,
    });
  } catch (err) {
    // The only expected failure: this occasion has already been briefed, by an
    // overlapping pass or a second instance.
    if (isDuplicateKey(err)) return { sent: false, reason: 'already_sent' };
    throw err;
  }

  const briefingId = String(briefing._id);

  let body = plain.body;
  let phrasedBy: PhrasedBy = PHRASED_BY.TEMPLATE;

  const rewritten = await rephrase(plain.body);
  if (rewritten) {
    body = rewritten;
    phrasedBy = PHRASED_BY.GEMINI;
    await Briefing.updateOne({ _id: briefingId }, { $set: { body, phrasedBy } });
  }

  const pushedTo = await pushToOwners(businessId, {
    title: plain.headline,
    body,
    // Its own channel, so an owner who is tired of a daily briefing can silence
    // it on Android without also silencing "your WhatsApp is down".
    channel: PUSH_CHANNEL.BRIEFING,
    route: '/briefings',
  }).catch((err) => {
    // A push failure must not lose the briefing that is already stored.
    logger.warn({ err, businessId }, 'could not push briefing — it is in the dashboard');
    return 0;
  });

  await Briefing.updateOne({ _id: briefingId }, { $set: { pushedTo } });

  await copyToWhatsapp(deps, request, plain.headline, body);

  logger.info(
    { businessId, kind, alertType: request.alertType ?? null, phrasedBy, pushedTo, briefingId },
    'briefing sent',
  );

  return { sent: true, briefingId, phrasedBy, pushedTo };
}

/**
 * The optional WhatsApp copy — SPEC §11.2's channel, where it is usable.
 *
 * Sent straight through the provider rather than via `sendTracked`, and that is
 * not a shortcut: `sendTracked` writes a Notification against a `clientId`, and
 * the recipient here is not a customer of the business. Giving the owner a Client
 * record to satisfy the type would put them in the CRM, in the customer counts,
 * and eventually in a win-back campaign.
 *
 * The cost of going around it is that this does not queue through an outage — and
 * that is the correct behaviour anyway. A briefing is worth reading this morning;
 * one delivered when the session recovers on Thursday is not. The push has
 * already landed and the record is already stored.
 */
async function copyToWhatsapp(
  deps: SendDeps,
  request: BriefingRequest,
  headline: string,
  body: string,
): Promise<void> {
  const { whatsappTo, sessionId, businessId } = request;
  if (!whatsappTo || !sessionId) return;

  try {
    await deps.provider.sendText(
      sessionId,
      whatsappTo,
      // No question, no menu, no "reply YES". Everything actionable is a tap in
      // the app; see the note at the top of this file.
      `*${headline}*\n\n${body}\n\nOpen Scalivo to act on this.`,
    );
  } catch (err) {
    logger.warn({ err, businessId }, 'could not copy briefing to whatsapp');
  }
}
