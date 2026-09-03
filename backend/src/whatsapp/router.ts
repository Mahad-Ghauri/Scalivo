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
      await persist(deps.redis, businessId, clientId, command.conversation);
      await reply(deps, message, businessId, clientId, command.replies);

      if (command.notifyOwner) {
        // Phase 1.2 owns the FCM path; until it exists the log IS the alert, and
        // saying so is better than a silent no-op that looks implemented.
        logger.warn({ businessId, clientId }, 'customer asked for a human — owner alert pending 1.2');
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

    await persist(deps.redis, businessId, clientId, result.conversation);
    await reply(deps, message, businessId, clientId, result.replies);
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
 * A send that throws is logged, not rethrown: the webhook has already been
 * acked, and failing here would only lose the state we just wrote. When 1.2
 * lands, this is where the outbound queue goes.
 */
async function reply(
  deps: RouterDeps,
  message: InboundMessage,
  businessId: string,
  clientId: string,
  replies: string[],
): Promise<void> {
  for (const text of replies) {
    if (!text) continue;
    try {
      const sent = await deps.provider.sendText(message.sessionId, message.contactLid, text);
      // ACCEPTED, not delivered (FINDING #3). Only a message.ack reaching
      // 'delivered' proves it arrived.
      logger.info(
        { businessId, clientId, providerMessageId: sent.providerMessageId },
        'outbound message accepted',
      );
    } catch (err) {
      logger.error({ err, businessId, clientId }, 'failed to send a reply');
    }
  }
}

export { copy as conversationCopy };
