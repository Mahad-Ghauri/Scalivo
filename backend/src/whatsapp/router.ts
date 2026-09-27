import type { Redis } from 'ioredis';
import type { InboundMessage, MessagingProvider } from '@scalivo/shared';
import { Business } from '../models/Business.js';
import { upsertClientFromMessage } from '../auth/identity.js';
import { logger } from '../lib/logger.js';
import {
  acquireConversationLock,
  clearConversation,
  clearPendingPrompt,
  readConversation,
  writeConversation,
} from './state.js';
import { handleGlobalCommand } from './interceptors/global-commands.js';
import { applyPendingPrompt } from './interceptors/pending-prompt.js';
import { advance } from './fsm/machine.js';
import { recordFlowStep } from './flow-run.js';
import { attributeReply } from '../retention/attribute.js';
import { enqueue } from '../session-health/outbound-queue.js';
import { confirmBooking } from '../notifications/confirm.js';
import { PUSH_CHANNEL, pushToOwners } from '../push/fcm.js';
import { CONVERSATION_STATE } from './fsm/states.js';
import * as copy from './messages.js';

/**
 * The interceptor chain, in the order docs/fsm-design.md §2 specifies.
 *
 *   verify → ack → dedupe → identity → lock → global → pending → FSM
 *
 * Stages 0 and 1 (HMAC verification, ack-first, idempotency-key dedupe) already
 * live in messaging/webhook.ts, which is why this starts at identity. The
 * ordering there matters as much as it does here: acking before processing
 * means a slow booking write never triggers a retry.
 *
 * The rule this file exists to enforce is that **state is consulted last**. Every
 * stage above the FSM handles input whose meaning does not depend on where the
 * customer is in the conversation — and each one is a bug if the FSM sees it
 * first.
 */

export interface RouterDeps {
  redis: Redis;
  provider: MessagingProvider;
}

export async function handleInboundMessage(
  deps: RouterDeps,
  message: InboundMessage,
): Promise<void> {
  // Own messages and group chats are not conversations. Groups especially:
  // a booking bot answering every message in a family group is a support ticket.
  if (message.fromMe || message.isGroup) return;

  // Nothing a person sent: linking a device makes WhatsApp emit protocol events
  // for existing contacts, which arrive as type 'unknown' with no body. Checked
  // before identity so they create no client either. Media stays — a voice note
  // is a customer talking, and gets the invalid-input reply.
  if (!message.body.trim() && !message.hasMedia) return;

  // ── Stage 2: identity ────────────────────────────────────────────────────
  // sessionId is the only routing key an inbound event carries, and it is on
  // the envelope, not inside `data`.
  const business = await Business.findOne({ 'whatsapp.sessionId': message.sessionId });
  if (!business) {
    logger.warn({ sessionId: message.sessionId }, 'inbound message for an unknown session');
    return;
  }
  const businessId = String(business._id);

  const client = await upsertClientFromMessage(deps.provider, message);
  const clientId = String(client._id);

  // A soft health signal: silence from a normally-busy business is worth
  // surfacing, and only the inbound path can observe it.
  await Business.updateOne(
    { _id: business._id },
    { $set: { 'whatsapp.lastInboundAt': message.receivedAt } },
  );

  /**
   * If the last thing we sent them was a nudge or a broadcast, this is the reply
   * to it (§6.3). Recorded before the interceptors run, because a customer whose
   * answer to a nudge is STOP has still answered it — and that is the single most
   * informative reply a campaign can get.
   */
  await attributeReply(businessId, clientId, message.receivedAt);

  // ── Stage 3: lock ────────────────────────────────────────────────────────
  // Two messages a second apart otherwise race on the same state: both read
  // SELECTING_SLOT, both pick, both hold.
  const release = await acquireConversationLock(deps.redis, businessId, clientId);
  if (!release) {
    logger.info({ businessId, clientId }, 'dropped a message that raced its predecessor');
    return;
  }

  try {
    // The FSM only reads text. A voice note or image is not an error — it is
    // input it cannot parse, and it goes down the invalid-input path.
    const text = message.body ?? '';

    logger.info(
      { businessId, clientId, type: message.type, hasMedia: message.hasMedia },
      'inbound message',
    );

    // ── Stage 4: global commands ───────────────────────────────────────────
    const command = await handleGlobalCommand({
      businessId,
      businessName: business.name,
      timezone: business.timezone,
      clientId,
      text,
    });

    if (command) {
      /**
       * A command can end a booking mid-flow, and the funnel has to hear about it.
       *
       * The conversation is read HERE rather than earlier in the chain for two
       * reasons. It keeps stage 4's decision provably independent of state — the
       * whole point of this file's ordering is that a command means the same thing
       * from anywhere — and it keeps the extra Redis read on the rare path instead
       * of on every message. Without it the flow would be left open and later read
       * as an abandonment, which would report the opt-out machinery working
       * correctly as the booking flow failing.
       */
      const interrupted = await readConversation(deps.redis, businessId, clientId);
      await recordFlowStep({
        businessId,
        clientId,
        before: interrupted,
        after: command.conversation,
        at: message.receivedAt,
      });

      await persist(deps.redis, businessId, clientId, command.conversation);
      await reply(deps, message, businessId, clientId, command.replies);

      if (command.notifyOwner) {
        // The BOOKINGS channel, not SESSION_HEALTH: a customer wanting a human
        // is important but not an emergency, and putting it on the alarm
        // channel is how the alarm channel stops being believed.
        await pushToOwners(businessId, {
          title: `${business.name} — a customer needs help`,
          body: `${client.displayName ?? 'A customer'} asked to speak to someone.`,
          channel: PUSH_CHANNEL.BOOKINGS,
        }).catch((err) => logger.error({ err, businessId }, 'could not notify the owner'));
      }
      return;
    }

    // ── Stage 5: pending prompt ────────────────────────────────────────────
    const stored = await readConversation(deps.redis, businessId, clientId);
    const conversation = await applyPendingPrompt(deps.redis, businessId, clientId, stored);

    // ── Stage 6: the FSM ───────────────────────────────────────────────────
    const result = await advance(deps.redis, {
      businessId,
      businessName: business.name,
      timezone: business.timezone,
      clientId,
      firstName: client.displayName?.split(' ')[0] ?? null,
      text,
      conversation,
    });

    // A rating that was answered must not be asked again on the next message.
    if (conversation?.state === CONVERSATION_STATE.AWAITING_RATING) {
      await clearPendingPrompt(deps.redis, businessId, clientId);
    }

    logger.info(
      { businessId, clientId, from: conversation?.state ?? 'idle', to: result.conversation?.state ?? 'idle' },
      'conversation transition',
    );

    /**
     * The same transition, written down somewhere it survives.
     *
     * The line above reaches pino, pino reaches stdout, and stdout is collected
     * nowhere — so the booking-completion metric was being logged into a void.
     * Successes become Bookings and were always recoverable; the abandonments
     * existed only in that log line, and they are the denominator.
     */
    await recordFlowStep({
      businessId,
      clientId,
      before: conversation,
      after: result.conversation,
      bookingId: result.confirms,
      at: message.receivedAt,
    });

    await persist(deps.redis, businessId, clientId, result.conversation);
    await reply(deps, message, businessId, clientId, result.replies);

    /**
     * The confirmation goes out last, and down a different road.
     *
     * Not through reply(): that path queues into Redis, which is right for a
     * menu prompt nobody will miss and wrong for the one message that proves the
     * appointment exists. confirmBooking records it, marks the booking CONFIRMED
     * and leaves a row whose deliveredAt answers "did they ever actually hear
     * from us?" long after this conversation is gone.
     *
     * Failure is not raised: the booking committed, and telling the customer
     * their booking failed because a message did not send would be a lie about
     * the one fact that matters. The unsent confirmation stays queued.
     */
    if (result.confirms) {
      await confirmBooking(deps, businessId, result.confirms).catch((err) =>
        logger.error({ err, businessId, bookingId: result.confirms }, 'could not confirm booking'),
      );
    }
  } finally {
    await release();
  }
}

async function persist(
  redis: Redis,
  businessId: string,
  clientId: string,
  conversation: Awaited<ReturnType<typeof advance>>['conversation'],
): Promise<void> {
  if (conversation) await writeConversation(redis, businessId, clientId, conversation);
  else await clearConversation(redis, businessId, clientId);
}

/**
 * Replies address the LID, not the phone.
 *
 * The LID is the only identifier every inbound message carries — the phone may
 * never have resolved (FINDING #1) — and the provider passes an address
 * containing '@' straight through as the chat id.
 *
 * A send that throws is QUEUED, not dropped. The webhook is already acked, so
 * rethrowing would only lose the state we just wrote — and losing the message
 * would mean a customer who booked during an outage never learns their
 * appointment exists. The queue drains when the session comes back.
 *
 * Once one send fails the rest are queued without being attempted: they are
 * ordered replies to the same person, and a confirmation must not arrive after
 * the follow-up that assumes it.
 */
async function reply(
  deps: RouterDeps,
  message: InboundMessage,
  businessId: string,
  clientId: string,
  replies: string[],
): Promise<void> {
  let degraded = false;

  for (const text of replies) {
    if (!text) continue;

    if (degraded) {
      await enqueue(deps.redis, businessId, {
        sessionId: message.sessionId,
        to: message.contactLid,
        text,
      });
      continue;
    }

    try {
      const sent = await deps.provider.sendText(message.sessionId, message.contactLid, text);
      // ACCEPTED, not delivered (FINDING #3). Only a message.ack reaching
      // 'delivered' proves it arrived.
      logger.info(
        { businessId, clientId, providerMessageId: sent.providerMessageId },
        'outbound message accepted',
      );
    } catch (err) {
      logger.error({ err, businessId, clientId }, 'send failed — queueing for reconnect');
      degraded = true;
      await enqueue(deps.redis, businessId, {
        sessionId: message.sessionId,
        to: message.contactLid,
        text,
      });
    }
  }
}

export { copy as conversationCopy };
