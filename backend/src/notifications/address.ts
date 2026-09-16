import { Business } from '../models/Business.js';
import { Client } from '../models/Client.js';

/**
 * Where to send something nobody asked for.
 *
 * A reply is easy: the inbound webhook carried both the session to answer on and
 * the address to answer to. A confirmation, a reminder and a reschedule notice
 * have neither — nothing inbound triggered them — so both have to be looked up,
 * and either can legitimately be missing.
 *
 * One implementation, used by all three. Two would drift, and the way they would
 * drift is in which identifier wins: the LID is what WhatsApp actually routes on
 * and is present for anyone who has ever messaged the business, while the phone
 * is what the owner typed for a walk-in and may never have resolved. Picking
 * them in a different order in different files would mean the same customer got
 * reached on one path and not another.
 */

export interface Address {
  sessionId: string;
  /** A LID (`…@lid`) or a bare E.164 without '+'. The provider accepts both. */
  to: string;
}

export const ADDRESS_MISSING = {
  /** The business has never linked a number, or has been unlinked. */
  NO_SESSION: 'no_session',
  /** A walk-in the owner entered with a name and nothing else. Not an error. */
  NO_ADDRESS: 'no_address',
} as const;

export type AddressMissing = (typeof ADDRESS_MISSING)[keyof typeof ADDRESS_MISSING];

export async function resolveAddress(
  businessId: string,
  clientId: string,
): Promise<{ ok: true; address: Address } | { ok: false; reason: AddressMissing }> {
  const [business, client] = await Promise.all([
    Business.findById(businessId).select('whatsapp.sessionId'),
    Client.findById(clientId).select('lids phone'),
  ]);

  const sessionId = business?.whatsapp?.sessionId;
  if (!sessionId) return { ok: false, reason: ADDRESS_MISSING.NO_SESSION };

  // The LID first — see the note above. A phone-less, LID-less client is a
  // walk-in with a name on a piece of paper, and there is genuinely no channel.
  const to = client?.lids?.[0] ?? client?.phone;
  if (!to) return { ok: false, reason: ADDRESS_MISSING.NO_ADDRESS };

  return { ok: true, address: { sessionId, to } };
}
