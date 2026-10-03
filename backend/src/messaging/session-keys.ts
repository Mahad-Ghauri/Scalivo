import { Business } from '../models/Business.js';
import { logger } from '../lib/logger.js';

/**
 * Where a business's own gateway credential is kept — milestone 4.2.
 *
 * The problem this closes: every tenant's WhatsApp went through ONE API key that
 * could reach every session. A key leaked from a log, an env dump or a
 * compromised process was a platform-wide incident — read anyone's sessions,
 * send as anyone. `businesses.whatsapp.apiKeyRef` was already in the schema,
 * already documented as "one scoped OpenWA key per business, never the shared
 * admin key", and read by nothing at all.
 *
 * Proven workable before being built: open-wa/NOTES.md FINDING #8. A key scoped
 * with `allowedSessions` answers 200 on its own session, 401 on another
 * business's — including on send — and, better than advertised, omits the other
 * session from `GET /api/sessions` entirely. A compromised tenant cannot even
 * enumerate who else is on the instance.
 *
 * **What this does not fix, stated plainly.** The keys live in Mongo, so a
 * database compromise still yields all of them. That is a smaller claim than it
 * sounds — anyone holding the database already holds every customer's phone
 * number — and the thing it buys is real: the admin key stops being the thing
 * in daily use, one business can be revoked without rotating everyone, and a key
 * leaked anywhere downstream reaches exactly one tenant. A secret manager is the
 * next step and does not exist yet; docs/data-handling.md records that.
 */

/** What the provider needs, and nothing more — so it can be faked in a test. */
export interface SessionKeyStore {
  /** The scoped key for this session, or null if it has none yet. */
  get(sessionId: string): Promise<string | null>;
  put(sessionId: string, apiKey: string): Promise<void>;
}

/**
 * Backed by the business that owns the session.
 *
 * Addressed by sessionId rather than businessId because that is all the
 * messaging layer knows — and all it should know. The provider is a transport;
 * teaching it about tenants would be the leak this file exists to prevent.
 */
export const businessSessionKeys: SessionKeyStore = {
  async get(sessionId) {
    const business = await Business.findOne({ 'whatsapp.sessionId': sessionId }).select(
      'whatsapp.apiKeyRef',
    );
    return business?.whatsapp?.apiKeyRef ?? null;
  },

  async put(sessionId, apiKey) {
    const result = await Business.updateOne(
      { 'whatsapp.sessionId': sessionId },
      { $set: { 'whatsapp.apiKeyRef': apiKey } },
    );

    if (result.matchedCount === 0) {
      // A session the gateway knows and we do not. Worth saying out loud: it
      // means a session was provisioned and its id never persisted, which is
      // the orphaned-Chromium-profile case onboarding/provision.ts guards.
      logger.warn({ sessionId }, 'no business owns this session — scoped key not stored');
    }
  },
};
