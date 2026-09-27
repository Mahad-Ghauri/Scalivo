import { DateTime } from 'luxon';
import type { HydratedDocument, InferSchemaType } from 'mongoose';
import {
  ALERT_WAKING_HOURS,
  BRIEFING_HOUR_RANGE,
  BRIEFING_KIND,
  BRIEFING_MAX_LATE_MINUTES,
  DEFAULT_BRIEFING_HOUR,
  WEEKLY_BRIEFING_WEEKDAY,
} from '@scalivo/shared';
import { Briefing } from '../models/Briefing.js';
import { Business } from '../models/Business.js';
import { toBusinessLocal } from '../lib/time.js';
import { logger } from '../lib/logger.js';
import type { SendDeps } from '../notifications/send.js';
import { dailyFacts, weeklyFacts } from './facts.js';
import { deliverBriefing, type BriefingResult } from './deliver.js';
import { detectAlerts, withinCooldown } from './thresholds.js';

/**
 * The trigger layer — SPEC §11.1.
 *
 * A pass, on a timer, exactly like the reminders and the nudges, and for the same
 * reason the reminder pass is not a "cron at 7am": a tick that looks only at the
 * present moment has no memory. A process that was restarting at 07:00 would skip
 * that morning's briefing for every business at once and nobody would ever find
 * out. So the pass asks "is this business's briefing due and not yet sent", which
 * is a question a late tick can still answer correctly.
 *
 * Two clocks are in play and conflating them is the classic bug here. The tick is
 * a UTC interval; "7am" is business-local. A business in Karachi and one in
 * Lahore share a zone, but the code must not assume that, because the same pass
 * will one day run for both — and a server in another region would otherwise brief
 * everybody five hours out.
 */

/** Five minutes. A briefing due at 7:00 arriving at 7:04 is a briefing at 7am. */
const INTERVAL_MS = 5 * 60 * 1000;

/**
 * The quiet gap between anything the agent sends and the next alert.
 *
 * Without it, a Monday morning could fire the daily briefing, the weekly summary
 * and an empty-day alert inside one tick — three notifications in a second, which
 * is how an owner decides this thing is noise. The daily briefing goes first
 * because it is time-critical; the alerts have a week-long cooldown and can wait
 * until the afternoon.
 */
const ALERT_MIN_GAP_HOURS = 4;

type BusinessDoc = HydratedDocument<InferSchemaType<typeof Business.schema>>;

/**
 * Business-local `hour` o'clock on a given local date, as a UTC instant.
 *
 * The date is a local calendar date and the hour a local wall clock, so this is
 * the one place the two meet. `businessDayBounds` is not reused because it answers
 * a different question (midnight to midnight) and reusing it would need an offset
 * in hours, which is exactly the string-and-arithmetic date maths lib/time.ts
 * exists to forbid.
 */
export function briefingDueAt(localDate: string, hour: number, timezone: string): Date {
  const day = DateTime.fromISO(localDate, { zone: timezone });
  if (!day.isValid) {
    throw new Error(`Invalid date "${localDate}" in zone "${timezone}": ${day.invalidReason}`);
  }
  return day.set({ hour, minute: 0, second: 0, millisecond: 0 }).toJSDate();
}

/** Clamped to the hours an owner may be woken, whatever is in the database. */
export function briefingHour(business: BusinessDoc): number {
  const configured = business.agent?.hour ?? DEFAULT_BRIEFING_HOUR;
  if (!Number.isFinite(configured)) return DEFAULT_BRIEFING_HOUR;
  return Math.min(BRIEFING_HOUR_RANGE.max, Math.max(BRIEFING_HOUR_RANGE.min, Math.round(configured)));
}

export async function agentOnce(deps: SendDeps, now = new Date()): Promise<void> {
  const businesses = await Business.find({ 'agent.briefings': { $ne: false } });

  for (const business of businesses) {
    try {
      await briefBusiness(deps, business, now);
    } catch (err) {
      // One business's bad data must not cost every other owner their briefing —
      // the same isolation the reminder, review and nudge passes have.
      logger.error({ err, businessId: String(business._id) }, 'briefing pass failed');
    }
  }
}

/**
 * One business's due briefings.
 *
 * Exported for the tests, for the reason `remindBusiness` and `nudgeBusiness` are:
 * driving the global pass against a shared database picks up other suites'
 * businesses mid-assertion, and the failures look like duplicates rather than the
 * parallelism they are.
 *
 * Returns what it sent, which is what the tests and the manual trigger read.
 */
export async function briefBusiness(
  deps: SendDeps,
  business: BusinessDoc,
  now = new Date(),
): Promise<BriefingResult[]> {
  const businessId = String(business._id);
  const timezone = business.timezone ?? 'Asia/Karachi';

  // Checked here and not only in the caller's query, so reaching this function
  // directly cannot bypass an owner's decision — same rule as reminders.enabled.
  if (business.agent?.briefings === false) return [];

  const hour = briefingHour(business);
  const local = toBusinessLocal(now, timezone);
  const today = local.toISODate();
  if (!today) return [];

  const sent: BriefingResult[] = [];

  const shared = {
    businessId,
    businessName: business.name,
    timezone,
    whatsappTo: business.agent?.whatsappTo ?? null,
    sessionId: business.whatsapp?.sessionId ?? null,
  };

  /* ------------------------------------------------- the morning briefing */

  const dailyDue = briefingDueAt(today, hour, timezone);
  const lateBy = now.getTime() - dailyDue.getTime();

  if (lateBy >= 0 && lateBy <= BRIEFING_MAX_LATE_MINUTES * 60_000) {
    const facts = await dailyFacts(businessId, timezone, today);

    /**
     * Nothing booked and nobody rostered is a day off, not a quiet day.
     *
     * Briefing an owner at seven in the morning to tell them their closed Sunday
     * is empty is the daily equivalent of the empty-day alert firing on a day the
     * business chooses not to open — and it would happen every single week, which
     * is how a summary becomes the notification someone turns off. A day with
     * appointments on it is still briefed however the roster reads, because a
     * walk-in booked onto a closed day is exactly the thing worth being told.
     */
    if (facts.appointments > 0 || facts.openHours > 0) {
      sent.push(
        await deliverBriefing(deps, {
          ...shared,
          kind: BRIEFING_KIND.DAILY,
          dedupeKey: `daily:${today}`,
          scheduledFor: dailyDue,
          facts,
        }),
      );
    }
  }

  /* --------------------------------------------------- the Monday summary */

  /**
   * Allowed all Monday, unlike the daily briefing's four hours.
   *
   * Not an inconsistency: a briefing about today's diary is worth less every hour
   * it is late, because the owner is already living the day it describes. A
   * summary of last week is exactly as true at four in the afternoon, so a
   * morning of downtime should cost the wording's timeliness and not the summary.
   */
  if (local.weekday === WEEKLY_BRIEFING_WEEKDAY && now >= dailyDue) {
    // Keyed on the week being REPORTED, not the Monday it is sent on, so the key
    // says what the briefing is about and cannot collide across a year boundary.
    const reported = local.startOf('week').minus({ weeks: 1 }).toFormat("kkkk-'W'WW");

    sent.push(
      await deliverBriefing(deps, {
        ...shared,
        kind: BRIEFING_KIND.WEEKLY,
        dedupeKey: `weekly:${reported}`,
        scheduledFor: dailyDue,
        facts: await weeklyFacts(businessId, timezone, now),
      }),
    );
  }

  /* --------------------------------------------------------- the alerts */

  if (await alertsAllowed(businessId, local.hour, now, sent)) {
    const candidates = await detectAlerts(businessId, timezone, now);

    for (const candidate of candidates) {
      if (await withinCooldown(businessId, candidate.type, now)) continue;

      sent.push(
        await deliverBriefing(deps, {
          ...shared,
          kind: BRIEFING_KIND.ALERT,
          alertType: candidate.type,
          // Dated, so the same condition next week is a new alert rather than a
          // collision the cooldown has already let through.
          dedupeKey: `alert:${candidate.type}:${today}`,
          scheduledFor: now,
          facts: candidate.facts,
        }),
      );

      // One alert per pass. An owner who gets three at once reads none of them,
      // and the ordering in detectAlerts already says which one matters most.
      break;
    }
  }

  return sent;
}

/**
 * Is this a moment to interrupt the owner with an alert?
 *
 * Three conditions, and the third is the one that is easy to forget: an alert is
 * only worth sending inside waking hours, only when nothing else has just been
 * sent, and only when this pass has not itself just briefed them.
 */
async function alertsAllowed(
  businessId: string,
  localHour: number,
  now: Date,
  sentThisPass: BriefingResult[],
): Promise<boolean> {
  if (localHour < ALERT_WAKING_HOURS.FROM || localHour >= ALERT_WAKING_HOURS.UNTIL) return false;
  if (sentThisPass.some((result) => result.sent)) return false;

  const recent = await Briefing.countDocuments({
    businessId,
    createdAt: { $gte: new Date(now.getTime() - ALERT_MIN_GAP_HOURS * 3_600_000) },
  });

  return recent === 0;
}

/** Start the loop. Returns a stop function, as every other pass does. */
export function startAgentJob(deps: SendDeps): () => void {
  const run = () => {
    agentOnce(deps).catch((err) => logger.error({ err }, 'briefing tick failed'));
  };

  const timer = setInterval(run, INTERVAL_MS);
  // Without unref a finished container lingers for up to five minutes on this timer.
  timer.unref();

  return () => clearInterval(timer);
}
