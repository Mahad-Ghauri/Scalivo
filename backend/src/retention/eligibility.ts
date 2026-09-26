import { MARKETING_QUIET_DAYS } from '@scalivo/shared';
import { ClientProfile } from '../models/ClientProfile.js';

/**
 * May we send this person a message they did not ask for?
 *
 * One implementation, consulted by the nudge pass, the broadcast drain, the
 * review request and the send path itself. Two would drift, and the way they
 * would drift is the reason this file exists at all: before retention, the
 * review request read `Client.marketingOptOut` — a field on the GLOBAL person
 * document that nothing has ever written — while `STOP` wrote the per-business
 * flag on ClientProfile. The opt-out looked implemented and honoured nothing.
 *
 * Per-business is the correct scope and the only one used now: a customer
 * silencing one salon's offers has not asked to be silenced by a gym they have
 * never heard of, and the message that opted them out arrived on exactly one
 * session.
 */

export const NOT_ELIGIBLE = {
  /** They sent STOP. Nothing overrides this. */
  OPTED_OUT: 'opted_out',
  /** Inside the quiet period after their last marketing message (§6.5). */
  RECENTLY_MESSAGED: 'recently_messaged',
} as const;

export type NotEligible = (typeof NOT_ELIGIBLE)[keyof typeof NOT_ELIGIBLE];

export type Eligibility = { ok: true } | { ok: false; reason: NotEligible };

const DAY_MS = 86_400_000;

/**
 * The quiet-period test, split out because the audience preview needs to apply
 * it to two hundred profiles it has already loaded, and re-reading each one from
 * the database to answer a subtraction would be absurd.
 */
export function withinQuietPeriod(lastMarketingMessageAt: Date | null, now: Date): boolean {
  if (!lastMarketingMessageAt) return false;
  return now.getTime() - lastMarketingMessageAt.getTime() < MARKETING_QUIET_DAYS * DAY_MS;
}

export function eligibilityOf(
  profile: { marketingOptOut?: boolean; lastMarketingMessageAt?: Date | null } | null,
  now: Date,
): Eligibility {
  if (profile?.marketingOptOut) return { ok: false, reason: NOT_ELIGIBLE.OPTED_OUT };
  if (withinQuietPeriod(profile?.lastMarketingMessageAt ?? null, now)) {
    return { ok: false, reason: NOT_ELIGIBLE.RECENTLY_MESSAGED };
  }
  return { ok: true };
}

/** The same question for one client, read fresh. */
export async function marketingEligibility(
  businessId: string,
  clientId: string,
  now = new Date(),
): Promise<Eligibility> {
  const profile = await ClientProfile.findOne({ businessId, clientId }).select(
    'marketingOptOut lastMarketingMessageAt',
  );
  return eligibilityOf(profile, now);
}

/**
 * Just the opt-out, for the send path.
 *
 * Deliberately NOT the full eligibility check: a message that was legitimately
 * claimed and then sat in the queue through an outage must still go out
 * afterwards, and the quiet period would refuse it — the send itself is what
 * started that period. Consent can be withdrawn between claim and send; the
 * quiet period cannot be newly violated by the message that set it.
 */
export async function optedOut(businessId: string, clientId: string): Promise<boolean> {
  const profile = await ClientProfile.findOne({ businessId, clientId }).select('marketingOptOut');
  return Boolean(profile?.marketingOptOut);
}

/**
 * Start the quiet period.
 *
 * Called after a claim succeeds rather than after a send succeeds, on purpose. A
 * claimed message is owed and will drain, so treating it as unsent would let a
 * second campaign claim the same person while the first one's message is still
 * sitting in the queue — and they would then receive both, one after the other,
 * the moment the session came back.
 *
 * Upserts because a broadcast can reach someone with no profile row: an imported
 * contact who has never booked is precisely who a win-back campaign is for.
 */
export async function markMarketingSent(
  businessId: string,
  clientId: string,
  at: Date,
): Promise<void> {
  await ClientProfile.updateOne(
    { businessId, clientId },
    { $setOnInsert: { businessId, clientId }, $max: { lastMarketingMessageAt: at } },
    { upsert: true, setDefaultsOnInsert: true },
  );
}
