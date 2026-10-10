import { randomBytes } from 'node:crypto';
import { ClientProfile } from '../models/ClientProfile.js';
import { logger } from '../lib/logger.js';

/**
 * A private link scoped to one business/customer relationship.
 * New links expire after 180 days. A verified WhatsApp message can recover the
 * current link; owner or customer rotation immediately revokes the old one.
 * Sensitive writes additionally require a short-lived WhatsApp proof.
 * Legacy links receive the same expiry on their next authenticated use.
 * Existing installed shortcuts keep their token during migration. Never log tokens.
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
  const existing = await ClientProfile.findOne({ businessId, clientId })
    .select('meToken meTokenExpiresAt')
    .maxTimeMS(5000);
  if (!existing) return null;
  if (existing.meToken && !existing.meTokenExpiresAt)
    await ClientProfile.updateOne(
      { businessId, clientId, meToken: existing.meToken, meTokenExpiresAt: null },
      { $set: { meTokenExpiresAt: new Date(Date.now() + 180 * 86400000) } },
    ).maxTimeMS(5000);
  if (existing.meToken && (!existing.meTokenExpiresAt || existing.meTokenExpiresAt > new Date()))
    return existing.meToken;

  const token = newMeToken();
  const claimed = await ClientProfile.findOneAndUpdate(
    { businessId, clientId, $or: [{ meToken: null }, { meTokenExpiresAt: { $lte: new Date() } }] },
    { $set: { meToken: token, meTokenExpiresAt: new Date(Date.now() + 180 * 86400000) } },
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

  const profile = await ClientProfile.findOne({
    meToken: token,
    $or: [{ meTokenExpiresAt: null }, { meTokenExpiresAt: { $gt: new Date() } }],
  })
    .select('businessId clientId meTokenExpiresAt')
    .maxTimeMS(5000);
  if (!profile) {
    // No token in the log line: it is a credential, and this is the one place
    // tempted to print it.
    logger.debug('a /me token matched no profile');
    return null;
  }

  if (!profile.meTokenExpiresAt)
    await ClientProfile.updateOne(
      { _id: profile._id, meToken: token, meTokenExpiresAt: null },
      { $set: { meTokenExpiresAt: new Date(Date.now() + 180 * 86400000) } },
    ).maxTimeMS(5000);
  return { businessId: profile.businessId, clientId: profile.clientId };
}
