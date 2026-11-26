import { isUsableName } from '../../lib/name.js';
import type { Redis } from 'ioredis';
import { ANY_STAFF, BOOKING_STATUS, FLOW_OPENER, REVIEW_COMMENT_MIN_LENGTH } from '@scalivo/shared';
import { Booking } from '../../models/Booking.js';
import { AppointmentHolder } from '../../models/AppointmentHolder.js';
import { saveHolder } from '../../crm/holders.js';
import { ConfigurationConflict } from '../../bookings/configuration.js';
import { Client } from '../../models/Client.js';
import { Business } from '../../models/Business.js';
import { Service } from '../../models/Service.js';
import { Staff } from '../../models/Staff.js';
import {
  createSequence,
  getSequenceAvailability,
  daysWithSequenceAvailability,
  type SequenceStep,
} from '../../bookings/sequence.js';
import {
  daysWithAvailability,
  getAvailability,
  loadContext,
  slotsFor,
} from '../../bookings/availability.js';
import { holdKeys, releaseHold, heldPlan } from '../../bookings/holds.js';
import { declineFollowUp } from '../../followups/job.js';
import { toBusinessLocal } from '../../lib/time.js';
import { cancelBooking, createBooking, holdSlot } from '../../bookings/create.js';
import { attachComment, recordRating } from '../../reviews/record.js';
import { rescheduleReservation } from '../../calendar/reschedule.js';
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
  confirmsSequence?: import('@scalivo/shared').Booking[];
  notifyOwner?: boolean;
}

/** Index into the list the customer is actually looking at. */
function pickOption(text: string, options: string[] | undefined): string | null {
  if (!options?.length) return null;
  const words = ['first', 'second', 'third', 'fourth', 'fifth'];
  const ordinal =
    /^(?:the )?(first|second|third|fourth|fifth)(?: (?:one|appointment|option|slot))?[.!]?$/i.exec(
      text.trim(),
    );
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
    /\b(h+i+|he+y+|hel+o+|hy|salaa?m|slam|as+ala+m\w*|aoa|book\w*|appointments?|menu|services?|prices?|rates?)\b/i.test(
      text,
    ) ||
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
    replies: [
      copy.serviceMenu(services) +
        '\n\nBooking for someone else? Send APPOINTMENT FOR followed by their name.',
    ],
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
  })
    .limit(100)
    .maxTimeMS(5000);

  // One staff member is not a choice, it is a fact — asking would be noise, so
  // the customer is never shown a menu of one.
  if (staff.length <= 1) {
    return promptDate(redis, ctx, {
      ...base,
      ...(staff[0] ? { staffId: String(staff[0]._id) } : {}),
    });
  }

  return {
    replies: [
      base.additionalServices?.length
        ? `Who would you like for the first treatment?\n\n${staff.map((member, index) => `${index + 1}. ${member.name}`).join('\n')}\n\nReply with their name or number.`
        : copy.staffMenu(staff.map((s) => s.name)),
    ],
    conversation: {
      ...base,
      state: CONVERSATION_STATE.SELECTING_STAFF,
      // The trailing ANY_STAFF is the "No preference" row the menu prints last.
      options: [
        ...staff.map((s) => String(s._id)),
        ...(base.additionalServices?.length ? [] : [ANY_STAFF]),
      ],
      invalidCount: 0,
    },
  };
}

async function promptDate(redis: Redis, ctx: TurnContext, base: Conversation): Promise<TurnResult> {
  const index = base.additionalServices?.findIndex((step) => !step.staffId) ?? -1;
  if (index !== -1) {
    const step = base.additionalServices![index]!;
    const [service, members] = await Promise.all([
      Service.findOne({ _id: step.serviceId, businessId: ctx.businessId, active: true })
        .select('name')
        .lean()
        .maxTimeMS(5000),
      Staff.find({ businessId: ctx.businessId, active: true, serviceIds: step.serviceId })
        .select('name')
        .lean()
        .limit(100)
        .maxTimeMS(5000),
    ]);
    if (!service || !members.length)
      return {
        replies: [
          'One of these treatments has no available professional. Contact the business or request a different treatment.',
        ],
        conversation: null,
      };
    if (members.length === 1) {
      const additionalServices = base.additionalServices!.map((item, i) =>
        i === index ? { ...item, staffId: String(members[0]!._id) } : item,
      );
      return promptDate(redis, ctx, { ...base, additionalServices });
    }
    return {
      replies: [
        `Who would you prefer for ${service.name}?\n\n${members.map((member, i) => `${i + 1}. ${member.name}`).join('\n')}\n\nYou can reply with a name or number.`,
      ],
      conversation: {
        ...base,
        state: CONVERSATION_STATE.SELECTING_SEQUENCE_STAFF,
        sequenceStaffIndex: index,
        options: members.map((member) => String(member._id)),
        invalidCount: 0,
      },
    };
  }
  // The day is already settled — from a sentence, since no menu path arrives here
  // with one. Skipping straight to times is the point of having parsed it.
  //
  // This is also what breaks the mutual recursion with promptSlot: the "this day
  // filled up" fallback below clears `date` before coming back here, so a full day
  // asks again instead of bouncing.
  if (base.date) return promptSlot(redis, ctx, base);

  const days = base.additionalServices?.length
    ? (
        await daysWithSequenceAvailability(redis, {
          businessId: ctx.businessId,
          steps: [
            { serviceId: base.serviceId!, staffId: base.staffId! },
            ...(base.additionalServices as SequenceStep[]),
          ],
          source: 'whatsapp',
          ...(ctx.now ? { now: ctx.now } : {}),
        })
      ).map((date) => ({ date }))
    : await daysWithAvailability(redis, ctx.businessId, base.serviceId!, {
        ...(base.staffId ? { staffId: base.staffId } : {}),
      });

  if (days.length === 0) {
    const service = await Service.findById(base.serviceId);
    return {
      replies: [
        base.additionalServices?.length
          ? 'No full visit is available in the next two weeks. Ask for a specific later date or contact the business to arrange these treatments.'
          : copy.nothingAvailable(service?.name ?? 'that service'),
      ],
      conversation: base.additionalServices?.length
        ? { ...base, state: CONVERSATION_STATE.SELECTING_DATE, options: [], invalidCount: 0 }
        : null,
    };
  }

  return {
    replies: [
      copy.dateMenu(
        days.map((d) => d.date),
        ctx.timezone,
      ),
    ],
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
    const plan = await heldPlan(redis, previous.holdToken);
    if (context)
      await releaseHold(redis, {
        token: previous.holdToken,
        staffId: previous.heldStaffId,
        keys:
          plan?.businessId === ctx.businessId
            ? plan.keys
            : holdKeys(
                ctx.businessId,
                previous.heldStaffId,
                slotsFor(new Date(previous.slotStart), context),
              ),
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
  if (fresh.state === CONVERSATION_STATE.CONFIRMING)
    fresh.state = CONVERSATION_STATE.SELECTING_SLOT;
  return fresh;
}

async function promptSlot(
  redis: Redis,
  ctx: TurnContext,
  base: Conversation,
  lead?: string,
): Promise<TurnResult> {
  const slots = base.additionalServices?.length
    ? await getSequenceAvailability(redis, {
        businessId: ctx.businessId,
        steps: [
          { serviceId: base.serviceId!, staffId: base.staffId! },
          ...(base.additionalServices as SequenceStep[]),
        ],
        date: base.date!,
        source: 'whatsapp',
        ...(ctx.now ? { now: ctx.now } : {}),
      })
    : await getAvailability(redis, {
        businessId: ctx.businessId,
        serviceId: base.serviceId!,
        date: base.date!,
        ...(ctx.now ? { now: ctx.now } : {}),
        ...(base.staffId ? { staffId: base.staffId } : {}),
        ...(base.bookingId ? { ignoreBookingId: base.bookingId } : {}),
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
    if (candidates.length)
      return {
        replies: [
          copy.ambiguousTimeOptions(
            candidates.map((slot) => slot.startsAt),
            ctx.timezone,
          ),
        ],
        conversation: {
          ...fresh,
          state: CONVERSATION_STATE.SELECTING_SLOT,
          options: candidates.map((slot) => slot.startsAt.toISOString()),
          invalidCount: 0,
        },
      };
    const alternative = await promptSlot(redis, ctx, fresh, copy.neitherTimeAvailable);
    if (!alternative.replies.includes(copy.neitherTimeAvailable))
      alternative.replies.unshift(copy.neitherTimeAvailable);
    return alternative;
  }

  if (base.requestedAt !== undefined) {
    const exact = slots.find(
      (slot) => localMinutes(slot.startsAt, ctx.timezone) === base.requestedAt,
    );
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
    replies: [
      ...(lead ? [lead] : []),
      copy.slotMenu(
        offered.map((s) => s.startsAt),
        ctx.timezone,
      ),
    ],
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
  if (base.additionalServices?.length) {
    const steps: SequenceStep[] = [
      { serviceId: base.serviceId!, staffId: base.staffId! },
      ...(base.additionalServices as SequenceStep[]),
    ];
    const offers = await getSequenceAvailability(redis, {
      businessId: ctx.businessId,
      steps,
      date: base.date!,
      source: 'whatsapp',
      ...(ctx.now ? { now: ctx.now } : {}),
    });
    const offer = offers.find((candidate) => candidate.startsAt.getTime() === slotStart.getTime());
    if (!offer) return promptSlot(redis, ctx, base, copy.slotTaken);
    const [services, staff] = await Promise.all([
      Service.find({
        businessId: ctx.businessId,
        _id: { $in: steps.map((step) => step.serviceId) },
      })
        .select('name priceMinor')
        .lean()
        .limit(5)
        .maxTimeMS(5000),
      Staff.find({ businessId: ctx.businessId, _id: { $in: steps.map((step) => step.staffId) } })
        .select('name')
        .lean()
        .limit(5)
        .maxTimeMS(5000),
    ]);
    const summary = offer.appointments
      .map((appointment) => {
        const service = services.find((item) => String(item._id) === appointment.serviceId);
        const member = staff.find((item) => String(item._id) === appointment.staffId);
        const time = new Intl.DateTimeFormat('en-GB', {
          timeZone: ctx.timezone,
          day: 'numeric',
          month: 'short',
          hour: 'numeric',
          minute: '2-digit',
        }).format(new Date(appointment.startsAt));
        return `${service?.name ?? 'Treatment'} with ${member?.name ?? 'our team'} — ${time}`;
      })
      .join('\n');
    return {
      replies: [
        `Please confirm your consecutive treatments:\n\n${summary}\n\nCleanup gaps are included. Availability is checked again when you confirm; either the whole visit is saved or none is. Services requiring approval stay unconfirmed until accepted.\n\nReply YES to confirm or NO to choose another time.`,
      ],
      conversation: {
        ...base,
        state: CONVERSATION_STATE.CONFIRMING,
        slotStart: slotStart.toISOString(),
        heldStaffId: base.staffId!,
        invalidCount: 0,
      },
    };
  }
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
  const client = await Client.findById(ctx.clientId).select('displayName').lean().maxTimeMS(5000);
  if (
    !base.appointmentHolderId &&
    (!client?.displayName?.trim() || !isUsableName(client.displayName))
  ) {
    return {
      replies: [
        'What name should I put on the appointment? Please send the name of the person receiving the treatment.',
      ],
      conversation: { ...base, state: CONVERSATION_STATE.AWAITING_NAME, invalidCount: 0 },
    };
  }
  const startsAt = new Date(base.slotStart!);

  if (base.additionalServices?.length) {
    const result = await createSequence(redis, {
      businessId: ctx.businessId,
      clientId: ctx.clientId,
      startsAt,
      source: 'whatsapp',
      steps: [
        { serviceId: base.serviceId!, staffId: base.staffId! },
        ...(base.additionalServices as SequenceStep[]),
      ],
      ...(base.appointmentHolderId ? { appointmentHolderId: base.appointmentHolderId } : {}),
      ...(ctx.now ? { now: ctx.now } : {}),
    });
    if (!result.ok) return promptSlot(redis, ctx, base, copy.slotTaken);
    return {
      replies: [],
      conversation: null,
      confirms: result.bookings[0]!.id,
      confirmsSequence: result.bookings,
    };
  }
  if (base.bookingId) {
    const moved = await rescheduleReservation(redis, {
      businessId: ctx.businessId,
      bookingId: base.bookingId,
      clientId: ctx.clientId,
      startsAt,
      staffId: base.heldStaffId!,
      ignoreHoldToken: base.holdToken!,
      ...(ctx.now ? { now: ctx.now } : {}),
    });
    await discardConfirmation(redis, { ...ctx, conversation: base });
    if (!moved.ok) return promptSlot(redis, ctx, base, copy.slotTaken);
    return {
      replies: [
        'Your appointment has been moved to the time you selected. Reply MY APPOINTMENTS to see your updated booking.',
      ],
      conversation: null,
    };
  }
  const attempt = (holdToken: string) =>
    createBooking(redis, {
      businessId: ctx.businessId,
      staffId: base.heldStaffId!,
      clientId: ctx.clientId,
      serviceId: base.serviceId!,
      startsAt,
      source: 'whatsapp',
      holdToken,
      ...(base.appointmentHolderId ? { appointmentHolderId: base.appointmentHolderId } : {}),
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
    Service.find({ businessId: ctx.businessId, active: true })
      .sort({ displayOrder: 1 })
      .limit(100)
      .maxTimeMS(5000),
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
  const timeReply =
    (clock.kind === 'exact' || clock.kind === 'ambiguous') &&
    /^(?:(?:book(?: me)? (?:at )?|at ))?\d{1,2}(?:\s*[:.;]\s*\d{2})?\s*(?:am|pm)?(?:\s+(?:please|works|works for me))?[.!]?$/i.test(
      ctx.text.trim(),
    );
  const detail = hasBookingDetail(ctx.text, vocabulary);
  const greeting =
    !detail && /^(hi|hey|hello|salam|assalam o alaikum|aoa)[!.\s]*$/i.test(ctx.text.trim());
  const availability =
    !detail &&
    /\b(available|availability|free|other|another|different|alternative|more)\b/i.test(ctx.text) &&
    /\b(times?|slots?|appointments?)\b/i.test(ctx.text);
  let raw = greeting
    ? { service: null, staff: null, day: null, window: null, at: null, action: 'greeting' as const }
    : availability
      ? {
          service: null,
          staff: null,
          day: null,
          window: null,
          at: null,
          action: 'availability' as const,
        }
      : timeReply
        ? {
            action: 'booking' as const,
            service: null,
            staff: null,
            day: null,
            window: null,
            at: null,
          }
        : ((await parseIntent(ctx.text, vocabulary, ctx.conversation)) ??
          (clock.kind === 'ambiguous'
            ? {
                action: 'booking' as const,
                service: null,
                staff: null,
                day: null,
                window: null,
                at: null,
              }
            : null));
  const text = ctx.text.toLocaleLowerCase();
  const named = services
    .map((service) => ({ service, at: text.indexOf(service.name.toLocaleLowerCase()) }))
    .filter((item) => item.at >= 0)
    .sort((a, b) => a.at - b.at);
  const multiple = named.length >= 2 && /\b(?:and|then)\b|\+/.test(text);
  if (multiple && (!raw || ['booking', 'availability'].includes(raw.action ?? ''))) {
    if (named.length > 5 || named.some((item) => item.service.depositRequired))
      return {
        replies: [
          'Consecutive visits support up to five treatments without deposits. Contact the business to arrange this visit.',
        ],
        conversation: await discardConfirmation(redis, ctx),
      };
    if (ctx.conversation?.bookingId)
      return {
        replies: [
          'An existing appointment can only be moved as its original treatment. Book additional treatments separately or contact the business.',
        ],
        conversation: ctx.conversation,
      };
    raw = {
      ...(raw ?? { day: null, window: null, at: null }),
      service: named[0]!.service.name,
      action: 'booking',
      staff: null,
    };
    const additionalServices = named
      .slice(1)
      .map((item) => ({ serviceId: String(item.service._id) }));
    ctx = {
      ...ctx,
      conversation: {
        ...(await discardConfirmation(redis, ctx)),
        state: CONVERSATION_STATE.SELECTING_SERVICE,
        invalidCount: 0,
        additionalServices,
      },
    };
  }
  if (!raw) {
    if (clock.kind === 'exact') {
      return {
        replies: [copy.bookingRequestNotUnderstood],
        conversation: await discardConfirmation(redis, ctx),
      };
    }
    return null;
  }
  // A model-provided time is never authority: use only the clock in the user's message.
  raw.at =
    clock.kind === 'exact'
      ? `${Math.floor(clock.minutes / 60)
          .toString()
          .padStart(2, '0')}:${(clock.minutes % 60).toString().padStart(2, '0')}`
      : null;
  if (clock.kind === 'ambiguous') raw.window = null;

  const previous = ctx.conversation;
  const selectedService = vocabulary.services.find((service) => service.id === previous?.serviceId);
  const answer = (text: string): TurnResult => ({
    replies: [text.slice(0, 3500)],
    conversation: previous ? { ...previous, invalidCount: 0 } : null,
  });
  if (raw.action === 'cancel' || raw.action === 'reschedule' || raw.action === 'help') {
    const command = await handleGlobalCommand({ ...ctx, text: raw.action.toUpperCase() });
    return command ?? answer(copy.nothingToMove);
  }
  if (raw.action === 'off_topic') return answer(copy.bookingHelp);
  if (raw.action === 'location') {
    const business = await Business.findOne({ _id: ctx.businessId })
      .select('city profile.addressLine profile.neighbourhood')
      .maxTimeMS(5000);
    return answer(
      copy.location(
        [business?.profile?.addressLine, business?.profile?.neighbourhood, business?.city].filter(
          (part): part is string => typeof part === 'string' && Boolean(part.trim()),
        ),
      ),
    );
  }
  if (raw.action === 'greeting') {
    if (previous && previous.state !== CONVERSATION_STATE.HELP)
      return answer(copy.greeting(ctx.businessName, ctx.firstName) + '\n\n' + copy.bookingHelp);
    const asked = await promptService(ctx, {});
    return {
      ...asked,
      replies: [copy.greeting(ctx.businessName, ctx.firstName), ...asked.replies],
    };
  }
  if (raw.action === 'appointments') {
    const bookings = await upcomingBookings(ctx.businessId, ctx.clientId);
    if (!bookings.length) return answer(copy.noAppointments);
    const catalog = await Service.find({
      businessId: ctx.businessId,
      _id: { $in: bookings.map((booking) => booking.serviceId) },
    })
      .limit(100)
      .maxTimeMS(5000);
    return answer(
      copy.appointmentList(
        bookings.map((booking) => ({
          serviceName:
            catalog.find((service) => String(service._id) === booking.serviceId)?.name ??
            'Appointment',
          startsAt: booking.startsAt,
        })),
        ctx.timezone,
      ),
    );
  }
  if (raw.action === 'services' || raw.action === 'price' || raw.action === 'duration') {
    const requested = raw.service
      ? resolveIntent(raw, { ...vocabulary, timezone: ctx.timezone, now: ctx.now ?? new Date() })
      : null;
    if (requested && !requested.serviceId && !requested.serviceOptions.length) {
      return answer('That service is not listed.\n\n' + copy.serviceDetails(services));
    }
    const ids = requested
      ? [requested.serviceId, ...requested.serviceOptions]
      : [previous?.serviceId];
    const chosen =
      raw.action === 'services' || !ids.some(Boolean)
        ? services
        : services.filter((service) => ids.includes(String(service._id)));
    return answer(copy.serviceDetails(chosen));
  }
  if (raw.action === 'staff' || raw.action === 'hours') {
    const requested = raw.service
      ? resolveIntent(raw, { ...vocabulary, timezone: ctx.timezone, now: ctx.now ?? new Date() })
          .serviceId
      : previous?.serviceId;
    const eligible = requested
      ? staff.filter((member) => member.serviceIds.includes(requested))
      : staff;
    return answer(
      raw.action === 'staff'
        ? copy.staffDetails(eligible.map((member) => member.name))
        : copy.workingHours(
            eligible.map((member) => ({ name: member.name, hours: member.workingHours })),
          ),
    );
  }
  const resolved = resolveIntent(
    { ...raw, service: raw.service ?? selectedService?.name ?? null },
    {
      ...vocabulary,
      timezone: ctx.timezone,
      now: ctx.now ?? new Date(),
    },
  );
  const question =
    raw.action === 'availability' || raw.action === 'booking' || raw.action === 'no_preference';
  if (clock.kind === 'ambiguous' && clock.minutes !== undefined)
    resolved.ambiguousAt = clock.minutes;
  if (
    !question &&
    clock.kind !== 'ambiguous' &&
    (!isUseful(resolved) ||
      !(
        (raw.service && (resolved.serviceId || resolved.serviceOptions.length)) ||
        (raw.staff && resolved.staffId) ||
        (raw.day && resolved.date) ||
        ((raw.window || raw.at) && resolved.within)
      ))
  )
    return null;

  // Carry earlier answers only when this message did not replace them. Never
  // retain a staff choice that cannot perform the newly selected service.
  if (
    !raw.staff &&
    previous?.staffId &&
    vocabulary.staff.some(
      (member) =>
        member.id === previous.staffId && member.serviceIds.includes(resolved.serviceId ?? ''),
    )
  )
    resolved.staffId = previous.staffId;
  if (!raw.day && previous?.date) resolved.date = previous.date;
  if (!raw.window && !raw.at && previous?.within) resolved.within = previous.within;

  ctx = { ...ctx, conversation: await discardConfirmation(redis, ctx) };
  if (!multiple && raw.service && resolved.serviceId !== previous?.serviceId && ctx.conversation)
    delete ctx.conversation.additionalServices;
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
      ...(previous?.appointmentHolderId
        ? { appointmentHolderId: previous.appointmentHolderId }
        : {}),
      ...(previous?.additionalServices ? { additionalServices: previous.additionalServices } : {}),
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
    ...(ctx.conversation?.additionalServices
      ? { additionalServices: ctx.conversation.additionalServices }
      : {}),
    ...(ctx.conversation?.appointmentHolderId
      ? { appointmentHolderId: ctx.conversation.appointmentHolderId }
      : {}),
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

    const noPreference =
      ctx.conversation?.serviceId === resolved.serviceId &&
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
  if (ctx.conversation?.state === CONVERSATION_STATE.AWAITING_REMINDER_REPLY) {
    return answerReminder(redis, ctx, ctx.conversation);
  }
  if (ctx.conversation?.state === CONVERSATION_STATE.AWAITING_FOLLOWUP_REPLY) {
    return answerFollowUp(redis, ctx, ctx.conversation);
  }
  const conversation = ctx.conversation;
  const recipient = /^appointment for (.+)$/i.exec(ctx.text.trim());
  const recipientStates: string[] = [
    CONVERSATION_STATE.SELECTING_SERVICE,
    CONVERSATION_STATE.SELECTING_STAFF,
    CONVERSATION_STATE.SELECTING_SEQUENCE_STAFF,
    CONVERSATION_STATE.SELECTING_DATE,
    CONVERSATION_STATE.SELECTING_SLOT,
    CONVERSATION_STATE.CONFIRMING,
    CONVERSATION_STATE.AWAITING_NAME,
  ];
  if (recipient && (!conversation || recipientStates.includes(conversation.state))) {
    if (conversation?.bookingId)
      return {
        replies: [
          'An existing appointment keeps the same recipient. Contact the business to change who it is for.',
        ],
        conversation,
      };
    const name = recipient[1]!.trim();
    if (name.length > 80 || !isUsableName(name))
      return {
        replies: [
          'Send APPOINTMENT FOR followed by a name of up to 80 characters, or APPOINTMENT FOR MYSELF.',
        ],
        conversation,
      };
    let holderId: string | undefined;
    if (!/^(myself|me)$/i.test(name)) {
      const existing = await AppointmentHolder.findOne({
        businessId: ctx.businessId,
        clientId: ctx.clientId,
        name,
        active: true,
      })
        .lean()
        .maxTimeMS(5000);
      try {
        holderId = existing
          ? String(existing._id)
          : (await saveHolder(ctx.businessId, ctx.clientId, { name, active: true }))?.id;
      } catch (error) {
        if (error instanceof ConfigurationConflict)
          return {
            replies: [
              'This person could not be added. Manage appointment holders through your appointments link or contact the business.',
            ],
            conversation,
          };
        throw error;
      }
    }
    const base = { ...conversation };
    delete base.appointmentHolderId;
    if (holderId) base.appointmentHolderId = holderId;
    if (conversation?.state === CONVERSATION_STATE.CONFIRMING)
      return {
        replies: [
          `The appointment will be for ${name}. Reply YES to confirm or NO to choose another time.`,
        ],
        conversation: {
          ...base,
          state: conversation.state,
          invalidCount: conversation.invalidCount,
        },
      };
    const opening = await promptService(ctx, base);
    return { ...opening, replies: [`Booking for ${name}.`, ...opening.replies] };
  }
  if (conversation?.state === CONVERSATION_STATE.SELECTING_SEQUENCE_STAFF) {
    let staffId = pickOption(ctx.text, conversation.options);
    if (!staffId) {
      const members = await Staff.find({
        businessId: ctx.businessId,
        _id: { $in: conversation.options ?? [] },
        active: true,
      })
        .select('name')
        .lean()
        .limit(100)
        .maxTimeMS(5000);
      staffId =
        members
          .find((member) => member.name.toLocaleLowerCase() === ctx.text.trim().toLocaleLowerCase())
          ?._id.toString() ?? null;
    }
    if (!staffId || conversation.sequenceStaffIndex === undefined)
      return {
        replies: ['Choose one of the professionals above by name or number.'],
        conversation,
      };
    const additionalServices = conversation.additionalServices!.map((step, i) =>
      i === conversation.sequenceStaffIndex ? { ...step, staffId } : step,
    );
    return promptDate(redis, ctx, { ...conversation, additionalServices });
  }
  if (
    conversation &&
    conversation.state !== CONVERSATION_STATE.AWAITING_RATING &&
    conversation.state !== CONVERSATION_STATE.AWAITING_NAME &&
    conversation.state !== CONVERSATION_STATE.AWAITING_REVIEW_COMMENT &&
    !pickOption(ctx.text, conversation.options) &&
    !isYes(ctx.text) &&
    !isNo(ctx.text)
  ) {
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
    const lead = isOpener(ctx.text)
      ? copy.greeting(ctx.businessName, ctx.firstName)
      : copy.notUnderstood;
    return {
      replies: [lead, ...opening.replies],
      conversation: opening.conversation,
    };
  }

  switch (conversation.state) {
    case CONVERSATION_STATE.AWAITING_NAME: {
      const name = ctx.text.trim();
      if (name.length < 1 || name.length > 80 || !isUsableName(name)) {
        return { replies: ['Please send a name of up to 80 characters.'], conversation };
      }
      const existing = await Client.findById(ctx.clientId)
        .select('displayName')
        .lean()
        .maxTimeMS(5000);
      if (!existing?.displayName?.trim() || !isUsableName(existing.displayName)) {
        await Client.updateOne(
          { _id: ctx.clientId, displayName: existing?.displayName ?? null },
          { $set: { displayName: name } },
        ).maxTimeMS(5000);
      }
      return commit(redis, ctx, { ...conversation, state: CONVERSATION_STATE.CONFIRMING });
    }
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
        const services = await Service.find({ businessId: ctx.businessId, active: true }).sort({
          displayOrder: 1,
        });
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
          copy.slotMenu(
            (conversation.options ?? []).map((s) => new Date(s)),
            ctx.timezone,
          ),
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
      return invalid(ctx, conversation, 'Reply YES to confirm or NO to pick another time.');
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
      if (answer === '2' || isNo(answer))
        return { replies: [copy.rebookDeclined], conversation: null };
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
    case CONVERSATION_STATE.AWAITING_REMINDER_REPLY: // handled at the top of advance()
    case CONVERSATION_STATE.AWAITING_FOLLOWUP_REPLY: // likewise
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
    replies: [
      copy.cancelled,
      copy.rebookOffer({ serviceName: service.name, staffName: staff?.name ?? null }),
    ],
    conversation: {
      state: CONVERSATION_STATE.OFFERING_REBOOK,
      serviceId: String(service._id),
      ...(staff ? { staffId: String(staff._id) } : {}),
      invalidCount: 0,
    },
  };
}

/**
 * The customer's answer to "1 confirm · 2 reschedule · 3 cancel".
 *
 * Anything that is not one of those three is NOT treated as invalid input: a
 * customer who replies "hi, can I also book a haircut?" to a reminder wants the
 * normal menu, and re-prompting them about tomorrow's facial would be the bot
 * not listening. Such messages fall through to the idle conversation instead.
 *
 * Confirming never changes `status`: approval and deposit rules stay the
 * business's to satisfy. It only records attendance intent.
 */
const REMINDER_CONFIRM = /^(1|yes|y|ok|okay|haan|han|confirm(ed)?|coming|i'?ll be there)[.!]?$/i;
const REMINDER_RESCHEDULE = /^(2|reschedule|change( time)?|move( it)?)[.!]?$/i;
const REMINDER_CANCEL = /^(3)[.!]?$/; // the word CANCEL is a global command already

async function answerReminder(
  redis: Redis,
  ctx: TurnContext,
  conversation: Conversation,
): Promise<TurnResult> {
  const text = ctx.text.trim();
  const choice = REMINDER_CONFIRM.test(text)
    ? 'confirm'
    : REMINDER_RESCHEDULE.test(text)
      ? 'reschedule'
      : REMINDER_CANCEL.test(text)
        ? 'cancel'
        : null;

  if (!choice) return advance(redis, { ...ctx, conversation: null });

  // Re-read under the tenant filter: the owner may have cancelled or moved it
  // since the reminder went out, and the reply must act on today's truth.
  const booking = await Booking.findOne({
    _id: conversation.bookingId,
    businessId: ctx.businessId,
    clientId: ctx.clientId,
    startsAt: { $gt: ctx.now ?? new Date() },
    status: {
      $in: [BOOKING_STATUS.PENDING, BOOKING_STATUS.CONFIRMED, BOOKING_STATUS.AWAITING_APPROVAL],
    },
  });
  if (!booking) return { replies: [copy.reminderBookingGone], conversation: null };

  const bookingId = String(booking._id);

  if (choice === 'confirm') {
    // Only the first confirmation is stamped; a second "1" is just reassurance.
    await Booking.updateOne(
      { _id: booking._id, clientConfirmedAt: null },
      { $set: { clientConfirmedAt: ctx.now ?? new Date() } },
    );
    return {
      replies: [copy.reminderConfirmed({ startsAt: booking.startsAt, timezone: ctx.timezone })],
      conversation: null,
    };
  }

  if (choice === 'cancel') {
    const service = await Service.findById(booking.serviceId).select('name');
    return {
      replies: [
        copy.cancelPrompt({
          serviceName: service?.name ?? 'your appointment',
          startsAt: booking.startsAt,
          timezone: ctx.timezone,
        }),
      ],
      conversation: { state: CONVERSATION_STATE.CANCELLING, bookingId, invalidCount: 0 },
    };
  }

  // Reschedule — the same path as RESCHEDULE → pick booking, with the pick made.
  return promptDate(redis, ctx, {
    state: CONVERSATION_STATE.SELECTING_DATE,
    serviceId: booking.serviceId,
    bookingId,
    invalidCount: 0,
  });
}

/**
 * The answer to a follow-up offer: "1 book this slot · 2 other times · 3 not now".
 *
 * "1" goes through the ordinary confirm step (hold → "Reply YES"), so a
 * follow-up booking is made by exactly the same code as any other, and a slot
 * that went in the meantime is re-offered rather than double-booked. The job
 * notices the new booking and closes the follow-up as BOOKED.
 *
 * As with reminders, anything else is a normal message, not invalid input.
 */
const FOLLOWUP_OTHER = /^(2|other( times?)?|another time)[.!]?$/i;
const FOLLOWUP_NOT_NOW = /^(3|no|n|nope|nahi|not now|no thanks)[.!]?$/i;

async function answerFollowUp(
  redis: Redis,
  ctx: TurnContext,
  conversation: Conversation,
): Promise<TurnResult> {
  const text = ctx.text.trim();
  const offer = conversation.followUp;
  const choice = REMINDER_CONFIRM.test(text)
    ? 'book'
    : FOLLOWUP_OTHER.test(text)
      ? 'other'
      : FOLLOWUP_NOT_NOW.test(text)
        ? 'decline'
        : null;
  if (!choice || !offer) return advance(redis, { ...ctx, conversation: null });

  const source = await Booking.findOne({
    _id: offer.sourceBookingId,
    businessId: ctx.businessId,
    clientId: ctx.clientId,
  }).select('followUp');
  const f = source?.followUp;
  if (!f || (f.status !== 'offered' && f.status !== 'nudged')) {
    return advance(redis, { ...ctx, conversation: null });
  }

  if (choice === 'decline') {
    await declineFollowUp(ctx.businessId, offer.sourceBookingId, ctx.now ?? new Date());
    return { replies: [copy.followUpDeclined], conversation: null };
  }

  const base: Conversation = {
    state: CONVERSATION_STATE.SELECTING_DATE,
    serviceId: f.serviceId,
    ...((offer.staffId ?? f.staffId) ? { staffId: (offer.staffId ?? f.staffId)! } : {}),
    invalidCount: 0,
  };

  if (choice === 'book' && offer.slotStart && offer.staffId) {
    const slotStart = new Date(offer.slotStart);
    const date = toBusinessLocal(slotStart, ctx.timezone).toISODate()!;
    return promptConfirm(
      redis,
      ctx,
      { ...base, state: CONVERSATION_STATE.SELECTING_SLOT, staffId: offer.staffId, date },
      slotStart,
    );
  }

  return promptDate(redis, ctx, base);
}

/** Build the CANCELLING / RESCHEDULING prompt from the customer's real bookings. */
export async function upcomingBookings(businessId: string, clientId: string) {
  return Booking.find({
    businessId,
    clientId,
    startsAt: { $gt: new Date() },
    status: { $in: [BOOKING_STATUS.PENDING, BOOKING_STATUS.CONFIRMED] },
  })
    .sort({ startsAt: 1 })
    .limit(20)
    .maxTimeMS(5000);
}
