import {
  CAMPAIGN_STATUS,
  NOTIFICATION_KIND,
  type CampaignAudience,
  type CampaignSummary,
} from '@scalivo/shared';
import { Business } from '../models/Business.js';
import { Campaign } from '../models/Campaign.js';
import { Notification } from '../models/Notification.js';
import { logger } from '../lib/logger.js';
import * as copy from '../whatsapp/messages.js';
import { sendTracked, type SendDeps } from '../notifications/send.js';
import { buildAudience, type Recipient } from './audience.js';
import { marketingRoomToday } from './caps.js';
import { markMarketingSent } from './eligibility.js';
import { claimSendSlot } from './throttle.js';
import { outcomeOf } from './report.js';

/**
 * Win-back broadcasts — SPEC §6.2.
 *
 * A campaign is created, and then it drains. Those are deliberately two things:
 * an owner tapping "send" to 200 lapsed customers cannot be a request that sends
 * 200 messages, because the number may only send a few dozen a day (§6.5) and
 * they have to be spaced out by minutes. So the tap records the intent and the
 * recipients, and a pass works through them at a pace the number can survive —
 * which also means a restart resumes rather than restarts, and the owner can
 * stop it halfway.
 *
 * The audience is snapshotted at creation, NOT re-derived per tick. A campaign
 * that recomputed "who is lapsed" on every pass would send to people who became
 * lapsed while it was draining, which is a campaign that never finishes. The
 * eligibility checks, by contrast, are re-run at send time: consent is the one
 * thing that must be as fresh as possible.
 */

/** Every minute: a campaign spread over hours has nothing to gain from finer resolution. */
const INTERVAL_MS = 60 * 1000;

/**
 * Create the campaign and claim its recipients.
 *
 * Returns the campaign with nothing sent yet — which is honest about what has
 * happened, and is what lets the owner's screen say "sending to 178 people" and
 * then fill in what actually arrived.
 */
export async function createCampaign(input: {
  businessId: string;
  timezone: string;
  audience: CampaignAudience;
  message: string;
  now?: Date;
}): Promise<{ campaignId: string; recipients: number } | { error: 'empty_audience' }> {
  const now = input.now ?? new Date();
  const { recipients } = await buildAudience(input.businessId, input.timezone, input.audience, now);

  if (recipients.length === 0) return { error: 'empty_audience' };

  const campaign = await Campaign.create({
    businessId: input.businessId,
    audience: input.audience,
    // The opt-out line is added here, once, so the stored message is exactly
    // what was sent — including to an owner reading it back months later.
    message: copy.campaignMessage(input.message),
    recipients: recipients.length,
    status: CAMPAIGN_STATUS.SENDING,
  });

  logger.info(
    {
      businessId: input.businessId,
      campaignId: String(campaign._id),
      audience: input.audience,
      recipients: recipients.length,
      cold: recipients.filter((r) => r.cold).length,
    },
    'campaign created',
  );

  return { campaignId: String(campaign._id), recipients: recipients.length };
}

/**
 * Every campaign still owing sends, one business at a time.
 *
 * Oldest first, and one campaign per business per pass: two campaigns draining
 * together would interleave into one stream at twice the intended rate, and the
 * throttle would space them out while the daily cap emptied on both at once.
 */
export async function drainCampaignsOnce(deps: SendDeps, now = new Date()): Promise<void> {
  const campaigns = await Campaign.find({ status: CAMPAIGN_STATUS.SENDING }).sort({ createdAt: 1 });

  const seen = new Set<string>();
  for (const campaign of campaigns) {
    if (seen.has(campaign.businessId)) continue;
    seen.add(campaign.businessId);

    try {
      await drainCampaign(deps, String(campaign._id), now);
    } catch (err) {
      logger.error({ err, campaignId: String(campaign._id) }, 'campaign drain failed');
    }
  }
}

/**
 * One campaign, as far as today's caps and the throttle allow.
 *
 * The recipient list is rebuilt from the audience each pass and the already-sent
 * ones are subtracted by their dedupe keys, rather than stored as a list of ids
 * on the campaign. That is a deliberate trade: rebuilding costs a query, and
 * storing the list would mean a 2,000-element array on a document that also has
 * to be read to show the owner a status line.
 *
 * It also means the eligibility filters run again on every pass, which is the
 * behaviour we want — someone who replies STOP to the first batch is gone from
 * the rest of the campaign, not merely skipped at the last moment by the send
 * path.
 */
export async function drainCampaign(
  deps: SendDeps,
  campaignId: string,
  now = new Date(),
): Promise<number> {
  const campaign = await Campaign.findById(campaignId);
  if (!campaign || campaign.status !== CAMPAIGN_STATUS.SENDING) return 0;

  const business = await Business.findById(campaign.businessId).select('timezone whatsapp.sessionId');
  if (!business?.whatsapp?.sessionId) return 0;

  const timezone = business.timezone ?? 'Asia/Karachi';
  const { recipients } = await buildAudience(
    campaign.businessId,
    timezone,
    campaign.audience as CampaignAudience,
    now,
  );

  const claimed = new Set(
    (await Notification.find({ campaignId }).select('clientId')).map((n) => n.clientId),
  );
  const pending = recipients.filter((r) => !claimed.has(r.clientId));

  if (pending.length === 0) {
    await finish(campaignId, claimed.size, campaign.recipients);
    return 0;
  }

  let room = await marketingRoomToday(campaign.businessId, timezone, now);
  let sent = 0;

  for (const recipient of pending) {
    if (room.total <= 0) break;
    if (recipient.cold && room.cold <= 0) continue;
    if (!(await claimSendSlot(deps.redis, campaign.businessId))) break;

    const result = await send(deps, campaign.businessId, campaignId, campaign.message, recipient, now);
    if (!result) continue;

    sent += 1;
    room = { total: room.total - 1, cold: room.cold - (recipient.cold ? 1 : 0) };
  }

  logger.info({ campaignId, sent, remaining: pending.length - sent }, 'campaign drained');
  return sent;
}

async function send(
  deps: SendDeps,
  businessId: string,
  campaignId: string,
  message: string,
  recipient: Recipient,
  now: Date,
): Promise<boolean> {
  const result = await sendTracked(deps, {
    businessId,
    clientId: recipient.clientId,
    campaignId,
    kind: NOTIFICATION_KIND.CAMPAIGN,
    // One send per person per campaign, whatever happens to the pass that
    // claimed it. The clientId is in the key rather than a counter, so a
    // restarted drain rebuilds exactly the same claims.
    dedupeKey: `campaign:${campaignId}:${recipient.clientId}`,
    coldContact: recipient.cold,
    text: message,
    scheduledFor: now,
  });

  if (!result.ok) return false;

  await markMarketingSent(businessId, recipient.clientId, now);
  return true;
}

/** Mark it done once every recipient has been attempted. */
async function finish(campaignId: string, attempted: number, recipients: number): Promise<void> {
  await Campaign.updateOne(
    { _id: campaignId, status: CAMPAIGN_STATUS.SENDING },
    { $set: { status: CAMPAIGN_STATUS.SENT, completedAt: new Date() } },
  );
  logger.info({ campaignId, attempted, recipients }, 'campaign finished');
}

/**
 * Stop a campaign that is still going.
 *
 * Whatever has gone out has gone out — there is no unsending a WhatsApp message,
 * and pretending otherwise in the interface would be worse than the plain truth.
 * What this does is stop the rest, which is the only thing an owner who changed
 * their mind can actually be given.
 */
export async function cancelCampaign(businessId: string, campaignId: string): Promise<boolean> {
  const result = await Campaign.updateOne(
    { _id: campaignId, businessId, status: CAMPAIGN_STATUS.SENDING },
    { $set: { status: CAMPAIGN_STATUS.CANCELLED, completedAt: new Date() } },
  );
  return result.modifiedCount === 1;
}

/** The owner's campaign list, with each one's measured result. */
export async function listCampaigns(businessId: string, limit = 20): Promise<CampaignSummary[]> {
  const campaigns = await Campaign.find({ businessId }).sort({ createdAt: -1 }).limit(limit);
  if (campaigns.length === 0) return [];

  const rows = await Notification.find({
    campaignId: { $in: campaigns.map((c) => String(c._id)) },
  }).select('campaignId clientId status scheduledFor repliedAt rebookedBookingId');

  const byCampaign = new Map<string, typeof rows>();
  for (const row of rows) {
    const key = row.campaignId ?? '';
    const list = byCampaign.get(key);
    if (list) list.push(row);
    else byCampaign.set(key, [row]);
  }

  return Promise.all(
    campaigns.map(async (campaign) => {
      const id = String(campaign._id);
      const outcome = await outcomeOf(businessId, byCampaign.get(id) ?? []);

      return {
        id,
        audience: campaign.audience as CampaignAudience,
        message: campaign.message,
        status: campaign.status,
        createdAt: (campaign.createdAt ?? new Date()).toISOString(),
        completedAt: campaign.completedAt?.toISOString() ?? null,
        /**
         * Two numbers, not one. `targeted` is who it was aimed at; `outcome.sends`
         * is how many messages exist so far. A campaign mid-drain has fewer sends
         * than targets, and so does one whose remaining recipients opted out
         * before their turn came — collapsing them would hide both.
         */
        targeted: campaign.recipients,
        outcome,
      } satisfies CampaignSummary;
    }),
  );
}

/** Start the loop. Returns a stop function, as every other pass does. */
export function startCampaignJob(deps: SendDeps): () => void {
  const run = () => {
    drainCampaignsOnce(deps).catch((err) => logger.error({ err }, 'campaign tick failed'));
  };

  const timer = setInterval(run, INTERVAL_MS);
  timer.unref();

  return () => clearInterval(timer);
}
