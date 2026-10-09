import type { Redis } from 'ioredis';
import {
  ANY_STAFF,
  BOOKING_STATUS,
  DEPOSIT_STATUS,
  FLOW_OPENER,
  REVIEW_COMMENT_MIN_LENGTH,
} from '@scalivo/shared';
import { Booking } from '../../models/Booking.js';
import { Business } from '../../models/Business.js';
import { Service } from '../../models/Service.js';
import { Staff } from '../../models/Staff.js';
import { daysWithAvailability, getAvailability, loadContext, slotsFor } from '../../bookings/availability.js';
import { holdKeys, releaseHold } from '../../bookings/holds.js';
import { cancelBooking, createBooking, holdSlot } from '../../bookings/create.js';
import { attachComment, recordRating } from '../../reviews/record.js';
import { transferDeposit } from '../../payments/deposits.js';
import { logger } from '../../lib/logger.js';
import { handleGlobalCommand } from '../interceptors/global-commands.js';
import * as copy from '../messages.js';
import { CONVERSATION_STATE, type Conversation, MAX_INVALID_INPUT } from './states.js';
import {
  hasBookingDetail,
  isUseful,
  localMinutes,
  parseIntent,
  resolveIntent,
  requestedTime,
  type ResolvedIntent,
  type Vocabulary,
  worthLooking,
} from './intent.js';

/**
 * The booking conversation. docs/fsm-design.md §4 is the specification; this is
 * that table, executed.
 *
 * Two properties the whole thing is built around:
 *
 * 1. **The numbered list is data, not a re-derivation.** Every prompt stores the
 *    ids it printed in `conversation.options`, and the customer's "2" indexes
 *    into that stored list. Re-querying on their reply would silently re-map the
 *    options whenever a slot got taken between the two messages — the customer
 *    would book something they never saw.
 *
 * 2. **Nothing here is the booking guard.** A hold is advisory, and the customer
 *    may sit in CONFIRMING long after it expired. createBooking's transaction
 *    decides, every time, and losing that race is an ordinary outcome handled
 *    with a re-offer rather than an error.
 */

export interface TurnContext {
  businessId: string;
  businessName: string;
  timezone: string;
  clientId: string;
  /** For the returning-customer greeting. Null for an unmatched contact. */
  firstName: string | null;
  /** Trimmed message body. */
  text: string;
  /** null means IDLE — the absence of a conversation, not a stored state. */
  conversation: Conversation | null;
  now?: Date;
}

export interface TurnResult {
  replies: string[];
  /** null clears the conversation — back to IDLE. */
  conversation: Conversation | null;
  /**
   * A booking was just made and still needs confirming.
   *
   * The machine deliberately does not send the confirmation itself: it has no
   * provider, and the confirmation is a tracked, retried, ack-followed message
   * rather than a line of chat. See the note in commit().
   */
  confirms?: string;
  notifyOwner?: boolean;
}

/** Index into the list the customer is actually looking at. */
function pickOption(text: string, options: string[] | undefined): string | null {
  if (!options?.length) return null;
  const words = ['first', 'second', 'third', 'fourth', 'fifth'];
  const ordinal = /^(?:the )?(first|second|third|fourth|fifth)(?: (?:one|appointment|option|slot))?[.!]?$/i.exec(text.trim());
  const n = ordinal ? words.indexOf(ordinal[1]!.toLowerCase()) + 1 : Number(text.trim());
  if (!Number.isInteger(n) || n < 1 || n > options.length) return null;
  return options[n - 1] ?? null;
}

function isYes(text: string): boolean {
  return /^(yes|y|yeah|ok|okay|haan|han)(?:[, ]+(?:please|pls))?[.!]?$/i.test(text.trim());
}

function isNo(text: string): boolean {
  return /^(no|n|nope|nahi)(?:[, ]+(?:thanks|thank you|please))?[.!]?$/i.test(text.trim());
}

/**
 * Does an opening message read like someone starting a conversation?
 *
 * Deliberately generous — a greeting or booking word anywhere in the message is
 * enough — because a miss costs only the welcome line: everything else still
 * gets the menu, just after an apology instead of a "Welcome back".
 *
 * A bare number counts: it is a customer answering a menu whose conversation
 * timed out, which is someone clearly trying to book, not gibberish.
 */
function isOpener(text: string): boolean {
  return (
    /^\s*\d+\s*$/.test(text) ||
    /\b(h+i+|he+y+|hel+o+|hy|salaa?m|slam|as+ala+m\w*|aoa|book\w*|appointments?|menu|services?|prices?|rates?)\b/i.test(text) ||
    /سلام/.test(text)
  );
}

/**
 * Re-prompt, or hand over to a human.
 *
 * The counter resets on every valid input, so this counts consecutive
 * confusion, not lifetime mistakes — a customer who fumbles once early and once
 * late is not escalated.
 */
function invalid(ctx: TurnContext, conversation: Conversation, prompt: string): TurnResult {
  const invalidCount = conversation.invalidCount + 1;

  if (invalidCount >= MAX_INVALID_INPUT) {
    return {
      replies: [copy.tooManyInvalid(ctx.businessName)],
      conversation: { ...conversation, state: CONVERSATION_STATE.HELP, invalidCount },
    };
  }

  return {
    replies: [copy.invalidInput, prompt],
    conversation: { ...conversation, invalidCount },
  };
}

// ---------------------------------------------------------------------------
// Prompt builders. Each one queries, then stores exactly what it printed.
// ---------------------------------------------------------------------------

/**
 * The service list. `only` narrows it to a parse's candidates.
 *
 * Narrowing is what a half-understood sentence is worth: "facial" at a salon with
 * three of them cannot become a decision, but it can become a three-item list
 * instead of a nine-item one. An empty `only` means no narrowing at all — the
 * ordinary menu — rather than an empty menu.
 */
async function promptService(
  ctx: TurnContext,
  base: Partial<Conversation>,
  only: string[] = [],
): Promise<TurnResult> {
  const services = await Service.find({
    businessId: ctx.businessId,
    active: true,
    ...(only.length > 0 ? { _id: { $in: only } } : {}),
  }).sort({ displayOrder: 1 });

  // No services at all is a business that is not set up; a narrowing that matches
  // nothing is a stale id, and both are better answered by the full list than by
  // silence. Only the unnarrowed emptiness is a dead end.
  if (services.length === 0) {
    if (only.length > 0) return promptService(ctx, base);
    return { replies: [copy.helpRequested], conversation: null };
  }

  return {
    replies: [copy.serviceMenu(services)],
    conversation: {
      ...base,
      state: CONVERSATION_STATE.SELECTING_SERVICE,
      options: services.map((s) => String(s._id)),
      invalidCount: 0,
    },
  };
}

async function promptStaffOrDate(
  redis: Redis,
  ctx: TurnContext,
  base: Conversation,
): Promise<TurnResult> {
  // Already named, by a sentence rather than a menu pick. Asking again would undo
  // the only thing the parse was for.
  if (base.staffId) return promptDate(redis, ctx, base);

  const staff = await Staff.find({
    businessId: ctx.businessId,
    active: true,
    serviceIds: base.serviceId,
  });

  // One staff member is not a choice, it is a fact — asking would be noise, so
  // the customer is never shown a menu of one.
  if (staff.length <= 1) {
    return promptDate(redis, ctx, {
      ...base,
      ...(staff[0] ? { staffId: String(staff[0]._id) } : {}),
    });
  }

  return {
    replies: [copy.staffMenu(staff.map((s) => s.name))],
    conversation: {
      ...base,
      state: CONVERSATION_STATE.SELECTING_STAFF,
      // The trailing ANY_STAFF is the "No preference" row the menu prints last.
      options: [...staff.map((s) => String(s._id)), ANY_STAFF],
      invalidCount: 0,
    },
  };
}

async function promptDate(redis: Redis, ctx: TurnContext, base: Conversation): Promise<TurnResult> {
  // The day is already settled — from a sentence, since no menu path arrives here
  // with one. Skipping straight to times is the point of having parsed it.
  //
  // This is also what breaks the mutual recursion with promptSlot: the "this day
  // filled up" fallback below clears `date` before coming back here, so a full day
  // asks again instead of bouncing.
  if (base.date) return promptSlot(redis, ctx, base);

  const days = await daysWithAvailability(redis, ctx.businessId, base.serviceId!, {
    ...(base.staffId ? { staffId: base.staffId } : {}),
  });

  if (days.length === 0) {
    const service = await Service.findById(base.serviceId);
    return {
      replies: [copy.nothingAvailable(service?.name ?? 'that service')],
      conversation: null,
    };
  }

  return {
    replies: [copy.dateMenu(days.map((d) => d.date), ctx.timezone)],
    conversation: {
      ...base,
      state: CONVERSATION_STATE.SELECTING_DATE,
      options: days.map((d) => d.date),
      invalidCount: 0,
    },
  };
}

/** Abandon only this conversation's hold, never a hold acquired by someone else. */
async function discardConfirmation(redis: Redis, ctx: TurnContext): Promise<Conversation | null> {
  const previous = ctx.conversation;
  if (!previous) return null;
  if (previous.holdToken && previous.heldStaffId && previous.slotStart && previous.serviceId) {
    const context = await loadContext(ctx.businessId, previous.serviceId);
    if (context) await releaseHold(redis, {
      token: previous.holdToken,
      staffId: previous.heldStaffId,
      keys: holdKeys(ctx.businessId, previous.heldStaffId, slotsFor(new Date(previous.slotStart), context)),
      expiresAt: new Date(),
    });
  }
  const fresh = { ...previous };
  delete fresh.slotStart;
  delete fresh.holdToken;
  delete fresh.heldStaffId;
  delete fresh.requestedAt;
  delete fresh.ambiguousAt;
  delete fresh.options;
  if (fresh.state === CONVERSATION_STATE.CONFIRMING) fresh.state = CONVERSATION_STATE.SELECTING_SLOT;
  return fresh;
}

async function promptSlot(
  redis: Redis,
  ctx: TurnContext,
  base: Conversation,
  lead?: string,
): Promise<TurnResult> {
  const slots = await getAvailability(redis, {
    businessId: ctx.businessId,
    serviceId: base.serviceId!,
    date: base.date!,
    ...(ctx.now ? { now: ctx.now } : {}),
    ...(base.staffId ? { staffId: base.staffId } : {}),
  });

  if (base.ambiguousAt !== undefined) {
    const am = base.ambiguousAt;
    const candidates = slots.filter((slot) => {
      const minutes = localMinutes(slot.startsAt, ctx.timezone);
      return minutes === am || minutes === am + 12 * 60;
    });
    const fresh = { ...base };
    delete fresh.ambiguousAt;
    delete fresh.within;
    if (candidates.length) return {
      replies: [copy.ambiguousTimeOptions(candidates.map((slot) => slot.startsAt), ctx.timezone)],
      conversation: { ...fresh, state: CONVERSATION_STATE.SELECTING_SLOT,
        options: candidates.map((slot) => slot.startsAt.toISOString()), invalidCount: 0 },
    };
    const alternative = await promptSlot(redis, ctx, fresh, copy.neitherTimeAvailable);
    if (!alternative.replies.includes(copy.neitherTimeAvailable)) alternative.replies.unshift(copy.neitherTimeAvailable);
    return alternative;
  }

  if (base.requestedAt !== undefined) {
    const exact = slots.find((slot) => localMinutes(slot.startsAt, ctx.timezone) === base.requestedAt);
    const fresh = { ...base };
    delete fresh.requestedAt;
    delete fresh.within;
    if (exact) return promptConfirm(redis, ctx, fresh, exact.startsAt);
    const alternative = await promptSlot(redis, ctx, fresh, copy.requestedTimeUnavailable);
    if (!alternative.replies.includes(copy.requestedTimeUnavailable)) {
      alternative.replies.unshift(copy.requestedTimeUnavailable);
    }
    return alternative;
  }

  // The day filled between being offered and being chosen. Never present an
  // empty list as a choice — go back to the days that do have room.
  //
  // The chosen day is dropped on the way, because it is no longer a choice they
  // have: keeping it would send promptDate straight back here.
  if (slots.length === 0) {
    const fresh: Conversation = { ...base };
    delete fresh.date;
    delete fresh.within;
    return promptDate(redis, ctx, fresh);
  }

  // A time of day they asked for in words, applied to what is actually free.
  const within = base.within;
  const offered = within
    ? slots.filter((s) => {
        const minutes = localMinutes(s.startsAt, ctx.timezone);
        return minutes >= within.from && minutes < within.to;
      })
    : slots;

  /**
   * Their window is empty, but the day is not. Widen to the whole day and say so.
   *
   * The filter is dropped rather than kept, so nothing later in the conversation —
   * a NO at the confirmation, a slot taken from under them — goes on promising a
   * window the customer has already been told is empty. Recursing once is safe
   * precisely because `within` is gone on the way in.
   */
  if (within && offered.length === 0) {
    const widened: Conversation = { ...base };
    delete widened.within;
    return promptSlot(redis, ctx, widened, copy.nothingInWindow(within.label));
  }

  return {
    replies: [...(lead ? [lead] : []), copy.slotMenu(offered.map((s) => s.startsAt), ctx.timezone)],
    conversation: {
      ...base,
      state: CONVERSATION_STATE.SELECTING_SLOT,
      options: offered.slice(0, copy.MAX_SLOT_OPTIONS).map((s) => s.startsAt.toISOString()),
      invalidCount: 0,
    },
  };
}

async function promptConfirm(
  redis: Redis,
  ctx: TurnContext,
  base: Conversation,
  slotStart: Date,
): Promise<TurnResult> {
  const held = await holdSlot(redis, {
    businessId: ctx.businessId,
    serviceId: base.serviceId!,
    startsAt: slotStart,
    ...(base.staffId ? { staffId: base.staffId } : { staffId: ANY_STAFF }),
    source: 'whatsapp',
    ...(ctx.now ? { now: ctx.now } : {}),
  });

  // Somebody else took it while this customer was reading. Ordinary traffic.
  if (!held.ok) return promptSlot(redis, ctx, base, copy.slotTaken);

  const [service, staff] = await Promise.all([
    Service.findById(base.serviceId),
    Staff.findById(held.hold.staffId),
  ]);

  return {
    replies: [
      copy.confirmation({
        serviceName: service?.name ?? 'your appointment',
        staffName: staff?.name ?? 'our team',
        startsAt: slotStart,
        timezone: ctx.timezone,
        priceMinor: service?.priceMinor ?? 0,
      }),
    ],
    conversation: {
      ...base,
      state: CONVERSATION_STATE.CONFIRMING,
      slotStart: slotStart.toISOString(),
      holdToken: held.hold.token,
      heldStaffId: held.hold.staffId,
      invalidCount: 0,
    },
  };
}

/**
 * The only transition that writes. Everything before it is a conversation;
 * this is the booking.
 */
async function commit(redis: Redis, ctx: TurnContext, base: Conversation): Promise<TurnResult> {
  const startsAt = new Date(base.slotStart!);

  // A reschedule keeps the original booking's deposit terms: a paid deposit
  // moves across, and a booking that never had one is not asked for one now —
  // see rescheduledDeposit in bookings/create.ts.
  const previous = base.bookingId
    ? await Booking.findOne({ _id: base.bookingId, businessId: ctx.businessId }).select('depositStatus')
    : null;
  const depositAlreadyPaid = previous?.depositStatus === DEPOSIT_STATUS.PAID;
  const rescheduledDeposit = base.bookingId ? (depositAlreadyPaid ? 'carry' : 'waive') : undefined;

  const attempt = (holdToken: string) =>
    createBooking(redis, {
      businessId: ctx.businessId,
      staffId: base.heldStaffId!,
      clientId: ctx.clientId,
      serviceId: base.serviceId!,
      startsAt,
      source: 'whatsapp',
      holdToken,
      ...(rescheduledDeposit ? { rescheduledDeposit } : {}),
      ...(ctx.now ? { now: ctx.now } : {}),
    });

  let result = await attempt(base.holdToken!);

  /**
   * The TTLs deliberately disagree: a hold lasts 5 minutes, a conversation 30.
   * So a customer CAN sit in CONFIRMING past their hold and then reply YES —
   * fsm-design.md §3 calls this out as expected, not exceptional.
   *
   * Refusing them there would make the hold load-bearing, which is exactly what
   * it is not. The hold is advisory; the occupancy transaction is the arbiter.
   * If the slot is genuinely still free, take a fresh hold and carry on. Only if
   * someone else now holds or owns it has the customer actually lost anything.
   */
  if (!result.ok && result.reason === 'hold_expired') {
    const rehold = await holdSlot(redis, {
      businessId: ctx.businessId,
      serviceId: base.serviceId!,
      startsAt,
      staffId: base.heldStaffId!,
      source: 'whatsapp',
      ...(ctx.now ? { now: ctx.now } : {}),
    });

    if (rehold.ok) result = await attempt(rehold.hold.token);
  }

  if (!result.ok) {
    // Whatever the internal reason, it means one thing to a customer: the time
    // is gone. Re-offer rather than explaining our locking model.
    logger.info(
      { businessId: ctx.businessId, clientId: ctx.clientId, reason: result.reason },
      'whatsapp booking did not commit',
    );
    return promptSlot(redis, ctx, base, copy.slotTaken);
  }

  // Rescheduling is cancel-then-book, in that order deliberately: booking first
  // would need the old slot free, and freeing it first would risk losing it to
  // someone else. Cancelling after a CONFIRMED new booking is the safe half.
  if (base.bookingId) {
    // Transfer BEFORE cancelling: the cancellation then finds no paid deposit
    // to settle, and the money is on the booking the customer will attend.
    if (depositAlreadyPaid) await transferDeposit(base.bookingId, result.booking.id);
    await cancelBooking(base.bookingId, ctx.businessId, 'customer');
  }

  /**
   * The "you're booked" message is NOT a reply.
   *
   * It looks like one — it answers YES, it arrives next in the same chat — but
   * it is the confirmation, and a confirmation has to outlive this turn: it has
   * to be recorded, it has to survive the session being down, and whether it
   * ever actually reached the customer has to be answerable a month later. A
   * reply is none of those things; it is worthless an hour later and costs
   * nothing to lose.
   *
   * So the machine reports the booking and stops. The router sends the
   * confirmation through the tracked path, which is also what marks the booking
   * CONFIRMED — see notifications/confirm.ts for why that is one step.
   */
  return {
    replies: [],
    confirms: result.booking.id,
    // The conversation is over. The next message starts a fresh one rather than
    // resuming a booking that already happened.
    conversation: null,
  };
}

// ---------------------------------------------------------------------------
// Free text — milestone 3.2
// ---------------------------------------------------------------------------

/**
 * Try to read a sentence, and if it says anything, start further down the menu.
 *
 * Null means "the menu, as before" and is the answer for most messages: no model
 * configured, nothing in the text worth parsing, a parse that resolved nothing, a
 * timeout. Every one of those falls through to the same place, which is why the
 * feature can be switched on for a tenant without a flag — a business with no
 * Gemini key simply never leaves the menu path.
 */
async function fromFreeText(redis: Redis, ctx: TurnContext): Promise<TurnResult | null> {
  // The free half of the gate first, so a bare number or a pasted essay costs no
  // queries at all.
  if (!worthLooking(ctx.text)) return null;

  const [services, staff] = await Promise.all([
    Service.find({ businessId: ctx.businessId, active: true }).sort({ displayOrder: 1 }).limit(100).maxTimeMS(5000),
    Staff.find({ businessId: ctx.businessId, active: true }).limit(100).maxTimeMS(5000),
  ]);

  const vocabulary: Vocabulary = {
    services: services.map((s) => ({ id: String(s._id), name: s.name })),
    staff: staff.map((s) => ({ id: String(s._id), name: s.name, serviceIds: s.serviceIds })),
  };

  const clock = requestedTime(ctx.text);
  if (clock.kind === 'invalid' || (clock.kind === 'ambiguous' && clock.minutes === undefined)) {
    return { replies: [copy.clarifyTime], conversation: await discardConfirmation(redis, ctx) };
  }
  // A new clock request invalidates earlier consent even if model classification fails.
  if (clock.kind === 'exact' || clock.kind === 'ambiguous') {
    ctx = { ...ctx, conversation: await discardConfirmation(redis, ctx) };
  }
  const timeReply = (clock.kind === 'exact' || clock.kind === 'ambiguous') &&
    /^(?:(?:book(?: me)? (?:at )?|at ))?\d{1,2}(?:\s*[:.;]\s*\d{2})?\s*(?:am|pm)?(?:\s+(?:please|works|works for me))?[.!]?$/i.test(ctx.text.trim());
  const detail = hasBookingDetail(ctx.text, vocabulary);
  const greeting = !detail &&
    /^(hi|hey|hello|salam|assalam o alaikum|aoa)[!.\s]*$/i.test(ctx.text.trim());
  const availability = !detail &&
    /\b(available|availability|free|other|another|different|alternative|more)\b/i.test(ctx.text) &&
    /\b(times?|slots?|appointments?)\b/i.test(ctx.text);
  const raw = greeting
    ? { service: null, staff: null, day: null, window: null, at: null, action: 'greeting' as const }
    : availability
      ? { service: null, staff: null, day: null, window: null, at: null, action: 'availability' as const }
      : timeReply
        ? { action: 'booking' as const, service: null, staff: null, day: null, window: null, at: null }
        : await parseIntent(ctx.text, vocabulary, ctx.conversation) ??
        (clock.kind === 'ambiguous' ? { action: 'booking' as const, service: null, staff: null, day: null, window: null, at: null } : null);
  if (!raw) {
    if (clock.kind === 'exact') {
      return { replies: [copy.bookingRequestNotUnderstood], conversation: await discardConfirmation(redis, ctx) };
    }
    return null;
  }
  // A model-provided time is never authority: use only the clock in the user's message.
  raw.at = clock.kind === 'exact'
    ? `${Math.floor(clock.minutes / 60).toString().padStart(2, '0')}:${(clock.minutes % 60).toString().padStart(2, '0')}`
    : null;
  if (clock.kind === 'ambiguous') raw.window = null;

  const previous = ctx.conversation;
  const selectedService = vocabulary.services.find((service) => service.id === previous?.serviceId);
  const answer = (text: string): TurnResult => ({ replies: [text.slice(0, 3500)], conversation: previous ? { ...previous, invalidCount: 0 } : null });
  if (raw.action === 'cancel' || raw.action === 'reschedule' || raw.action === 'help') {
    const command = await handleGlobalCommand({ ...ctx, text: raw.action.toUpperCase() });
    return command ?? answer(copy.nothingToMove);
  }
  if (raw.action === 'off_topic') return answer(copy.bookingHelp);
  if (raw.action === 'location') {
    const business = await Business.findOne({ _id: ctx.businessId }).select('city profile.addressLine profile.neighbourhood').maxTimeMS(5000);
    return answer(copy.location([business?.profile?.addressLine, business?.profile?.neighbourhood, business?.city]
      .filter((part): part is string => typeof part === 'string' && Boolean(part.trim()))));
  }
  if (raw.action === 'greeting') {
    if (previous && previous.state !== CONVERSATION_STATE.HELP) return answer(copy.greeting(ctx.businessName, ctx.firstName) + '\n\n' + copy.bookingHelp);
    const asked = await promptService(ctx, {});
    return { ...asked, replies: [copy.greeting(ctx.businessName, ctx.firstName), ...asked.replies] };
  }
  if (raw.action === 'appointments') {
    const bookings = await upcomingBookings(ctx.businessId, ctx.clientId);
    if (!bookings.length) return answer(copy.noAppointments);
    const catalog = await Service.find({ businessId: ctx.businessId,
      _id: { $in: bookings.map((booking) => booking.serviceId) } }).limit(100).maxTimeMS(5000);
    return answer(copy.appointmentList(bookings.map((booking) => ({
      serviceName: catalog.find((service) => String(service._id) === booking.serviceId)?.name ?? 'Appointment',
      startsAt: booking.startsAt,
    })), ctx.timezone));
  }
  if (raw.action === 'services' || raw.action === 'price' || raw.action === 'duration') {
    const requested = raw.service ? resolveIntent(raw, { ...vocabulary, timezone: ctx.timezone, now: ctx.now ?? new Date() }) : null;
    if (requested && !requested.serviceId && !requested.serviceOptions.length) {
      return answer('That service is not listed.\n\n' + copy.serviceDetails(services));
    }
    const ids = requested ? [requested.serviceId, ...requested.serviceOptions] : [previous?.serviceId];
    const chosen = raw.action === 'services' || !ids.some(Boolean) ? services : services.filter((service) => ids.includes(String(service._id)));
    return answer(copy.serviceDetails(chosen));
  }
  if (raw.action === 'staff' || raw.action === 'hours') {
    const requested = raw.service ? resolveIntent(raw, { ...vocabulary, timezone: ctx.timezone, now: ctx.now ?? new Date() }).serviceId : previous?.serviceId;
    const eligible = requested ? staff.filter((member) => member.serviceIds.includes(requested)) : staff;
    return answer(raw.action === 'staff' ? copy.staffDetails(eligible.map((member) => member.name))
      : copy.workingHours(eligible.map((member) => ({ name: member.name, hours: member.workingHours }))));
  }
  const resolved = resolveIntent({ ...raw, service: raw.service ?? selectedService?.name ?? null }, {
    ...vocabulary,
    timezone: ctx.timezone,
    now: ctx.now ?? new Date(),
  });
  const question = raw.action === 'availability' || raw.action === 'booking' || raw.action === 'no_preference';
  if (clock.kind === 'ambiguous' && clock.minutes !== undefined) resolved.ambiguousAt = clock.minutes;
  if (!question && clock.kind !== 'ambiguous' && (!isUseful(resolved) || !(
    (raw.service && (resolved.serviceId || resolved.serviceOptions.length)) ||
    (raw.staff && resolved.staffId) || (raw.day && resolved.date) ||
    ((raw.window || raw.at) && resolved.within)
  ))) return null;

  // Carry earlier answers only when this message did not replace them. Never
  // retain a staff choice that cannot perform the newly selected service.
  if (!raw.staff && previous?.staffId && vocabulary.staff.some((member) =>
    member.id === previous.staffId && member.serviceIds.includes(resolved.serviceId ?? ''),
  )) resolved.staffId = previous.staffId;
  if (!raw.day && previous?.date) resolved.date = previous.date;
  if (!raw.window && !raw.at && previous?.within) resolved.within = previous.within;

  ctx = { ...ctx, conversation: await discardConfirmation(redis, ctx) };
  if (!raw.window && clock.kind === 'absent' && previous?.requestedAt !== undefined) {
    resolved.at = previous.requestedAt;
  }
  if (!raw.window && clock.kind === 'absent' && previous?.ambiguousAt !== undefined) {
    resolved.ambiguousAt = previous.ambiguousAt;
  }

  if (raw.action === 'availability' || raw.action === 'no_preference') {
    const base: Omit<Conversation, 'state'> = {
      ...(resolved.serviceId ? { serviceId: resolved.serviceId } : {}),
      ...(resolved.date ? { date: resolved.date } : {}),
      ...(resolved.at !== null ? { requestedAt: resolved.at } : {}),
      ...(resolved.ambiguousAt !== undefined ? { ambiguousAt: resolved.ambiguousAt } : {}),
      ...(raw.action !== 'no_preference' && resolved.staffId ? { staffId: resolved.staffId } : {}),
      ...((raw.window || raw.at) && resolved.within ? { within: resolved.within } : {}),
      ...(previous?.bookingId ? { bookingId: previous.bookingId } : {}),
      opener: previous?.opener ?? FLOW_OPENER.FREE_TEXT,
      invalidCount: 0,
    };
    if (!resolved.serviceId) {
      const asked = await promptService(ctx, base, resolved.serviceOptions);
      return { ...asked, replies: [copy.availabilityNeedsService, ...asked.replies] };
    }
    if (raw.action === 'availability') delete base.requestedAt;
    return promptDate(redis, ctx, { ...base, state: CONVERSATION_STATE.SELECTING_DATE });
  }

  return resumeFromIntent(redis, ctx, resolved, vocabulary);
}

/**
 * Enter the menu at the first thing the sentence did not settle.
 *
 * There is no separate free-text state machine — the parse fills in
 * `Conversation` fields and the ordinary prompt builders take it from there, each
 * one skipping the question it already has an answer to. That is what keeps
 * `docs/fsm-design.md` §9's promise that the menu stays the fallback and the
 * confirmation backbone: every path below ends in CONFIRMING, and **no appointment
 * is written without a YES**, whatever the model decided.
 *
 * ## Two things it deliberately will not do
 *
 * **It will not choose a staff member on the customer's silence.** A sentence that
 * names nobody at a business with several qualified staff still gets the staff
 * question. Skipping it would save a message and create a trap: the confirmation
 * names whoever was assigned, and a NO there returns to the time list, so there
 * would be no route to a different person short of starting over.
 *
 * **It will not book an exact time it was not given.** The jump straight to the
 * confirmation happens only when the customer named a clock time, that time is
 * genuinely free, and there was no staff question outstanding.
 *
 * Exported for the tests. In production it is reached only through `advance`, which
 * is the only thing that decides whether a parse happened at all — the tests hand it
 * a resolved intent directly so the ladder can be checked without a model.
 */
export async function resumeFromIntent(
  redis: Redis,
  ctx: TurnContext,
  resolved: ResolvedIntent,
  vocabulary: Vocabulary,
): Promise<TurnResult> {
  /**
   * How this flow began — which a parse partway through must not rewrite.
   *
   * A customer who was shown the numbered list and then typed a sentence entered
   * through the menu, and recording them as a free-text flow would move a menu
   * failure into free text's column. Entry is the thing being compared.
   */
  const opener = ctx.conversation
    ? (ctx.conversation.opener ?? FLOW_OPENER.MENU)
    : FLOW_OPENER.FREE_TEXT;

  // Everything a conversation is except the state, which each prompt builder sets
  // to whatever question it is about to ask.
  const base: Omit<Conversation, 'state'> = {
    ...(ctx.conversation?.bookingId ? { bookingId: ctx.conversation.bookingId } : {}),
    ...(resolved.serviceId ? { serviceId: resolved.serviceId } : {}),
    ...(resolved.staffId ? { staffId: resolved.staffId } : {}),
    ...(resolved.date ? { date: resolved.date } : {}),
    ...(resolved.within ? { within: resolved.within } : {}),
    ...(resolved.at !== null ? { requestedAt: resolved.at } : {}),
    ...(resolved.ambiguousAt !== undefined ? { ambiguousAt: resolved.ambiguousAt } : {}),
    opener,
    invalidCount: 0,
  };

  const lead = copy.understood({
    serviceName: resolved.serviceId
      ? (vocabulary.services.find((s) => s.id === resolved.serviceId)?.name ?? null)
      : null,
    staffName: resolved.staffId
      ? (vocabulary.staff.find((s) => s.id === resolved.staffId)?.name ?? null)
      : null,
    date: resolved.date,
    windowLabel: resolved.within?.label ?? null,
    timezone: ctx.timezone,
  });

  const result = await run();
  return { ...result, replies: [lead, ...result.replies] };

  async function run(): Promise<TurnResult> {
    // No single service. The day and the window still survive on the conversation,
    // so whatever they pick from the (possibly narrowed) list goes straight to times.
    if (!resolved.serviceId) return promptService(ctx, base, resolved.serviceOptions);

    const settled: Conversation = { ...base, state: CONVERSATION_STATE.SELECTING_SERVICE };

    const noPreference = ctx.conversation?.serviceId === resolved.serviceId &&
      !ctx.conversation.staffId &&
      (ctx.conversation.state === CONVERSATION_STATE.SELECTING_DATE ||
        ctx.conversation.state === CONVERSATION_STATE.SELECTING_SLOT ||
        ctx.conversation.state === CONVERSATION_STATE.CONFIRMING);

    return noPreference ? promptDate(redis, ctx, settled) : promptStaffOrDate(redis, ctx, settled);
  }
}

// ---------------------------------------------------------------------------

/** One inbound message, one turn. The interceptor chain has already run. */
export async function advance(redis: Redis, ctx: TurnContext): Promise<TurnResult> {
  const conversation = ctx.conversation;
  if (conversation && conversation.state !== CONVERSATION_STATE.AWAITING_RATING &&
    conversation.state !== CONVERSATION_STATE.AWAITING_REVIEW_COMMENT &&
    !pickOption(ctx.text, conversation.options) && !isYes(ctx.text) && !isNo(ctx.text)) {
    const parsed = await fromFreeText(redis, ctx);
    if (parsed) return parsed;
  }

  // IDLE — the absence of a key, not a stored state.
  if (!conversation) {
    // A first message is where a sentence is most likely to carry detail, and the
    // only place the customer has not already been given a numbered list to answer.
    const parsed = await fromFreeText(redis, ctx);
    if (parsed) return parsed;

    const opening = await promptService(ctx, {});
    const lead = isOpener(ctx.text) ? copy.greeting(ctx.businessName, ctx.firstName) : copy.notUnderstood;
    return {
      replies: [lead, ...opening.replies],
      conversation: opening.conversation,
    };
  }

  switch (conversation.state) {
    case CONVERSATION_STATE.SELECTING_SERVICE: {
      const serviceId = pickOption(ctx.text, conversation.options);
      if (!serviceId) {
        /**
         * The number was not a number. Before apologising, read it as a sentence.
         *
         * A customer looking at the menu who types "hydrafacial tomorrow at 3" has
         * given more than the list asked for, and answering that with "reply with
         * one of the numbers above" is the interface being obtuse. This is also the
         * single likeliest place to earn an escalation back: three of these in a row
         * is how a flow ends up in HELP.
         *
         * Strictly after pickOption, so a bare "2" is always the menu pick it looks
         * like and never goes near the model.
         */
        const services = await Service.find({ businessId: ctx.businessId, active: true }).sort({ displayOrder: 1 });
        return invalid(ctx, conversation, copy.serviceMenu(services));
      }
      return promptStaffOrDate(redis, ctx, { ...conversation, serviceId, invalidCount: 0 });
    }

    case CONVERSATION_STATE.SELECTING_STAFF: {
      const picked = pickOption(ctx.text, conversation.options);
      if (!picked) {
        const staff = await Staff.find({
          businessId: ctx.businessId,
          active: true,
          serviceIds: conversation.serviceId,
        });
        return invalid(ctx, conversation, copy.staffMenu(staff.map((s) => s.name)));
      }

      // ANY_STAFF is stored as the ABSENCE of staffId. Carrying the sentinel
      // into availability would filter for a staff member literally named "any".
      const next: Conversation = { ...conversation, invalidCount: 0 };
      if (picked === ANY_STAFF) delete next.staffId;
      else next.staffId = picked;

      return promptDate(redis, ctx, next);
    }

    case CONVERSATION_STATE.SELECTING_DATE: {
      const date = pickOption(ctx.text, conversation.options);
      if (!date) {
        return invalid(ctx, conversation, copy.dateMenu(conversation.options ?? [], ctx.timezone));
      }
      return promptSlot(redis, ctx, { ...conversation, date, invalidCount: 0 });
    }

    case CONVERSATION_STATE.SELECTING_SLOT: {
      const iso = pickOption(ctx.text, conversation.options);
      if (!iso) {
        return invalid(
          ctx,
          conversation,
          copy.slotMenu((conversation.options ?? []).map((s) => new Date(s)), ctx.timezone),
        );
      }
      return promptConfirm(redis, ctx, { ...conversation, invalidCount: 0 }, new Date(iso));
    }

    case CONVERSATION_STATE.CONFIRMING: {
      if (isYes(ctx.text)) return commit(redis, ctx, conversation);
      if (isNo(ctx.text)) {
        const fresh = await discardConfirmation(redis, ctx);
        return promptSlot(redis, ctx, { ...fresh!, invalidCount: 0 });
      }
      return invalid(
        ctx,
        conversation,
        'Reply YES to confirm or NO to pick another time.',
      );
    }

    case CONVERSATION_STATE.SELECTING_BOOKING: {
      const bookingId = pickOption(ctx.text, conversation.options);
      if (!bookingId) {
        return invalid(ctx, conversation, 'Reply with the number of the appointment.');
      }

      // Re-read under the businessId filter rather than trusting the stored id:
      // the booking may have been cancelled by the owner since the menu printed.
      const booking = await Booking.findOne({ _id: bookingId, businessId: ctx.businessId });
      if (!booking) return { replies: [copy.nothingToCancel], conversation: null };

      if (conversation.intent === 'cancel') {
        const service = await Service.findById(booking.serviceId);
        return {
          replies: [
            copy.cancelPrompt({
              serviceName: service?.name ?? 'your appointment',
              startsAt: booking.startsAt,
              timezone: ctx.timezone,
            }),
          ],
          conversation: {
            state: CONVERSATION_STATE.CANCELLING,
            bookingId: String(booking._id),
            invalidCount: 0,
          },
        };
      }

      // Reschedule: the service carries over, only the time changes. Keeping
      // bookingId is what tells commit() to release the old slot once the new
      // booking exists.
      return promptDate(redis, ctx, {
        state: CONVERSATION_STATE.SELECTING_DATE,
        serviceId: booking.serviceId,
        bookingId: String(booking._id),
        invalidCount: 0,
      });
    }

    case CONVERSATION_STATE.CANCELLING: {
      if (isNo(ctx.text)) return { replies: [copy.cancelKept], conversation: null };
      if (!isYes(ctx.text)) {
        return invalid(ctx, conversation, 'Reply YES to cancel or NO to keep it.');
      }

      // The customer's own cancellation: a paid deposit comes back only with
      // enough notice (payments/settle.ts).
      await cancelBooking(conversation.bookingId!, ctx.businessId, 'customer');
      return offerRebook(ctx, conversation.bookingId!);
    }

    case CONVERSATION_STATE.OFFERING_REBOOK: {
      const answer = ctx.text.trim();
      if (answer === '2' || isNo(answer)) return { replies: [copy.rebookDeclined], conversation: null };
      if (answer !== '1' && !isYes(answer)) {
        return invalid(ctx, conversation, 'Reply 1 to book another day, or 2 if not.');
      }

      return promptDate(redis, ctx, {
        state: CONVERSATION_STATE.SELECTING_DATE,
        serviceId: conversation.serviceId!,
        ...(conversation.staffId ? { staffId: conversation.staffId } : {}),
        invalidCount: 0,
      });
    }

    case CONVERSATION_STATE.AWAITING_RATING: {
      const rating = Number(ctx.text.trim());
      if (!Number.isInteger(rating) || rating < 1 || rating > 5) {
        return invalid(ctx, conversation, 'Reply with a number from 1 to 5.');
      }

      const recorded = await recordRating({
        businessId: ctx.businessId,
        clientId: ctx.clientId,
        bookingId: conversation.bookingId!,
        rating,
      });

      /**
       * No completed appointment behind the prompt.
       *
       * Reachable if the owner un-completes a booking, or deletes it, between
       * the request going out and the reply arriving. The customer answered a
       * question in good faith, so they get the thank-you either way — the only
       * thing lost is a review that would have had nothing to attach to.
       */
      if (!recorded.ok) {
        logger.warn(
          { businessId: ctx.businessId, bookingId: conversation.bookingId, rating },
          'rating for a booking that is no longer completed',
        );
        return { replies: [copy.ratingThanks], conversation: null };
      }

      /**
       * Only the published half is asked for a comment, and only the first
       * time. SPEC §9.1 attaches the written note to the public review; asking
       * an unhappy customer to write one would be inviting the public complaint
       * the private path exists to pre-empt.
       */
      if (recorded.published && !recorded.alreadyRated) {
        return {
          replies: [copy.reviewCommentPrompt],
          conversation: {
            ...conversation,
            state: CONVERSATION_STATE.AWAITING_REVIEW_COMMENT,
            invalidCount: 0,
          },
        };
      }

      return {
        replies: [recorded.published ? copy.ratingThanks : copy.ratingNoted],
        conversation: null,
      };
    }

    case CONVERSATION_STATE.AWAITING_REVIEW_COMMENT: {
      const comment = ctx.text.trim();

      /**
       * Two ways to say nothing, and neither is invalid input.
       *
       * SKIP is offered in the prompt, and the no-words are accepted because
       * someone who means no types "no". The length rule catches the case that
       * actually bites: a customer who replies `hi` here wants to book again,
       * and taking them literally publishes "hi" on the business's profile.
       */
      if (comment.length < REVIEW_COMMENT_MIN_LENGTH || /^(skip|no|nope|nahi|-)$/i.test(comment)) {
        return { replies: [copy.ratingThanks], conversation: null };
      }

      await attachComment(ctx.businessId, conversation.bookingId!, comment);
      return { replies: [copy.reviewPublished], conversation: null };
    }

    // HELP is terminal — the owner has been notified, and answering further
    // would talk over the human who is about to. GREETING is transient and
    // never persisted. AWAITING_DEPOSIT is never stored either: a deposit is
    // waited on by the BOOKING's status, not the conversation's, because the
    // answer arrives from the payment gateway rather than from the chat. The
    // conversation ends with the payment link, and the next message starts a
    // fresh one. A stale one read back is dropped rather than stranding them.
    case CONVERSATION_STATE.HELP:
    case CONVERSATION_STATE.GREETING:
    case CONVERSATION_STATE.AWAITING_DEPOSIT:
    case CONVERSATION_STATE.RESCHEDULING:
      return { replies: [], conversation: null };
  }
}

/**
 * "Cancelled" plus an offer to book the same thing on another day.
 *
 * The staff member carries over only while they can still take it — an offer
 * naming someone who has since left would end in "nothing available". If the
 * service itself is gone there is nothing to offer, so the cancel ends there.
 */
async function offerRebook(ctx: TurnContext, bookingId: string): Promise<TurnResult> {
  const booking = await Booking.findOne({ _id: bookingId, businessId: ctx.businessId });
  const service = booking
    ? await Service.findOne({ _id: booking.serviceId, businessId: ctx.businessId, active: true })
    : null;
  if (!booking || !service) return { replies: [copy.cancelled], conversation: null };

  const staff = await Staff.findOne({
    _id: booking.staffId,
    businessId: ctx.businessId,
    active: true,
    serviceIds: booking.serviceId,
  });

  return {
    replies: [copy.cancelled, copy.rebookOffer({ serviceName: service.name, staffName: staff?.name ?? null })],
    conversation: {
      state: CONVERSATION_STATE.OFFERING_REBOOK,
      serviceId: String(service._id),
      ...(staff ? { staffId: String(staff._id) } : {}),
      invalidCount: 0,
    },
  };
}

/** Build the CANCELLING / RESCHEDULING prompt from the customer's real bookings. */
export async function upcomingBookings(businessId: string, clientId: string) {
  return Booking.find({
    businessId,
    clientId,
    startsAt: { $gt: new Date() },
    status: { $in: [BOOKING_STATUS.PENDING, BOOKING_STATUS.CONFIRMED] },
  }).sort({ startsAt: 1 }).limit(20).maxTimeMS(5000);
}
