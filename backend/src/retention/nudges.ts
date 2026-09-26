import type { HydratedDocument, InferSchemaType } from 'mongoose';
import {
  CLIENT_TAG,
  NOTIFICATION_KIND,
  NUDGE_MAX_LATE_DAYS,
  type CampaignOutcome,
} from '@scalivo/shared';
import { Business } from '../models/Business.js';
import { Notification } from '../models/Notification.js';
import { Service } from '../models/Service.js';
import { logger } from '../lib/logger.js';
import * as copy from '../whatsapp/messages.js';
import { sendTracked, type SendDeps } from '../notifications/send.js';
import { buildAudience, type Recipient } from './audience.js';
import { markMarketingSent } from './eligibility.js';
import { claimSendSlot } from './throttle.js';
import { localDayStart } from './caps.js';
import { outcomeOf } from './report.js';

/**
 * Rebooking nudges — SPEC §6.1.
 *
 * A pass, like the reminders and the rating requests, for the reason this whole
 * subsystem exists: **nothing happens when a customer stops coming.** There is no
 * event to hook, no webhook, no booking — the absence is the signal, so something
 * has to go looking. That is also why the tags this reads are computed rather
 * than stored (crm/tags.ts): a stored AT_RISK would be wrong the day after it was
 * written, and a nudge fired off a stale tag is a message to somebody who came in
 * last week.
 *
 * Three bounds decide who actually hears from us, and every one of them is
 * protecting something real:
 *
 * - **Their own cadence** (AT_RISK, 1.5× their usual gap) — a fixed number of
 *   days is wrong for almost everybody, and being wrong here means either
 *   chasing a customer who is not late or writing off one who is long gone.
 * - **How late the nudge may be** (NUDGE_MAX_LATE_DAYS) — without it, the first
 *   run messages every client who has ever drifted, in one afternoon. That is
 *   both a bad experience and the single behaviour most likely to get a WhatsApp
 *   number restricted (NOTES.md).
 * - **The caps and the throttle** (§6.5) — shared with the broadcasts, because
 *   what is being protected is the number, not the feature.
 *
 * One nudge per lapse, not one per day: the dedupe key is built from the visit
 * they are lapsing FROM, so a customer who never comes back is claimed once and
 * never again, and a customer who returns and lapses a second time gets a second
 * key with no bookkeeping anywhere.
 */

/** Five minutes. The deadline is measured in days; the throttle does the spacing. */
const INTERVAL_MS = 5 * 60 * 1000;

const DAY_MS = 86_400_000;

type BusinessDoc = HydratedDocument<InferSchemaType<typeof Business.schema>>;

export async function nudgesOnce(deps: SendDeps, now = new Date()): Promise<void> {
  const businesses = await Business.find({ 'retention.nudges': { $ne: false } });

  for (const business of businesses) {
    try {
      await nudgeBusiness(deps, business, now);
    } catch (err) {
      // One business's bad data must not stop everyone else's nudges — the same
      // isolation the reminder and review passes have.
      logger.error({ err, businessId: String(business._id) }, 'nudge pass failed');
    }
  }
}

/**
 * One business's due nudges.
 *
 * Exported for the tests, for the same reason `remindBusiness` is: driving the
 * global pass against a shared database picks up other suites' clients
 * mid-assertion, and the failures then look like duplicate sends.
 */
export async function nudgeBusiness(
  deps: SendDeps,
  business: BusinessDoc,
  now = new Date(),
): Promise<number> {
  const businessId = String(business._id);
  const timezone = business.timezone ?? 'Asia/Karachi';

  // Nothing to send from. Checked before building the audience, which is the
  // expensive half, and before claiming anything: a nudge claimed against a
  // business with no number would sit QUEUED forever and burn its one chance.
  if (!business.whatsapp?.sessionId) return 0;

  const { recipients, preview } = await buildAudience(businessId, timezone, CLIENT_TAG.AT_RISK, now);

  const due = recipients.filter((r) => isDue(r, now));
  if (due.length === 0) return 0;

  const serviceNames = await namesOf(businessId, due);

  let sent = 0;
  let room = preview.remainingToday;

  if (room.total <= 0) {
    // Worth a line, because the cap is shared with broadcasts AND rating
    // requests: a very busy day can spend the number's whole allowance before
    // the nudges get a turn, and "nudges stopped working" is otherwise an
    // invisible consequence of a good week.
    logger.info({ businessId, due: due.length }, 'daily marketing cap reached — nudges deferred');
    return 0;
  }

  for (const recipient of due) {
    if (room.total <= 0) break;
    // The cold allowance is separate and smaller. Running out of it stops the
    // cold ones only — the warm recipients behind them are still fine to send.
    if (recipient.cold && room.cold <= 0) continue;

    // The number's turn has to come round. Declining is not an error: the next
    // tick picks up whoever is left, in the same order.
    if (!(await claimSendSlot(deps.redis, businessId))) break;

    const dedupeKey = nudgeKey(recipient);
    if (!dedupeKey) continue;

    const result = await sendTracked(deps, {
      businessId,
      clientId: recipient.clientId,
      kind: NOTIFICATION_KIND.REBOOK_NUDGE,
      dedupeKey,
      coldContact: recipient.cold,
      text: copy.rebookNudge({
        firstName: recipient.displayName?.split(' ')[0] ?? null,
        businessName: business.name,
        serviceName: recipient.topServiceId ? serviceNames.get(recipient.topServiceId) ?? null : null,
        weeksSince: weeksSince(recipient.lastVisitAt, now),
      }),
      scheduledFor: now,
    });

    if (!result.ok) continue;

    /**
     * The quiet period starts at the CLAIM, not at a confirmed delivery.
     *
     * A claimed message is owed and will drain when the session returns, so
     * treating it as unsent would let tomorrow's campaign target the same person
     * — and they would receive both at once the moment the number came back.
     */
    await markMarketingSent(businessId, recipient.clientId, now);

    sent += 1;
    room = { total: room.total - 1, cold: room.cold - (recipient.cold ? 1 : 0) };
    logger.info(
      { businessId, clientId: recipient.clientId, cold: recipient.cold, status: result.status },
      'rebooking nudge sent',
    );
  }

  return sent;
}

/**
 * Is this the right moment for this person?
 *
 * They are already known to be AT_RISK — that is what the audience means — so the
 * only question left is whether they crossed that line recently enough for a
 * message about it to make sense. A client with no measurable cadence has no
 * line to have crossed and is never nudged: with fewer than three visits, "late"
 * is a guess, and a guess is not a reason to message somebody.
 */
function isDue(recipient: Recipient, now: Date): boolean {
  if (!recipient.atRiskSince) return false;
  const lateBy = now.getTime() - recipient.atRiskSince.getTime();
  return lateBy >= 0 && lateBy <= NUDGE_MAX_LATE_DAYS * DAY_MS;
}

/**
 * One claim per lapse.
 *
 * Keyed on the day of the visit they are lapsing from, so it is stable for as
 * long as they stay away — every later pass builds the same key and collides on
 * the unique index — and different the moment they come in again.
 */
function nudgeKey(recipient: Recipient): string | null {
  if (!recipient.lastVisitAt) return null;
  return `nudge:${recipient.clientId}:${recipient.lastVisitAt.toISOString().slice(0, 10)}`;
}

function weeksSince(lastVisitAt: Date | null, now: Date): number {
  if (!lastVisitAt) return 0;
  return Math.max(1, Math.round((now.getTime() - lastVisitAt.getTime()) / (7 * DAY_MS)));
}

/** The services these people usually book, in one query. */
async function namesOf(businessId: string, recipients: Recipient[]): Promise<Map<string, string>> {
  const ids = [...new Set(recipients.map((r) => r.topServiceId).filter((id): id is string => !!id))];
  if (ids.length === 0) return new Map();

  const services = await Service.find({ businessId, _id: { $in: ids } }).select('name');
  return new Map(services.map((s) => [String(s._id), s.name]));
}

/** What the nudges have done lately, on the same terms a campaign reports. */
export async function nudgeReport(
  businessId: string,
  timezone: string,
  days: number,
  now = new Date(),
): Promise<CampaignOutcome> {
  const since = new Date(localDayStart(timezone, now).getTime() - (days - 1) * DAY_MS);

  const rows = await Notification.find({
    businessId,
    kind: NOTIFICATION_KIND.REBOOK_NUDGE,
    createdAt: { $gte: since },
  }).select('clientId status scheduledFor repliedAt rebookedBookingId');

  return outcomeOf(businessId, rows);
}

/** Start the loop. Returns a stop function, as every other pass does. */
export function startNudgeJob(deps: SendDeps): () => void {
  const run = () => {
    nudgesOnce(deps).catch((err) => logger.error({ err }, 'nudge tick failed'));
  };

  const timer = setInterval(run, INTERVAL_MS);
  // Without unref a finished container lingers on this timer.
  timer.unref();

  return () => clearInterval(timer);
}
