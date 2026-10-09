import { DELIVERY_STATUS, type CampaignOutcome, type DeliveryStatus } from '@scalivo/shared';
import { ClientProfile } from '../models/ClientProfile.js';

/**
 * What a set of marketing sends actually achieved — SPEC §6.3.
 *
 * The one rule: **delivery is what an ack says, never what the send call
 * returned.** `sendText` answers 200 whether or not WhatsApp delivered anything,
 * and it silently drops first contact to a brand-new contact (#830) — which is
 * precisely the lapsed client a win-back campaign is aimed at. A conversion rate
 * with an accepted send in the denominator and an assumed delivery in the
 * numerator would report a campaign that reached nobody as a decent result, and
 * that number would then go in the thesis.
 *
 * So the partition below is exhaustive and each part means one thing:
 *
 *   delivered    an ack said delivered or read. Proof.
 *   undelivered  we handed it over and nothing ever came back. Probably lost.
 *   queued       still owed — the session was down when its turn came.
 *   skipped      claimed, then deliberately not sent (opted out since, capped).
 *
 * `undelivered` is the honest half of the cold-contact question, measured on real
 * traffic. It is also why `coldContact` is recorded at claim time: the two
 * together tell an owner whether the 31 people who never answered were a
 * WhatsApp limitation or an uninterested audience.
 */

export interface OutcomeRow {
  clientId: string;
  status: DeliveryStatus;
  scheduledFor: Date;
  repliedAt?: Date | null;
  rebookedBookingId?: string | null;
}

export async function outcomeOf(
  businessId: string,
  rows: OutcomeRow[],
  knownOptOuts?: ReadonlyMap<string, Date>,
): Promise<CampaignOutcome> {
  const outcome: CampaignOutcome = {
    sends: rows.length,
    delivered: 0,
    undelivered: 0,
    queued: 0,
    skipped: 0,
    replied: 0,
    rebooked: 0,
    optedOut: 0,
  };

  if (rows.length === 0) return outcome;

  /** The earliest send to each person, so an opt-out is only counted if it followed one. */
  const sentAt = new Map<string, Date>();

  for (const row of rows) {
    switch (row.status) {
      case DELIVERY_STATUS.DELIVERED:
      case DELIVERY_STATUS.READ:
        outcome.delivered += 1;
        break;
      case DELIVERY_STATUS.QUEUED:
        outcome.queued += 1;
        break;
      case DELIVERY_STATUS.SKIPPED:
        outcome.skipped += 1;
        break;
      // ACCEPTED and FAILED together: one was taken and never acknowledged, the
      // other was refused outright. Neither arrived, and an owner does not need
      // two words for "did not get there".
      default:
        outcome.undelivered += 1;
    }

    if (row.repliedAt) outcome.replied += 1;
    if (row.rebookedBookingId) outcome.rebooked += 1;

    const existing = sentAt.get(row.clientId);
    if (!existing || row.scheduledFor < existing) sentAt.set(row.clientId, row.scheduledFor);
  }

  /**
   * Opt-outs, attributed rather than merely counted.
   *
   * A recipient who was already opted out could not have been sent to, so any
   * opt-out among these people happened after a message — but only the ones
   * whose STOP came after THIS send belong to it. Without the timestamp
   * comparison a business that ran a campaign in March would see its opt-outs
   * again on every campaign after it, which would make the number useless in
   * exactly the direction that discourages using the feature honestly.
   */
  const optedOut = knownOptOuts ?? new Map((await ClientProfile.find({
    businessId,
    clientId: { $in: [...sentAt.keys()] },
    marketingOptOut: true,
    marketingOptOutAt: { $ne: null },
  }).select('clientId marketingOptOutAt')).flatMap((profile) =>
    profile.marketingOptOutAt ? [[profile.clientId, profile.marketingOptOutAt] as const] : [],
  ));

  for (const [clientId, after] of sentAt) {
    const at = optedOut.get(clientId);
    if (at && after && at >= after) outcome.optedOut += 1;
  }

  return outcome;
}
