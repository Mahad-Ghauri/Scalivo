import { DateTime } from 'luxon';
import { generate } from '../../lib/gemini.js';
import { logger } from '../../lib/logger.js';

/**
 * Free-text booking — milestone 3.2, and `docs/fsm-design.md` §9's one open item.
 *
 * "facial with ayesha sat afternoon" becomes a service, a staff member, a date and
 * a time window, and the customer lands three questions further down the menu than
 * they would have. The menu is not replaced: it is where this falls back to, every
 * time anything is missing or unclear, and it remains the confirmation backbone —
 * no appointment is ever written from a parse without a YES at CONFIRMING.
 *
 * ## The division of labour, which is the whole design
 *
 * The model gets exactly one job: **read the sentence.** It classifies — which of
 * these services did they mean, was that a day, was that a time of day — and it
 * answers in strings. It is told nothing it could compute wrongly and trusted with
 * nothing that could reach the database.
 *
 * Everything after that is local and deterministic:
 *
 * - **Names are matched against real rows.** A service or staff name the model
 *   invents matches nothing and resolves to null. This is the guard that matters:
 *   a hallucinated staff member must never become an appointment assigned to
 *   somebody who does not work here.
 * - **Dates are computed here, never by the model.** It returns "saturday"; luxon
 *   turns that into a date. Asking a model for date arithmetic is asking for last
 *   Saturday, and a booking on a date in the past is not a failure the customer
 *   can see or correct.
 * - **Times of day are a lookup, not a judgement.** "afternoon" means 12:00–17:00
 *   because the table below says so.
 *
 * The same principle as `agent/gemini.ts`'s figure check, applied to a different
 * risk: whatever is mechanically checkable gets mechanically checked, because "we
 * told it not to" has never been a safeguard.
 *
 * ## Ambiguity is never resolved by guessing
 *
 * "facial" at a salon offering three of them matches all three. That is not a
 * parse failure and it is not a licence to pick the first — it is a shorter menu,
 * and the customer answers a three-item list instead of a nine-item one. Only a
 * single match becomes a decision.
 */

/** A service or staff row, reduced to what matching needs. */
export interface NamedRow {
  id: string;
  name: string;
}

export interface StaffRow extends NamedRow {
  /** Which services they can actually perform. A preference we cannot honour is not one. */
  serviceIds: string[];
}

export interface Vocabulary {
  services: NamedRow[];
  staff: StaffRow[];
}

/**
 * What the model is allowed to say. Every field is a string or null, and every
 * one of them is checked against something else before it is used.
 */
export interface RawIntent {
  /** The customer's words for what they want. Matched against real services. */
  service: string | null;
  /** Their words for who. Matched against real staff. */
  staff: string | null;
  /** 'today', 'tomorrow', an English weekday, or 'YYYY-MM-DD'. Resolved here. */
  day: string | null;
  /** 'morning' | 'afternoon' | 'evening'. Looked up in WINDOWS. */
  window: string | null;
  /** 'HH:MM', 24-hour, only when they named a specific time. */
  at: string | null;
}

export interface ResolvedIntent {
  serviceId: string | null;
  /**
   * The services a partial name matched, when more than one did.
   *
   * Populated only in the ambiguous case, and only so the customer can be shown
   * the candidates rather than the full list. Empty when `serviceId` resolved.
   */
  serviceOptions: string[];
  staffId: string | null;
  /** Business-local calendar date, 'YYYY-MM-DD'. */
  date: string | null;
  /** The time of day they asked for, if any. */
  within: TimeWindow | null;
  /** A time the customer named exactly, in minutes from business-local midnight. */
  at: number | null;
}

/**
 * A time-of-day preference: the range to offer, and how to say it back.
 *
 * The label travels with the numbers rather than being re-derived, because the
 * same window has to be echoed in two messages written a turn apart — the "got it"
 * line and, if the range turns out to be empty, the line that widens it. Deriving
 * it twice from minutes would have to reverse-engineer "afternoon" out of 720, and
 * would get "from 3:00 pm" wrong.
 *
 * Phrased as a fragment that fits both sentences: "…, in the afternoon." and
 * "Nothing free in the afternoon — here's the rest of the day:".
 */
export interface TimeWindow {
  /** Minutes from business-local midnight, inclusive. */
  from: number;
  /** Minutes from business-local midnight, exclusive. */
  to: number;
  label: string;
}

/**
 * Times of day, as minutes from midnight.
 *
 * Deliberately generous at the edges: a customer who says "morning" and is offered
 * 11:45 has been served, and one who says "evening" at a salon that closes at 8
 * simply sees fewer options. Availability narrows these; they never widen it.
 */
const WINDOWS: Record<string, TimeWindow> = {
  morning: { from: 6 * 60, to: 12 * 60, label: 'in the morning' },
  afternoon: { from: 12 * 60, to: 17 * 60, label: 'in the afternoon' },
  evening: { from: 17 * 60, to: 23 * 60, label: 'in the evening' },
};

const END_OF_DAY = 24 * 60;

/**
 * Weekday words, including the abbreviations people actually type and the
 * Roman-Urdu the rest of this module's vocabulary already accepts (`isYes` takes
 * "haan", `isOpener` takes "salam").
 */
const WEEKDAYS: Record<string, number> = {
  monday: 1, mon: 1, pir: 1,
  tuesday: 2, tue: 2, tues: 2, mangal: 2,
  wednesday: 3, wed: 3, weds: 3, budh: 3,
  thursday: 4, thu: 4, thur: 4, thurs: 4, jumeraat: 4,
  friday: 5, fri: 5, juma: 5, jumma: 5,
  saturday: 6, sat: 6, hafta: 6,
  sunday: 7, sun: 7, itwar: 7,
};

/** A day word anywhere in the message is a reason to look closer. */
const DAY_WORDS = new RegExp(
  `\\b(today|tonight|tomorrow|tmrw|aaj|kal|weekend|next\\s+week|${Object.keys(WEEKDAYS).join('|')})\\b`,
  'i',
);

/** A time of day, a clock time, or either in Roman Urdu. */
const TIME_WORDS =
  /\b(morning|afternoon|evening|night|noon|midday|subah|dopahar|shaam|raat|\d{1,2}\s*[:.]\s*\d{2}|\d{1,2}\s*(am|pm|baje))\b/i;

/**
 * Long enough to say "laser with sana on friday", too short to be a paragraph.
 *
 * A message past this is not a booking request — it is a complaint, a forwarded
 * message or a paste — and the menu answers those better than a parse would.
 */
const FREE_TEXT_MAX = 300;

/** Below this a fragment is too generic to match a name on. */
const MIN_SUBSTRING = 3;
/** Below this a word is too generic to match a name's token on. */
const MIN_TOKEN = 4;

/**
 * A customer waits for this, unlike a briefing.
 *
 * Deliberately far below `agent/gemini.ts`'s 8 seconds: past about three seconds
 * of silence a WhatsApp reply reads as broken, and the menu — which needs no model
 * and arrives immediately — is a better answer than a correct one nobody waited
 * for. The fallback is good, so the deadline can be strict.
 */
const TIMEOUT_MS = 3_500;

const normalise = (text: string): string =>
  text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();

// ---------------------------------------------------------------------------
// The gate
// ---------------------------------------------------------------------------

/**
 * Is there anything here a parse could use?
 *
 * This exists to keep the model off the hot path. "hi" is the most common first
 * message there is and contains nothing to extract, so sending it to Gemini would
 * buy a second of latency and a quota call on every conversation that has ever
 * started, in exchange for the same service menu.
 *
 * It is a **presence test, not a parser** — it never extracts anything, it only
 * answers whether a day, a time or a name appears. A positive test rather than a
 * list of greetings to ignore, because the things worth parsing are a short
 * enumerable set and the things not worth parsing are everything else.
 */
export function hasBookingDetail(text: string, vocabulary: Vocabulary): boolean {
  if (!worthLooking(text)) return false;
  if (DAY_WORDS.test(text) || TIME_WORDS.test(text)) return true;

  return echoesAName(text, [...vocabulary.services, ...vocabulary.staff]);
}

/**
 * The half of the gate that needs nothing from the database.
 *
 * Separated so the caller can rule a message out before querying the business's
 * services and staff — which is most first messages, since "hi" is the commonest
 * opener there is. Both rejections here are certainties rather than judgements.
 */
export function worthLooking(text: string): boolean {
  const trimmed = text.trim();

  // A bare number is a customer answering a menu whose conversation timed out
  // (see isOpener). It carries no detail and the menu is exactly what they want.
  if (/^\d+$/.test(trimmed)) return false;

  return trimmed.length <= FREE_TEXT_MAX;
}

/** Does the message contain a word that looks like part of a service or staff name? */
function echoesAName(text: string, rows: NamedRow[]): boolean {
  const words = normalise(text)
    .split(' ')
    .filter((word) => word.length >= MIN_TOKEN);
  if (words.length === 0) return false;

  return rows.some((row) => {
    const name = normalise(row.name);
    // Either direction: "facial" is inside "hydrafacial", and "ayeshaa" contains
    // "ayesha". Both are someone naming a real thing imprecisely.
    return words.some((word) => name.includes(word) || word.includes(name));
  });
}

// ---------------------------------------------------------------------------
// The model
// ---------------------------------------------------------------------------

const INSTRUCTION = [
  'You read one WhatsApp message from a customer of a salon or gym in Pakistan and extract the booking details it contains.',
  '',
  'Reply with a JSON object and nothing else, exactly these five keys:',
  '{"service": null, "staff": null, "day": null, "window": null, "at": null}',
  '',
  'Rules, all of them absolute:',
  '- "service" must be copied EXACTLY from the Services list given below, or be null. Never a name that is not on that list.',
  '- "staff" must be copied EXACTLY from the Staff list, or be null. Never a name that is not on that list.',
  '- "day": one of "today", "tomorrow", an English weekday name, or a date as YYYY-MM-DD. Never calculate a date from a weekday — give the weekday name.',
  '- "window": exactly one of "morning", "afternoon", "evening", or null.',
  '- "at": a 24-hour clock time as HH:MM, and ONLY if the customer named a specific time. "afternoon" is a window, not a time.',
  '- Any detail the customer did not give is null. Do not fill a field to be helpful, and do not infer one field from another.',
  '- If you are unsure which list entry they meant, use null. A null is always better than a guess.',
  '- The message may be in English, Urdu or Roman Urdu.',
  '',
  'Reply with the JSON object only. No explanation, no markdown fences.',
].join('\n');

/**
 * Ask the model what the customer said. Null means "no idea" and is ordinary.
 *
 * The lists go in the message rather than the instruction because they differ per
 * business, and giving them at all is what lets "nails" reach "Gel Manicure".
 * It does not weaken the guard: whatever comes back is still matched against the
 * database, so the list is a hint to the model, not a grant of authority.
 *
 * Notably absent: today's date. The model is asked for a weekday and the date is
 * computed here, so there is nothing for it to be wrong about.
 */
export async function parseIntent(text: string, vocabulary: Vocabulary): Promise<RawIntent | null> {
  const reply = await generate({
    instruction: INSTRUCTION,
    input: [
      `Services: ${vocabulary.services.map((s) => s.name).join(', ')}`,
      `Staff: ${vocabulary.staff.map((s) => s.name).join(', ')}`,
      '',
      `Message: ${text.trim()}`,
    ].join('\n'),
    // Extraction, not writing. Any creativity here is a wrong answer.
    temperature: 0,
    maxOutputTokens: 200,
    timeoutMs: TIMEOUT_MS,
    purpose: 'booking-intent',
  });

  if (reply === null) return null;

  return readJson(reply);
}

/**
 * The model's reply, if it is the shape it was asked for.
 *
 * Fences get stripped because models add them even when told not to, and the
 * braces are located rather than assumed because a stray preamble is a formatting
 * slip, not a reason to send the customer to the menu. Anything else — bad JSON,
 * an array, a number where a string belongs — is rejected whole. A partially
 * understood intent is worse than none: it would act on half a sentence.
 */
function readJson(reply: string): RawIntent | null {
  const start = reply.indexOf('{');
  const end = reply.lastIndexOf('}');
  if (start === -1 || end <= start) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(reply.slice(start, end + 1));
  } catch {
    logger.warn({ reply }, 'gemini returned something that is not JSON — falling back to the menu');
    return null;
  }

  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null;

  const field = (key: keyof RawIntent): string | null => {
    const value = (parsed as Record<string, unknown>)[key];
    return typeof value === 'string' && value.trim() ? value.trim() : null;
  };

  return {
    service: field('service'),
    staff: field('staff'),
    day: field('day'),
    window: field('window'),
    at: field('at'),
  };
}

// ---------------------------------------------------------------------------
// Resolution — all local, all deterministic
// ---------------------------------------------------------------------------

/**
 * Turn the model's strings into ids and a date, discarding anything that does not
 * correspond to something real.
 *
 * Pure, and tested as such. The model can be absent, slow or wrong and this
 * function's behaviour is the same for a given input — which is what makes the
 * free-text path's decisions reviewable at all.
 */
export function resolveIntent(
  raw: RawIntent,
  context: Vocabulary & { timezone: string; now: Date },
): ResolvedIntent {
  const services = matchRows(raw.service, context.services);
  const serviceId = services.length === 1 ? (services[0] ?? null) : null;

  /**
   * A staff preference is only meaningful once the service is known, because the
   * same name may or may not be qualified for it. With no service resolved the
   * preference is dropped rather than carried: it would be applied to whatever the
   * customer picks from the menu next, which is not what they asked for.
   */
  const eligible = serviceId
    ? context.staff.filter((member) => member.serviceIds.includes(serviceId))
    : [];
  const staffMatches = serviceId ? matchRows(raw.staff, eligible) : [];
  const staffId = staffMatches.length === 1 ? (staffMatches[0] ?? null) : null;

  const at = parseClock(raw.at);
  const named = raw.window ? WINDOWS[raw.window.trim().toLowerCase()] : undefined;

  return {
    serviceId,
    // Ambiguity is only worth reporting when it can shorten a menu. One match is
    // a decision; no matches is nothing to show.
    serviceOptions: services.length > 1 ? services : [],
    staffId,
    date: resolveDay(raw.day, context.timezone, context.now),
    // A named window wins over a clock time when both somehow arrive: it is the
    // coarser claim, and showing a range beats implying we found their exact time.
    within: named ?? (at === null ? null : fromClock(at)),
    at,
  };
}

/** An exact time becomes an open-ended window: what is free from then on. */
const fromClock = (at: number): TimeWindow => ({
  from: at,
  to: END_OF_DAY,
  label: `from ${DateTime.fromObject({ hour: Math.floor(at / 60), minute: at % 60 }).toFormat('h:mm a')}`,
});

/**
 * Did the parse produce anything worth acting on?
 *
 * A bare day counts. "anything on saturday" resolves no service, so the customer
 * still sees the full menu — but the day they named survives on the conversation
 * and they are not asked for it again after picking. Half an answer is still one
 * question saved.
 */
export const isUseful = (resolved: ResolvedIntent): boolean =>
  resolved.serviceId !== null ||
  resolved.serviceOptions.length > 0 ||
  resolved.date !== null ||
  resolved.within !== null;

/**
 * Which rows a name might mean — all of them, so the caller can tell one from many.
 *
 * Three passes, widening: an exact name, then either string inside the other, then
 * a shared significant word. Stopping at the first pass that matches anything is
 * what keeps "Hydrafacial" from also returning "Deep Cleansing Facial" when the
 * customer typed the full name.
 */
function matchRows(needle: string | null, rows: NamedRow[]): string[] {
  if (!needle) return [];
  const want = normalise(needle);
  if (!want) return [];

  const exact = rows.filter((row) => normalise(row.name) === want);
  if (exact.length > 0) return exact.map((row) => row.id);

  if (want.length >= MIN_SUBSTRING) {
    const overlapping = rows.filter((row) => {
      const name = normalise(row.name);
      if (name.length < MIN_SUBSTRING) return false;
      return name.includes(want) || want.includes(name);
    });
    if (overlapping.length > 0) return overlapping.map((row) => row.id);
  }

  const words = new Set(want.split(' ').filter((word) => word.length >= MIN_TOKEN));
  if (words.size === 0) return [];

  return rows
    .filter((row) =>
      normalise(row.name)
        .split(' ')
        .some((token) => words.has(token)),
    )
    .map((row) => row.id);
}

/**
 * A day word into a business-local calendar date, or null.
 *
 * **Forward only.** "saturday" on a Sunday means the Saturday coming, never the one
 * gone — and a weekday that is today stays today, because someone saying "saturday"
 * on a Saturday morning means this afternoon. A date already past resolves to null
 * rather than to the nearest guess: we do not know which future date they meant,
 * and the date menu is the honest way to ask.
 *
 * No horizon check. A date too far out survives here and produces no availability,
 * which sends the customer back to the date menu through the path that already
 * exists for a day that filled up — the same reason nothing in the FSM treats a
 * hold as permission to write.
 */
function resolveDay(day: string | null, timezone: string, now: Date): string | null {
  if (!day) return null;

  const today = DateTime.fromJSDate(now, { zone: timezone }).startOf('day');
  const word = normalise(day);

  if (word === 'today' || word === 'tonight' || word === 'aaj') return today.toISODate();
  if (word === 'tomorrow' || word === 'tmrw' || word === 'kal') {
    return today.plus({ days: 1 }).toISODate();
  }

  const weekday = WEEKDAYS[word];
  if (weekday !== undefined) {
    const ahead = (weekday - today.weekday + 7) % 7;
    return today.plus({ days: ahead }).toISODate();
  }

  if (/^\d{4}-\d{2}-\d{2}$/.test(word.replace(/ /g, '-'))) {
    const date = DateTime.fromISO(word.replace(/ /g, '-'), { zone: timezone });
    if (!date.isValid || date.startOf('day') < today) return null;
    return date.toISODate();
  }

  return null;
}

/** 'HH:MM' into minutes from midnight, or null if it is not one. */
function parseClock(at: string | null): number | null {
  if (!at) return null;

  const match = /^(\d{1,2})[:.](\d{2})$/.exec(at.trim());
  if (!match) return null;

  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (hours > 23 || minutes > 59) return null;

  return hours * 60 + minutes;
}

/** Minutes from business-local midnight, for filtering a slot list against a window. */
export function localMinutes(instant: Date, timezone: string): number {
  const local = DateTime.fromJSDate(instant, { zone: timezone });
  return local.hour * 60 + local.minute;
}
