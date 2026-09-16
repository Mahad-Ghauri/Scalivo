import type { Redis } from 'ioredis';
import { ANY_STAFF, BOOKING_STATUS } from '@scalivo/shared';
import { Booking } from '../../models/Booking.js';
import { Service } from '../../models/Service.js';
import { Staff } from '../../models/Staff.js';
import { daysWithAvailability, getAvailability } from '../../bookings/availability.js';
import { cancelBooking, createBooking, holdSlot } from '../../bookings/create.js';
import { logger } from '../../lib/logger.js';
import * as copy from '../messages.js';
import { CONVERSATION_STATE, type Conversation, MAX_INVALID_INPUT } from './states.js';

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
}

/** Index into the list the customer is actually looking at. */
function pickOption(text: string, options: string[] | undefined): string | null {
  if (!options?.length) return null;
  const n = Number(text.trim());
  if (!Number.isInteger(n) || n < 1 || n > options.length) return null;
  return options[n - 1] ?? null;
}

function isYes(text: string): boolean {
  return /^(yes|y|yeah|ok|okay|haan|han)$/i.test(text.trim());
}

function isNo(text: string): boolean {
  return /^(no|n|nope|nahi)$/i.test(text.trim());
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

async function promptService(ctx: TurnContext, base: Partial<Conversation>): Promise<TurnResult> {
  const services = await Service.find({ businessId: ctx.businessId, active: true }).sort({ displayOrder: 1 });
  if (services.length === 0) {
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
    ...(base.staffId ? { staffId: base.staffId } : {}),
  });

  // The day filled between being offered and being chosen. Never present an
  // empty list as a choice — go back to the days that do have room.
  if (slots.length === 0) return promptDate(redis, ctx, base);

  return {
    replies: [...(lead ? [lead] : []), copy.slotMenu(slots.map((s) => s.startsAt), ctx.timezone)],
    conversation: {
      ...base,
      state: CONVERSATION_STATE.SELECTING_SLOT,
      options: slots.map((s) => s.startsAt.toISOString()),
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

  const attempt = (holdToken: string) =>
    createBooking(redis, {
      businessId: ctx.businessId,
      staffId: base.heldStaffId!,
      clientId: ctx.clientId,
      serviceId: base.serviceId!,
      startsAt,
      source: 'whatsapp',
      holdToken,
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
  if (base.bookingId) await cancelBooking(base.bookingId, ctx.businessId);

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

/** One inbound message, one turn. The interceptor chain has already run. */
export async function advance(redis: Redis, ctx: TurnContext): Promise<TurnResult> {
  const conversation = ctx.conversation;

  // IDLE — the absence of a key, not a stored state.
  if (!conversation) {
    const opening = await promptService(ctx, {});
    return {
      replies: [copy.greeting(ctx.businessName, ctx.firstName), ...opening.replies],
      conversation: opening.conversation,
    };
  }

  switch (conversation.state) {
    case CONVERSATION_STATE.SELECTING_SERVICE: {
      const serviceId = pickOption(ctx.text, conversation.options);
      if (!serviceId) {
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
      if (isNo(ctx.text)) return promptSlot(redis, ctx, { ...conversation, invalidCount: 0 });

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

      await cancelBooking(conversation.bookingId!, ctx.businessId);
      return { replies: [copy.cancelled], conversation: null };
    }

    case CONVERSATION_STATE.AWAITING_RATING: {
      const rating = Number(ctx.text.trim());
      if (!Number.isInteger(rating) || rating < 1 || rating > 5) {
        return invalid(ctx, conversation, 'Reply with a number from 1 to 5.');
      }

      // Publishing and the ≤3 private flag are SPEC §9, built in Phase 2. The
      // state and its interceptor exist now because the AMBIGUITY they resolve
      // exists now — a bare "4" must not fall through to the booking menu.
      logger.info(
        { businessId: ctx.businessId, clientId: ctx.clientId, bookingId: conversation.bookingId, rating },
        'rating received',
      );
      return { replies: [copy.ratingThanks], conversation: null };
    }

    // HELP is terminal — the owner has been notified, and answering further
    // would talk over the human who is about to. GREETING is transient and
    // never persisted. AWAITING_DEPOSIT is unreachable until Phase 2 wires a
    // payment webhook; if a stale one is ever read back, drop it rather than
    // stranding the customer in a state with no exit.
    case CONVERSATION_STATE.HELP:
    case CONVERSATION_STATE.GREETING:
    case CONVERSATION_STATE.AWAITING_DEPOSIT:
    case CONVERSATION_STATE.RESCHEDULING:
      return { replies: [], conversation: null };
  }
}

/** Build the CANCELLING / RESCHEDULING prompt from the customer's real bookings. */
export async function upcomingBookings(businessId: string, clientId: string) {
  return Booking.find({
    businessId,
    clientId,
    startsAt: { $gt: new Date() },
    status: { $in: [BOOKING_STATUS.PENDING, BOOKING_STATUS.CONFIRMED] },
  }).sort({ startsAt: 1 });
}
