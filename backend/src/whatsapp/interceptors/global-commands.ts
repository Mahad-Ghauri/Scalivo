import { ClientProfile } from '../../models/ClientProfile.js';
import { Service } from '../../models/Service.js';
import { logger } from '../../lib/logger.js';
import * as copy from '../messages.js';
import { CONVERSATION_STATE, type Conversation } from '../fsm/states.js';
import { upcomingBookings } from '../fsm/machine.js';
import { meTokenFor } from '../../me/token.js';
import { env } from '../../config/env.js';

/**
 * Commands that win from ANY state, before the FSM runs.
 *
 * STOP is the reason this is an interceptor and not an FSM transition. A
 * customer halfway through booking who types STOP has opted out; routing that
 * into the CONFIRMING handler — where it is neither YES nor NO — would answer
 * "reply YES or NO" to an opt-out request. That is both a bug and a compliance
 * failure, and no arrangement of states fixes it, because the problem is that
 * state is being consulted at all.
 */

/**
 * Whole-message matching, deliberately.
 *
 * "please don't stop sending offers" contains STOP and is not an opt-out;
 * a bare "STOP" is. Substring matching here would silently unsubscribe
 * customers who were asking for the opposite.
 */
const COMMANDS = {
  STOP: /^stop$/i,
  START: /^(start|unstop)$/i,
  HELP: /^help$/i,
  CANCEL: /^cancel$/i,
  RESCHEDULE: /^reschedule$/i,
} as const;

export interface CommandContext {
  businessId: string;
  businessName: string;
  timezone: string;
  clientId: string;
  text: string;
}

export interface CommandResult {
  replies: string[];
  conversation: Conversation | null;
  /** The owner needs to know a customer asked for a person. */
  notifyOwner?: boolean;
}

/** Returns null when the message is not a global command — the FSM then runs. */
export async function handleGlobalCommand(ctx: CommandContext): Promise<CommandResult | null> {
  const text = ctx.text.trim();
  if (/^(my appointments|my bookings|appointments link)$/i.test(text)) {
    const token = await meTokenFor(ctx.businessId, ctx.clientId);
    return {
      replies: [
        token
          ? `Your private appointments page: ${env.WEB_URL}/me/${token}. Keep this link private.`
          : 'No appointment history yet. Tell me which service you would like to book.',
      ],
      conversation: null,
    };
  }

  // STOP is scoped to the business whose number they messaged, not to the
  // platform. A Client row is a PERSON, global across every business — writing
  // the opt-out there would mean telling one salon to stop also silenced their
  // gym, their clinic and every business they have never heard of. The message
  // arrived on one session; it can only have meant one business.
  if (COMMANDS.STOP.test(text)) {
    await setOptOut(ctx.businessId, ctx.clientId, true);
    logger.info({ businessId: ctx.businessId, clientId: ctx.clientId }, 'customer opted out');
    // State is DISCARDED, not advanced — they asked to stop, not to continue.
    return { replies: [copy.optedOut], conversation: null };
  }

  if (COMMANDS.START.test(text)) {
    await setOptOut(ctx.businessId, ctx.clientId, false);
    return { replies: [copy.optedIn], conversation: null };
  }

  if (COMMANDS.HELP.test(text)) {
    return {
      replies: [copy.helpRequested],
      conversation: { state: CONVERSATION_STATE.HELP, invalidCount: 0 },
      notifyOwner: true,
    };
  }

  if (COMMANDS.CANCEL.test(text)) return pickBooking(ctx, 'cancel');
  if (COMMANDS.RESCHEDULE.test(text)) return pickBooking(ctx, 'reschedule');

  return null;
}

/**
 * Cancel and reschedule ask the same question — which appointment? — so they
 * share the picker and differ only in `intent`. What they must NOT share is the
 * answer: a customer who typed CANCEL and picked one has asked to cancel it,
 * not to start choosing a new time.
 */
async function pickBooking(
  ctx: CommandContext,
  intent: 'cancel' | 'reschedule',
): Promise<CommandResult | null> {
  const bookings = await upcomingBookings(ctx.businessId, ctx.clientId);

  if (bookings.length === 0) {
    // Nothing to move means they probably want to book, so reschedule falls
    // through to the FSM's greeting rather than answering a flat refusal.
    // Cancel is a direct question and deserves a direct answer.
    return intent === 'cancel' ? { replies: [copy.nothingToCancel], conversation: null } : null;
  }

  const named = await Promise.all(
    bookings.map(async (b) => ({
      serviceName: (await Service.findById(b.serviceId))?.name ?? 'your appointment',
      startsAt: b.startsAt,
    })),
  );

  // A single appointment is not a choice, so cancel confirms it directly rather
  // than printing a one-item menu. Reschedule still shows the picker: its next
  // question is "which day", and skipping straight there would leave the
  // customer unsure which appointment they are moving.
  if (bookings.length === 1 && intent === 'cancel') {
    return {
      replies: [copy.cancelPrompt({ ...named[0]!, timezone: ctx.timezone })],
      conversation: {
        state: CONVERSATION_STATE.CANCELLING,
        bookingId: String(bookings[0]!._id),
        invalidCount: 0,
      },
    };
  }

  return {
    replies: [copy.upcomingMenu(named, ctx.timezone)],
    conversation: {
      state: CONVERSATION_STATE.SELECTING_BOOKING,
      intent,
      options: bookings.map((b) => String(b._id)),
      invalidCount: 0,
    },
  };
}

/**
 * Record an opt-out against ONE business.
 *
 * Upserts because STOP can arrive before the customer has ever booked — an
 * unhappy recipient of a broadcast is exactly the person most likely to send
 * it, and they may have no profile yet.
 *
 * The instant is stored alongside the flag so a campaign can report the opt-outs
 * it actually provoked (§6.3). Cleared on the way back in: an old timestamp left
 * behind a re-subscription would attribute their historic STOP to whatever
 * campaign came next.
 */
async function setOptOut(businessId: string, clientId: string, optOut: boolean): Promise<void> {
  await ClientProfile.updateOne(
    { businessId, clientId },
    {
      $setOnInsert: { businessId, clientId },
      $set: { marketingOptOut: optOut, marketingOptOutAt: optOut ? new Date() : null },
    },
    { upsert: true, setDefaultsOnInsert: true },
  );
}
