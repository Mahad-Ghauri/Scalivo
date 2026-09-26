import {
  BOOKING_STATUS,
  CLIENT_TAG,
  DELIVERY_STATUS,
  type AudiencePreview,
  type CampaignAudience,
} from '@scalivo/shared';
import { Booking } from '../models/Booking.js';
import { Client } from '../models/Client.js';
import { ClientProfile } from '../models/ClientProfile.js';
import { Notification } from '../models/Notification.js';
import { atRiskSince, computeTags } from '../crm/tags.js';
import { toTaggable } from '../crm/profile.js';
import { NOT_ELIGIBLE, eligibilityOf } from './eligibility.js';
import { marketingRoomToday } from './caps.js';

/**
 * Who a campaign would actually reach — SPEC §6.2.
 *
 * The owner asks for "lapsed customers" and the honest answer is smaller than the
 * tag count, for three unrelated reasons: some said STOP, some heard from us last
 * week, and some are a name on a piece of paper with no number attached. Each
 * exclusion is counted separately and shown, because an unexplained gap between
 * "212 lapsed" and "178 will get this" reads as a bug and gets worked around.
 *
 * Tags are COMPUTED here rather than queried, the same limitation the customer
 * list carries and for the same reason: a stored LAPSED is wrong the day after it
 * is written (crm/tags.ts). So this reads the business's profiles, narrowed as
 * far as Mongo can narrow them, and decides in memory. At pilot scale that is a
 * few hundred documents. The bound below is what keeps it from silently becoming
 * a problem at ten thousand.
 */

/**
 * Enough for any business this is built for, and a ceiling rather than a page:
 * a campaign that claims the first 2,000 of 5,000 lapsed clients would be a
 * campaign the owner thinks went to everyone.
 */
const MAX_CANDIDATES = 2000;

const DAY_MS = 86_400_000;

/** Beyond 90 days is LAPSED, which absorbs AT_RISK (crm/tags.ts). */
const LAPSED_DAYS = 90;

export interface Recipient {
  clientId: string;
  displayName: string | null;
  /** Where to reach them, resolved from the same rule the send path uses. */
  hasAddress: boolean;
  /** Never reached from this number before — the #830 population. */
  cold: boolean;
  lastVisitAt: Date | null;
  /** When they crossed their own return window. Null for a lapsed client with no cadence. */
  atRiskSince: Date | null;
  /** Their most-booked service, for a nudge that names what they had. */
  topServiceId: string | null;
}

export interface Audience {
  preview: AudiencePreview;
  /** Eligible, addressable, in the order they should be sent to. */
  recipients: Recipient[];
}

/**
 * The window of last-visit dates that could possibly carry the tag.
 *
 * Narrowing in the query rather than in memory, so a business with years of
 * history does not load every profile to discard most of them. AT_RISK needs at
 * least three visits and a gap of its own, both of which are decided in memory —
 * this only rules out the ones no arithmetic could bring in.
 */
function lastVisitWindow(audience: CampaignAudience, now: Date): Record<string, Date> {
  const lapsedAt = new Date(now.getTime() - LAPSED_DAYS * DAY_MS);
  // Lapsed: last visit at or before the 90-day line. At risk: after it, since
  // LAPSED absorbs anything older.
  return audience === CLIENT_TAG.LAPSED ? { $lte: lapsedAt } : { $gt: lapsedAt };
}

export async function buildAudience(
  businessId: string,
  timezone: string,
  audience: CampaignAudience,
  now = new Date(),
): Promise<Audience> {
  const profiles = await ClientProfile.find({
    businessId,
    lastVisitAt: lastVisitWindow(audience, now),
  })
    .sort({ lastVisitAt: -1 })
    .limit(MAX_CANDIDATES);

  const clientIds = profiles.map((p) => p.clientId);

  /**
   * Everything else about these people, in four queries rather than four per
   * person. An upcoming booking settles the question on its own — chasing
   * someone who is coming on Thursday reads as a business that does not know its
   * own diary — so it is part of the tag, not a filter applied after it.
   */
  const [clients, booked, whatsappBookers, everDelivered] = await Promise.all([
    Client.find({ _id: { $in: clientIds } }).select('displayName lids phone'),
    Booking.distinct('clientId', {
      businessId,
      clientId: { $in: clientIds },
      startsAt: { $gte: now },
      status: { $nin: [BOOKING_STATUS.CANCELLED, BOOKING_STATUS.NO_SHOW] },
    }),
    // Warm, proven: they messaged this number to make a booking.
    Booking.distinct('clientId', { businessId, clientId: { $in: clientIds }, source: 'whatsapp' }),
    // Warm, also proven: something we sent them from this number was acked.
    Notification.distinct('clientId', {
      businessId,
      clientId: { $in: clientIds },
      status: { $in: [DELIVERY_STATUS.DELIVERED, DELIVERY_STATUS.READ] },
    }),
  ]);

  const byId = new Map(clients.map((c) => [String(c._id), c]));
  const hasUpcoming = new Set(booked);
  const warm = new Set<string>([...whatsappBookers, ...everDelivered]);

  const excluded = { optedOut: 0, recentlyMessaged: 0, noAddress: 0 };
  const recipients: Recipient[] = [];
  let matched = 0;

  for (const profile of profiles) {
    const taggable = toTaggable(profile);
    const tags = computeTags(taggable, { hasUpcomingBooking: hasUpcoming.has(profile.clientId), now });
    if (!tags.includes(audience)) continue;

    matched += 1;

    const eligibility = eligibilityOf(profile, now);
    if (!eligibility.ok) {
      if (eligibility.reason === NOT_ELIGIBLE.OPTED_OUT) excluded.optedOut += 1;
      else excluded.recentlyMessaged += 1;
      continue;
    }

    // The same rule as notifications/address.ts: a LID if they have ever
    // messaged anyone, otherwise the phone the owner typed. Neither means a
    // walk-in with a name and nothing else, and no campaign can reach them.
    const client = byId.get(profile.clientId);
    const hasAddress = Boolean(client?.lids?.[0] ?? client?.phone);
    if (!hasAddress) {
      excluded.noAddress += 1;
      continue;
    }

    recipients.push({
      clientId: profile.clientId,
      displayName: client?.displayName ?? null,
      hasAddress,
      cold: !warm.has(profile.clientId),
      lastVisitAt: taggable.lastVisitAt,
      atRiskSince: atRiskSince(taggable),
      topServiceId: topOf(profile.serviceCounts),
    });
  }

  /**
   * Warm contacts first.
   *
   * Two reasons, both about the caps. A cold send is the one WhatsApp may
   * silently drop and the one most likely to be reported, so it draws on a
   * stricter allowance — and if a campaign is going to spill into tomorrow, the
   * recipients it can actually reach should be the ones it reaches today.
   */
  recipients.sort((a, b) => Number(a.cold) - Number(b.cold));

  const room = await marketingRoomToday(businessId, timezone, now);

  return {
    preview: {
      audience,
      matched,
      reachable: recipients.length,
      excluded,
      coldContacts: recipients.filter((r) => r.cold).length,
      remainingToday: room,
    },
    recipients,
  };
}

/** Their most-booked service id, or null. A Map on the document, plain object off a lean read. */
function topOf(counts: unknown): string | null {
  const entries =
    counts instanceof Map
      ? [...counts.entries()]
      : Object.entries((counts ?? {}) as Record<string, number>);

  let best: [string, number] | null = null;
  for (const [id, count] of entries as [string, number][]) {
    if (!best || count > best[1]) best = [id, count];
  }
  return best?.[0] ?? null;
}
