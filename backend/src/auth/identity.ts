import type { InboundMessage, MessagingProvider } from '@scalivo/shared';
import { Client } from '../models/Client.js';
import { logger } from '../lib/logger.js';

/**
 * Turning an inbound WhatsApp message into a customer identity.
 *
 * SPIKE FINDING #1: `data.from` is an opaque `@lid`, not a phone number and not
 * derivable from one. The phone arrives as `senderPhone`, which exists only
 * when OpenWA runs with RESOLVE_LID_TO_PHONE=true — and can still be missing.
 *
 * So resolution has three outcomes, and the third one must not lose the
 * message: eager (senderPhone), fallback (on-demand lookup), or unmatched (a
 * client keyed on the LID alone, mergeable later).
 */

/** Pure decision step — no database, so the fallback path is directly testable. */
export async function resolvePhone(
  provider: MessagingProvider,
  message: InboundMessage,
): Promise<string | null> {
  if (message.contactPhone) return message.contactPhone;
  if (!message.contactLid) return null;

  const resolved = await provider.resolveContactPhone(message.sessionId, message.contactLid);
  if (!resolved) {
    logger.warn(
      { lid: message.contactLid, sessionId: message.sessionId },
      'could not resolve LID to a phone — creating an unmatched contact',
    );
  }
  return resolved;
}

/**
 * Find or create the client an inbound message belongs to.
 *
 * Matching is by LID first because that is the only identifier every inbound
 * message carries. When a phone later resolves for a LID we already know, it is
 * backfilled onto the same client rather than creating a second one.
 */
export async function upsertClientFromMessage(
  provider: MessagingProvider,
  message: InboundMessage,
) {
  const phone = await resolvePhone(provider, message);

  const existing =
    (await Client.findOne({ lids: message.contactLid })) ??
    (phone ? await Client.findOne({ phone }) : null);

  if (!existing) {
    return Client.create({
      phone,
      lids: [message.contactLid],
      displayName: message.displayName,
    });
  }

  // Backfill whatever this message taught us, without clobbering known values.
  if (phone && !existing.phone) existing.phone = phone;
  if (!existing.lids.includes(message.contactLid)) existing.lids.push(message.contactLid);
  if (message.displayName && !existing.displayName) existing.displayName = message.displayName;

  return existing.isModified() ? existing.save() : existing;
}
