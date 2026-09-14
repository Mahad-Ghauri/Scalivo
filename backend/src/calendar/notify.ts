import type { Redis } from 'ioredis';
import type { MessagingProvider } from '@scalivo/shared';
import { Business } from '../models/Business.js';
import { Client } from '../models/Client.js';
import { enqueue } from '../session-health/outbound-queue.js';
import { logger } from '../lib/logger.js';

/**
 * Telling a customer something they did not ask for a reply to.
 *
 * Every outbound message so far has been a REPLY: the inbound webhook carried
 * the session id and the address to answer on, and the router just handed them
 * back. An owner moving an appointment has neither — there is no inbound
 * message — so both have to be looked up, and either can be missing.
 *
 * Three things this deliberately does NOT do:
 *
 * - **It never throws.** A reschedule that already committed must not be
 *   reported as a failure because a message did not go out. The caller gets
 *   `false` and the app can show "moved — could not message the customer",
 *   which is the truth.
 * - **It does not prove delivery.** sendText returns accepted (FINDING #3).
 *   Ack-driven confirmation is Phase 1.8's job; this returns "handed over".
 * - **It does not check the marketing opt-out.** A reschedule is transactional:
 *   the customer has an appointment and the time changed. Suppressing that
 *   because they once replied STOP to a promotion is the worse failure, and is
 *   why the opt-out is scoped to marketing rather than to messaging.
 */

export interface NotifyDeps {
  redis: Redis;
  provider: MessagingProvider;
}

export async function notifyClient(
  deps: NotifyDeps,
  businessId: string,
  clientId: string,
  text: string,
): Promise<boolean> {
  try {
    const [business, client] = await Promise.all([
      Business.findById(businessId).select('whatsapp.sessionId'),
      Client.findById(clientId).select('lids phone'),
    ]);

    const sessionId = business?.whatsapp?.sessionId;
    if (!sessionId) {
      logger.warn({ businessId, clientId }, 'no WhatsApp session — cannot notify');
      return false;
    }

    // The LID first, for the same reason replies use it: it is the identifier
    // WhatsApp actually routes on, and the phone may never have resolved. A
    // walk-in the owner entered without a number has neither, and there is
    // genuinely no channel to reach them on.
    const to = client?.lids?.[0] ?? client?.phone;
    if (!to) {
      logger.info({ businessId, clientId }, 'client has no WhatsApp address — not notified');
      return false;
    }

    try {
      const sent = await deps.provider.sendText(sessionId, to, text);
      logger.info(
        { businessId, clientId, providerMessageId: sent.providerMessageId },
        'owner-initiated message accepted',
      );
      return true;
    } catch (err) {
      // The session is down. Queue rather than drop: the customer whose 3pm
      // moved to 4pm must hear about it when the session returns, not never.
      logger.error({ err, businessId, clientId }, 'notify failed — queueing for reconnect');
      await enqueue(deps.redis, businessId, { sessionId, to, text });
      return false;
    }
  } catch (err) {
    logger.error({ err, businessId, clientId }, 'could not notify the client');
    return false;
  }
}
