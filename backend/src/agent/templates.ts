import {
  ALERT_TYPE,
  BRIEFING_KIND,
  LAPSED_PILEUP_QUIET_DAYS,
  NO_SHOW_WINDOW_DAYS,
  type AlertFacts,
  type BriefingAction,
  type BriefingFacts,
  type DailyFacts,
  type WeeklyFacts,
} from '@scalivo/shared';
import { formatLocal } from '../lib/time.js';
import { formatPrice } from '../whatsapp/messages.js';

/**
 * The briefings in plain words — SPEC §11.3's fallback, and the baseline the LLM
 * is only ever allowed to improve on.
 *
 * Calling this a "fallback" undersells what it is. This file is the briefing.
 * Everything the owner needs to know is here, correct, in full sentences, with no
 * network call and no API key — which is why an LLM outage costs nothing, and why
 * the agent can be demonstrated on a laptop with no credentials at all.
 *
 * Three rules hold throughout:
 *
 * - **No number appears that was not computed.** The prose is assembled from
 *   `facts` and nothing else, so there is nothing here that can be wrong in a way
 *   the data is not.
 * - **Unknown is said, not rounded to zero.** A business with no history has no
 *   comparison, and "the same as last week" would be a lie about a week that does
 *   not exist.
 * - **Nothing is congratulated or scolded.** The numbers carry their own news.
 *   An agent that calls a quiet week "disappointing" is a system telling a
 *   business owner how to feel about their own livelihood.
 */

export interface Phrasing {
  headline: string;
  body: string;
  actions: BriefingAction[];
}

export function template(facts: BriefingFacts, businessName: string, timezone: string): Phrasing {
  if (facts.kind === BRIEFING_KIND.DAILY) return daily(facts, timezone);
  if (facts.kind === BRIEFING_KIND.WEEKLY) return weekly(facts);
  return alert(facts, businessName);
}

function daily(facts: DailyFacts, timezone: string): Phrasing {
  const { appointments, expectedRevenueMinor, firstStartsAt, lastEndsAt } = facts;

  if (appointments === 0) {
    return {
      headline: 'Nothing booked today',
      body:
        facts.openHours > 0
          ? `Your diary is empty today, with ${hours(facts.openHours)} of staffed time going spare. ` +
            'A good day to message customers who have not been in for a while.'
          : 'Your diary is empty today, and nobody is rostered on.',
      actions: facts.openHours > 0 ? [WIN_BACK] : [],
    };
  }

  const lines: string[] = [];

  lines.push(
    `${count(appointments, 'appointment')} today, worth ${formatPrice(expectedRevenueMinor)}.`,
  );

  if (firstStartsAt && lastEndsAt) {
    lines.push(
      `First at ${formatLocal(new Date(firstStartsAt), timezone, 'h:mm a')}, ` +
        `last finishes ${formatLocal(new Date(lastEndsAt), timezone, 'h:mm a')}.`,
    );
  }

  if (facts.firstTimers > 0) {
    lines.push(
      `${count(facts.firstTimers, 'first-time customer')} — worth greeting by name.`,
    );
  }

  if (facts.unconfirmed > 0) {
    lines.push(`${count(facts.unconfirmed, 'booking')} not confirmed yet.`);
  }

  if (facts.openHours > 0) {
    lines.push(`${hours(facts.openHours)} still free.`);
  }

  return {
    headline: `${appointments} today · ${formatPrice(expectedRevenueMinor)}`,
    body: lines.join(' '),
    actions: [TODAY, ...(facts.unconfirmed > 0 ? [APPOINTMENTS] : [])],
  };
}

function weekly(facts: WeeklyFacts): Phrasing {
  const lines: string[] = [];

  lines.push(
    `Last week: ${count(facts.completed, 'appointment')} completed, ` +
      `${formatPrice(facts.revenueMinor)} earned.`,
  );

  lines.push(comparison(facts.revenueMinor, facts.previousRevenueMinor));

  if (facts.topServiceName) {
    lines.push(
      `${facts.topServiceName} brought in the most at ${formatPrice(facts.topServiceRevenueMinor)}.`,
    );
  }

  if (facts.noShows > 0) {
    lines.push(`${count(facts.noShows, 'no-show')}.`);
  }

  if (facts.bookedAhead > 0) {
    lines.push(
      `${count(facts.bookedAhead, 'appointment')} already on the books, ` +
        `worth ${formatPrice(facts.bookedAheadRevenueMinor)}.`,
    );
  } else {
    lines.push('Nothing booked ahead yet.');
  }

  if (facts.dueToReturn > 0) {
    lines.push(`${count(facts.dueToReturn, 'customer')} overdue for a visit.`);
  }

  return {
    headline: `Last week: ${formatPrice(facts.revenueMinor)}`,
    body: lines.join(' '),
    actions: [ANALYTICS, ...(facts.dueToReturn > 0 ? [WIN_BACK_AT_RISK] : [])],
  };
}

/**
 * Revenue against the week before.
 *
 * "No comparison" is a real answer and it is given as one. The alternative — a
 * percentage against a week with no revenue in it — is either a division by zero
 * or an infinite improvement, and both are worse than a sentence saying there is
 * nothing to compare against.
 */
function comparison(nowMinor: number, beforeMinor: number): string {
  if (beforeMinor === 0) {
    return nowMinor === 0
      ? 'The week before was empty too, so there is nothing to compare.'
      : 'The week before that had no completed appointments, so there is nothing to compare.';
  }

  const change = Math.round(((nowMinor - beforeMinor) / beforeMinor) * 100);
  if (change === 0) return 'Level with the week before.';
  return change > 0
    ? `Up ${change}% on the week before.`
    : `Down ${Math.abs(change)}% on the week before.`;
}

function alert(facts: AlertFacts, businessName: string): Phrasing {
  if (facts.alertType === ALERT_TYPE.NO_SHOW_SPIKE) {
    const percent = Math.round((facts.value / facts.context) * 100);
    return {
      headline: `${facts.value} no-shows in ${NO_SHOW_WINDOW_DAYS} days`,
      body:
        `${facts.value} of the last ${facts.context} appointments were no-shows — ${percent}%, ` +
        'higher than usual here. Asking for a deposit on the services it keeps ' +
        'happening to is the lever that exists for this.',
      actions: [SERVICES, ANALYTICS],
    };
  }

  if (facts.alertType === ALERT_TYPE.EMPTY_DAY) {
    return {
      headline: 'An empty day coming up',
      body:
        `Nothing is booked for ${facts.date}, which is ${count(facts.value, 'day')} away, ` +
        `and you are staffed for it. A normal day here has about ${facts.context}. ` +
        'There is still time to fill it.',
      actions: [WIN_BACK, CALENDAR(facts.date)],
    };
  }

  return {
    headline: `${facts.value} customers you could win back`,
    body:
      `${facts.value} of your ${facts.context} lapsed customers can be messaged right now, ` +
      `and nothing has gone out from ${businessName} in ${LAPSED_PILEUP_QUIET_DAYS} days. ` +
      'A short message is the cheapest booking you will get this week.',
    actions: [WIN_BACK],
  };
}

/**
 * Where an alert sends the owner.
 *
 * Links into the dashboard, never actions. The broadcast link lands on the
 * composer, which makes the owner type the recipient count before it will send
 * anything — that gate is the reason a suggestion can be this direct.
 */
const WIN_BACK: BriefingAction = {
  label: 'Message lapsed customers',
  href: '/grow/broadcast?audience=lapsed',
};

const WIN_BACK_AT_RISK: BriefingAction = {
  label: 'Message customers slipping away',
  href: '/grow/broadcast?audience=at_risk',
};

const TODAY: BriefingAction = { label: "Today's diary", href: '/calendar' };
const APPOINTMENTS: BriefingAction = { label: 'Unconfirmed bookings', href: '/appointments' };
const ANALYTICS: BriefingAction = { label: 'See the numbers', href: '/analytics' };
const SERVICES: BriefingAction = { label: 'Require a deposit', href: '/services' };
const CALENDAR = (date: string | null): BriefingAction => ({
  label: 'Open that day',
  href: date ? `/calendar?date=${date}&view=day` : '/calendar',
});

/** "1 appointment", "3 appointments" — the plural nobody notices until it is wrong. */
function count(value: number, noun: string): string {
  return `${value} ${noun}${value === 1 ? '' : 's'}`;
}

/** Hours with the half hours kept: "3.5 hours", "1 hour". */
function hours(value: number): string {
  const rounded = Math.round(value * 10) / 10;
  return `${rounded} ${rounded === 1 ? 'hour' : 'hours'}`;
}
