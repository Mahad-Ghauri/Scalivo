import { Client } from '../models/Client.js';
import { normalisePhone } from '../lib/phone.js';
import { logger } from '../lib/logger.js';

/**
 * Find the person, or make them. Shared by every path that learns about a
 * customer from something other than WhatsApp — a walk-in at the desk, a web
 * booking.
 *
 * Matching on the phone is the whole point. A regular who has messaged on
 * WhatsApp already exists as a Client keyed on the number WhatsApp reported, and
 * creating a second row here would split their visit history in two with
 * nothing on screen to say so. normalisePhone is what makes a typed `0320…` and
 * WhatsApp's `92320…` the same key.
 *
 * Returns null when there is nothing to key a person on at all.
 */
export async function findOrCreateClient(input: {
  phone?: string | undefined;
  name?: string | undefined;
  /** For the log line — which surface created them. */
  via: 'walk-in' | 'web';
}): Promise<string | null> {
  const phone = input.phone ? normalisePhone(input.phone) : null;
  const name = input.name?.trim() || null;

  // A nameless, numberless customer is not a customer, it is an empty row.
  if (!phone && !name) return null;

  if (phone) {
    const matched = await Client.findOne({ phone });
    if (matched) {
      // Backfill a name we did not have. Never overwrite one we did — WhatsApp's
      // display name is the customer's own, and a typed name is not an
      // improvement on it. On the web this also means a stranger typing
      // someone else's number cannot rename them.
      if (name && !matched.displayName) {
        matched.displayName = name;
        await matched.save();
      }
      return String(matched._id);
    }
  }

  // No phone means the partial unique index lets this coexist with every other
  // phone-less client — which is exactly why that index is partial and not
  // sparse. See the note on the Client model.
  const created = await Client.create({ phone, displayName: name });
  logger.info({ clientId: String(created._id), hasPhone: Boolean(phone), via: input.via }, 'client created');
  return String(created._id);
}
