import { randomBytes } from 'node:crypto';
import { ClientProfile } from '../models/ClientProfile.js';
import { logger } from '../lib/logger.js';

/**
 * The key to a customer's own page, and the one genuinely awkward decision in
 * milestone 3.3.
 *
 * **It does not expire.** That is not laziness about session management; it is
 * what the feature is. The page is meant to be installed to a home screen and
 * opened months later, and an icon that opens a dead page is worse than no icon.
 * A customer with no account cannot re-authenticate, so an expiring token would
 * have to be re-issued over WhatsApp on every visit — which means either the
 * business messages them unprompted (the one behaviour most likely to get the
 * number restricted — NOTES.md) or the installed shortcut simply stops working.
 *
 * So this is a durable bearer credential sitting in a chat thread, and the
 * honest thing is to say what that costs and bound it:
 *
 * - **Scope.** One token, one relationship (see ClientProfile.meToken). The
 *   worst case is one business's view of one customer, never a platform account.
 * - **Reach.** It reads appointments and a spend total, and it can book and rate
 *   as that customer. It cannot cancel, cannot move money, cannot change a phone
 *   number, and cannot see another customer. A booking it makes appears on the
 *   owner's calendar like any other, so abuse is visible rather than silent.
 * - **Entropy.** 192 bits from `randomBytes`. Not guessable, and not derived
 *   from the client or business id — a token must not let its holder work out
 *   who else exists.
 * - **Revocation.** Overwriting the field invalidates the old URL. There is no
 *   button for that yet, deliberately: nobody has asked for one, and the field
 *   is what makes it a five-line change when they do.
 * - **Not in logs.** The routes that take it must never log the path. See the
 *   `/me` handlers in public/routes.ts.
 *
 * What would replace it properly is a WhatsApp OTP — the same fix the web
 * booking path needs for its unverified phone number — and that is the right
 * place to solve it once, for both.
 */

/** 24 bytes, base64url: 32 URL-safe characters, no escaping anywhere. */
const TOKEN_BYTES = 24;

/** Shape check for a token arriving from a URL, so a malformed one never reaches a query. */
export const ME_TOKEN_PATTERN = /^[A-Za-z0-9_-]{32}$/;

export const newMeToken = (): string => randomBytes(TOKEN_BYTES).toString('base64url');

/**
 * The token for this relationship, minting one if it has none.
 *
 * Idempotent by the upsert-shaped update: `$setOnInsert` is no use here because
 * the profile already exists, so the guard is the filter — only a profile whose
 * token is still absent gets written, and a second concurrent caller matches
 * nothing and reads back the winner's value.
 *
 * Returns null when there is no profile, which means the customer has never
 * booked with this business. That is not an error: there is nothing for the page
 * to show, and minting a token would hand out a link to an empty page.
 */
export async function meTokenFor(businessId: string, clientId: string): Promise<string | null> {
  const existing = await ClientProfile.findOne({ businessId, clientId }).select('meToken');
  if (!existing) return null;
  if (existing.meToken) return existing.meToken;

  const token = newMeToken();
  const claimed = await ClientProfile.findOneAndUpdate(
    { businessId, clientId, meToken: null },
    { $set: { meToken: token } },
    { new: true },
  ).select('meToken');

  if (claimed?.meToken) return claimed.meToken;

  // Lost the race: somebody else minted one between the read and the write.
  const winner = await ClientProfile.findOne({ businessId, clientId }).select('meToken');
  return winner?.meToken ?? null;
}

/**
 * Who a token belongs to, or null.
 *
 * The single place a token becomes an identity. Every /me handler starts here
 * and then works only from what this returned — no handler takes a businessId or
 * a clientId from the request, which is what makes the surface incapable of
 * reading across tenants rather than merely careful not to.
 */
export async function resolveMeToken(
  token: string,
): Promise<{ businessId: string; clientId: string } | null> {
  if (!ME_TOKEN_PATTERN.test(token)) return null;

  const profile = await ClientProfile.findOne({ meToken: token }).select('businessId clientId');
  if (!profile) {
    // No token in the log line: it is a credential, and this is the one place
    // tempted to print it.
    logger.debug('a /me token matched no profile');
    return null;
  }

  return { businessId: profile.businessId, clientId: profile.clientId };
}
