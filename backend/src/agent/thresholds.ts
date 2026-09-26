import {
  ALERT_COOLDOWN_DAYS,
  ALERT_TYPE,
  BRIEFING_KIND,
  CAMPAIGN_AUDIENCE,
  EMPTY_DAY_HORIZON,
  LAPSED_PILEUP_MIN,
  LAPSED_PILEUP_QUIET_DAYS,
  NO_SHOW_BASELINE_DAYS,
  NO_SHOW_MIN_SAMPLE,
  NO_SHOW_SPIKE_FLOOR,
  NO_SHOW_SPIKE_MARGIN,
  NO_SHOW_WINDOW_DAYS,
  type AlertFacts,
  type AlertType,
} from '@scalivo/shared';
import { Briefing } from '../models/Briefing.js';
import { Campaign } from '../models/Campaign.js';
import { buildAudience } from '../retention/audience.js';
import { toBusinessLocal } from '../lib/time.js';
import { countOnDate, noShowWindow, rosterMinutes } from './facts.js';

/**
 * The thresholds — SPEC §11.1's event-driven triggers.
 *
 * Every one of these is a rule, written down, with a number next to it. That is
 * the honest framing of the whole agent and it is most obvious here: nothing
 * below is inferred, learned or reasoned about. The LLM never sees this file.
 *
 * The hard part was not detecting the conditions, it was **not crying wolf**. An
 * alert an owner learns to swipe away has negative value — it costs their
 * attention and trains them to miss the one that matters (which, in this system,
 * is Session Health saying their WhatsApp is down). So each detector carries
 * three guards:
 *
 * 1. **A minimum sample**, so a quiet week cannot produce a statistic.
 * 2. **A comparison against the business's own past**, not a figure chosen in
 *    advance. SPEC §11.3 asks for per-business thresholds; a configurable number
 *    would just move the guessing to the owner, who has no way to know either.
 * 3. **A cooldown**, because a condition that is still true tomorrow is not news.
 *
 * A detector returning null is the normal case. On most days, for most
 * businesses, the agent should have nothing to interrupt anybody about.
 */

const DAY_MS = 86_400_000;

/** How many days of history the empty-day baseline reads. */
const EMPTY_DAY_BASELINE_DAYS = 28;

/**
 * A business must average this many appointments on a staffed day before an empty
 * one is remarkable. Below it, most days are empty and an alert would fire every
 * pass, which is how a new business's first week of using this becomes a week of
 * notifications telling it that it is new.
 */
const EMPTY_DAY_MIN_BASELINE = 2;

export interface AlertCandidate {
  type: AlertType;
  facts: AlertFacts;
}

/**
 * Which alerts are currently true for this business, most useful first.
 *
 * Ordered rather than scored: no-show behaviour is a bleeding wound, an empty day
 * is a dated opportunity, and a pile of lapsed customers has been true for weeks
 * and will keep. The caller sends at most one, so the order is the priority.
 */
export async function detectAlerts(
  businessId: string,
  timezone: string,
  now: Date,
): Promise<AlertCandidate[]> {
  const found = await Promise.all([
    noShowSpike(businessId, now),
    emptyDayAhead(businessId, timezone, now),
    lapsedPileup(businessId, timezone, now),
  ]);

  return found.filter((candidate): candidate is AlertCandidate => candidate !== null);
}

/**
 * Being stood up more than they usually are.
 *
 * The comparison is against the same business three months back, which is what
 * makes this meaningful across a salon that never gets stood up and a gym class
 * where a fifth of bookings evaporate. A business with no baseline yet is held to
 * the floor alone — and the floor is set where a reasonable owner would already
 * be worried, not where a statistician would.
 */
async function noShowSpike(businessId: string, now: Date): Promise<AlertCandidate | null> {
  const recent = await noShowWindow(businessId, now, NO_SHOW_WINDOW_DAYS);
  if (recent.reached < NO_SHOW_MIN_SAMPLE) return null;

  const rate = recent.noShows / recent.reached;

  const baseline = await noShowWindow(
    businessId,
    now,
    NO_SHOW_BASELINE_DAYS,
    // Skips the window being judged, so the recent fortnight is not part of the
    // history it is being compared against — otherwise a bad fortnight raises its
    // own baseline and partly hides itself.
    NO_SHOW_WINDOW_DAYS,
  );

  const threshold =
    baseline.reached >= NO_SHOW_MIN_SAMPLE
      ? Math.max(NO_SHOW_SPIKE_FLOOR, baseline.noShows / baseline.reached + NO_SHOW_SPIKE_MARGIN)
      : NO_SHOW_SPIKE_FLOOR;

  if (rate < threshold) return null;

  return {
    type: ALERT_TYPE.NO_SHOW_SPIKE,
    facts: {
      kind: BRIEFING_KIND.ALERT,
      alertType: ALERT_TYPE.NO_SHOW_SPIKE,
      value: recent.noShows,
      context: recent.reached,
      date: null,
    },
  };
}

/**
 * A staffed day, close enough to still fill, with nothing in it.
 *
 * The horizon starts at two days out rather than tomorrow: an alert about
 * tomorrow arrives too late to do anything with, and one about next month is not
 * yet a problem. Within that window the FIRST empty day is the one worth naming,
 * because it is the one with the least time left.
 */
async function emptyDayAhead(
  businessId: string,
  timezone: string,
  now: Date,
): Promise<AlertCandidate | null> {
  const typical = await typicalDay(businessId, timezone, now);
  if (typical < EMPTY_DAY_MIN_BASELINE) return null;

  for (let offset = EMPTY_DAY_HORIZON.min; offset <= EMPTY_DAY_HORIZON.max; offset++) {
    const date = toBusinessLocal(new Date(now.getTime() + offset * DAY_MS), timezone).toISODate();
    if (!date) continue;

    // Not staffed is a day off, not an empty day. Alerting on a Sunday the
    // business chooses to close is the single fastest way to lose an owner's
    // trust in everything else the agent says.
    if ((await rosterMinutes(businessId, date, timezone)) === 0) continue;
    if ((await countOnDate(businessId, date, timezone)) > 0) continue;

    return {
      type: ALERT_TYPE.EMPTY_DAY,
      facts: {
        kind: BRIEFING_KIND.ALERT,
        alertType: ALERT_TYPE.EMPTY_DAY,
        value: offset,
        context: Math.round(typical * 10) / 10,
        date,
      },
    };
  }

  return null;
}

/** Appointments per staffed day over the last four weeks — the business's own normal. */
async function typicalDay(businessId: string, timezone: string, now: Date): Promise<number> {
  let staffedDays = 0;
  let appointments = 0;

  for (let back = 1; back <= EMPTY_DAY_BASELINE_DAYS; back++) {
    const date = toBusinessLocal(new Date(now.getTime() - back * DAY_MS), timezone).toISODate();
    if (!date) continue;

    // Closed days are excluded from both halves of the average. Including them
    // would drag a six-day business's normal down by a seventh and make its
    // genuinely empty Tuesdays look ordinary.
    if ((await rosterMinutes(businessId, date, timezone)) === 0) continue;

    staffedDays += 1;
    appointments += await countOnDate(businessId, date, timezone);
  }

  return staffedDays === 0 ? 0 : appointments / staffedDays;
}

/**
 * Enough lapsed customers to be worth a broadcast — and no broadcast recently.
 *
 * `reachable`, not `matched`: the suggestion is "message these people", so the
 * number that justifies it has to be the number who can actually be messaged
 * after consent, the fortnight quiet period and a missing phone number have all
 * had their say (SPEC §6.5). Suggesting a broadcast to 40 people and landing the
 * owner on a screen that says 6 is worse than saying nothing.
 */
async function lapsedPileup(
  businessId: string,
  timezone: string,
  now: Date,
): Promise<AlertCandidate | null> {
  const recentlyBroadcast = await Campaign.countDocuments({
    businessId,
    createdAt: { $gte: new Date(now.getTime() - LAPSED_PILEUP_QUIET_DAYS * DAY_MS) },
  });
  if (recentlyBroadcast > 0) return null;

  const { preview } = await buildAudience(businessId, timezone, CAMPAIGN_AUDIENCE.LAPSED, now);
  if (preview.reachable < LAPSED_PILEUP_MIN) return null;

  return {
    type: ALERT_TYPE.LAPSED_PILEUP,
    facts: {
      kind: BRIEFING_KIND.ALERT,
      alertType: ALERT_TYPE.LAPSED_PILEUP,
      value: preview.reachable,
      context: preview.matched,
      date: null,
    },
  };
}

/**
 * Has this alert type fired for this business recently?
 *
 * A read rather than a Redis key, unlike Session Health's cooldown, because the
 * window here is a week: a cooldown that a container restart forgets is not a
 * cooldown, and the record that proves it already fired is already being written.
 */
export async function withinCooldown(
  businessId: string,
  type: AlertType,
  now: Date,
): Promise<boolean> {
  const since = new Date(now.getTime() - ALERT_COOLDOWN_DAYS * DAY_MS);
  const previous = await Briefing.countDocuments({
    businessId,
    alertType: type,
    scheduledFor: { $gte: since },
  });
  return previous > 0;
}
