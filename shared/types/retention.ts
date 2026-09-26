import { CLIENT_TAG, type ClientTag } from '../constants/client-tags.js';

/**
 * Retention — SPEC §6. The first messages the system sends to somebody who is
 * not expecting one.
 *
 * Everything before this phase was transactional: the customer booked, so the
 * confirmation and the reminder are owed. A nudge is not owed to anyone. It is
 * the business asking for attention it has not been given, which changes three
 * things and they are all encoded here rather than left to each caller:
 *
 * 1. **Opt-out is absolute** (§6.2). `STOP` means never again, for marketing.
 * 2. **Volume is capped** (§6.5). Not per campaign — per client, and per number
 *    per day. A customer targeted by three campaigns hears once; a number that
 *    sends hundreds of unsolicited messages in an afternoon gets restricted.
 * 3. **Nothing counts until an ack says so** (FINDING #3). `sendText` answers
 *    200 whether or not WhatsApp delivered anything, and it silently drops first
 *    contact to a brand-new contact — which is exactly who a lapsed client is.
 *    So a campaign reports delivery it can prove and shows the rest as
 *    unreachable, rather than presenting an accepted send as a success.
 */

/**
 * Who a campaign is aimed at.
 *
 * Both are CLIENT_TAG values rather than a separate vocabulary: the tags are
 * already how the CRM and the owner's own customer list describe these people,
 * and a second set of names would eventually disagree with the first.
 *
 * NEW and VIP are deliberately absent. Neither is a retention audience — a VIP
 * broadcast is an offer, which is a different feature with a different consent
 * question, and there is nothing to win back from someone who has just arrived.
 */
export const CAMPAIGN_AUDIENCE = {
  AT_RISK: CLIENT_TAG.AT_RISK,
  LAPSED: CLIENT_TAG.LAPSED,
} as const;

export type CampaignAudience = (typeof CAMPAIGN_AUDIENCE)[keyof typeof CAMPAIGN_AUDIENCE];

export const isCampaignAudience = (value: unknown): value is CampaignAudience =>
  value === CAMPAIGN_AUDIENCE.AT_RISK || value === CAMPAIGN_AUDIENCE.LAPSED;

/** The audience tags, for callers that hold a ClientTag[] and want to filter it. */
export const campaignAudienceTag = (audience: CampaignAudience): ClientTag => audience;

export const CAMPAIGN_STATUS = {
  /** Recipients claimed, sends draining a few at a time. */
  SENDING: 'sending',
  /** Every recipient has been attempted. Outcomes keep moving as acks arrive. */
  SENT: 'sent',
  /** The owner stopped it. Whatever had already gone out has gone out. */
  CANCELLED: 'cancelled',
} as const;

export type CampaignStatus = (typeof CAMPAIGN_STATUS)[keyof typeof CAMPAIGN_STATUS];

/**
 * How long a client is left alone after any marketing message, across every
 * campaign and the automatic nudges alike (§6.5, the over-messaging guard).
 *
 * Two weeks, because the thing being protected against is not one badly-judged
 * campaign — it is three reasonable ones in the same month landing on the same
 * person, which is how a business that thought it was being attentive gets
 * reported as a spammer.
 */
export const MARKETING_QUIET_DAYS = 14;

/**
 * Unsolicited messages one number may send per day, and the stricter cap on the
 * ones going to contacts who have never messaged it.
 *
 * The first is a ban-risk limit from the warm-up protocol in NOTES.md: a sudden
 * outbound burst is the single behaviour most likely to get a WhatsApp number
 * restricted, and a restricted number takes the business's bookings with it.
 *
 * The second exists because cold sends are both the likeliest to be silently
 * dropped (#830) and the likeliest to be reported by the recipient. A campaign
 * does not get to spend its whole daily allowance on the riskiest third of its
 * audience.
 */
export const BROADCAST_DAILY_CAP = 60;
export const COLD_CONTACT_DAILY_CAP = 15;

/**
 * Seconds between two sends from the same number, picked at random in this
 * range per send.
 *
 * Randomised rather than fixed: a message every 90.0 seconds for an hour is a
 * pattern no human produces, and the pattern is the thing being hidden. The
 * floor is what keeps a 60-message day from arriving as a 60-message minute.
 */
export const BROADCAST_GAP_SECONDS = { min: 45, max: 180 } as const;

/**
 * How late a nudge may be.
 *
 * Without this bound the first run of the feature messages every client who has
 * ever drifted — years of them, in one afternoon. The same protection the review
 * requests have, for the same reason, and it also means switching nudges on is a
 * safe thing for an owner to do rather than a thing to warn them about.
 */
export const NUDGE_MAX_LATE_DAYS = 21;

/** An owner's broadcast. Long enough for an offer, short enough to read on a phone. */
export const CAMPAIGN_MESSAGE_MAX = 600;

/**
 * How long after a marketing message a booking still counts as its result
 * (§6.3).
 *
 * Attribution by time is a claim about cause and this one is deliberately
 * modest: two weeks is long enough that somebody who read the nudge on Friday
 * and booked when they got paid still counts, and short enough that a regular
 * customer's next ordinary visit does not get credited to a campaign it had
 * nothing to do with. The evaluation chapter reports it as attributed, never as
 * caused.
 */
export const REBOOK_ATTRIBUTION_DAYS = 14;

/**
 * What a broadcast would reach, before sending it.
 *
 * The owner sees this first — the point being that "212 lapsed customers" and
 * "212 people who will get this message" are different numbers, and the second
 * one is the honest one. Every exclusion is named so the gap is explicable
 * rather than mysterious.
 */
export interface AudiencePreview {
  audience: CampaignAudience;
  /** Everyone carrying the tag. */
  matched: number;
  /** Of those, who would actually be sent to. */
  reachable: number;
  /** Excluded, with the reason. These sum to matched − reachable. */
  excluded: {
    optedOut: number;
    recentlyMessaged: number;
    noAddress: number;
  };
  /**
   * Of the reachable, how many have never messaged this business's number.
   *
   * Surfaced rather than hidden because it is the population WhatsApp may
   * silently refuse to deliver to (#830), and an owner who sends to 40 people
   * and hears back from 9 deserves to have known which 31 were a gamble.
   */
  coldContacts: number;
  /** What today's caps still allow. Sending more than this spills to tomorrow. */
  remainingToday: { total: number; cold: number };
}

/**
 * A campaign's measured result (§6.3).
 *
 * `delivered` is ack-backed and `undelivered` is its complement among the sends
 * that the provider accepted — the two together are the cold-contact answer,
 * measured on real traffic rather than assumed in advance.
 */
export interface CampaignOutcome {
  /**
   * Messages claimed. The denominator of every rate below, and the four
   * statuses that follow partition it exactly.
   *
   * Distinct from a campaign's `targeted` on purpose: a campaign still draining
   * has fewer sends than targets, and so does one whose remaining recipients
   * opted out before their turn came. Dividing by the target count would report
   * a campaign one message in as having delivered to half a percent of its
   * audience, which is a statement about the calendar rather than about delivery.
   */
  sends: number;
  /** An ack said delivered or read. The only proof of arrival there is. */
  delivered: number;
  /** Accepted by the provider, no ack. Probably never arrived. */
  undelivered: number;
  /** Still owed — the session was down when its turn came. */
  queued: number;
  /** Claimed, then deliberately not sent: opted out or capped since. */
  skipped: number;
  /** They messaged back within the attribution window. */
  replied: number;
  /** They booked within it. The conversion numerator. */
  rebooked: number;
  /** They replied STOP. Worth seeing, and worth seeing next to `rebooked`. */
  optedOut: number;
}

export interface CampaignSummary {
  id: string;
  audience: CampaignAudience;
  message: string;
  status: CampaignStatus;
  createdAt: string;
  /** Null until the last recipient has been attempted. */
  completedAt: string | null;
  /** How many people it was aimed at, fixed when it was created. */
  targeted: number;
  outcome: CampaignOutcome;
}

/** The automatic half: what the nudges have done lately, on the same terms. */
export interface NudgeReport {
  enabled: boolean;
  /** Business-local days the window covers. */
  days: number;
  outcome: CampaignOutcome;
}
