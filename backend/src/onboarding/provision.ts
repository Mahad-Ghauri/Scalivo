import {
  SESSION_INTENT,
  SESSION_STATUS,
  type MessagingProvider,
  type SessionStatus,
} from '@scalivo/shared';
import { Business } from '../models/Business.js';
import { env } from '../config/env.js';
import { logger } from '../lib/logger.js';

/**
 * Giving a business its own WhatsApp session. This is what `link-session.ts`
 * existed to fake by hand.
 *
 * Two properties the implementation is built around:
 *
 * 1. **It must be resumable, never repeatable.** On OpenWA a session is a
 *    ~90 MB Chromium profile in a named volume, and the measured ceiling is
 *    about two per instance (777 MiB RAM each). A second call that created a
 *    second session would strand the first: running, consuming the budget for a
 *    whole other business, and reachable by nobody. So the id is persisted the
 *    instant the gateway returns it — before anything that can still fail — and
 *    every later call picks up from there.
 *
 * 2. **Webhook registration comes before start.** The gateway begins emitting
 *    the moment a session starts, and the `session.authenticated` that follows
 *    the owner's scan is the event that tells us onboarding worked. Registering
 *    afterwards leaves a window where that event is emitted into nothing, and
 *    the owner scans a QR that appears to do nothing at all.
 *
 * Intent is flipped to LINKING before the provider is called, for the reason
 * spelled out in businesses/routes.ts: a `qr_ready` we caused and one meaning a
 * session just died are byte-identical on the wire (SPIKE FINDING #2), and
 * intent is the only thing separating them. Setting it afterwards leaves a
 * window in which our own QR pages the owner about an outage.
 */

export type ProvisionFailure =
  | 'not_found'
  | 'already_linked'
  | 'gateway_unreachable'
  | 'webhook_rejected'
  | 'session_taken';

export type ProvisionResult =
  | { ok: true; sessionId: string; status: SessionStatus; qrCode: string | null }
  | { ok: false; reason: ProvisionFailure };

export interface ProvisionDeps {
  provider: MessagingProvider;
}

export async function provisionSession(
  deps: ProvisionDeps,
  businessId: string,
  options: { force?: boolean } = {},
): Promise<ProvisionResult> {
  const business = await Business.findById(businessId);
  if (!business) return { ok: false, reason: 'not_found' };

  const existing = business.whatsapp?.sessionId ?? null;

  // A live session is not something to replace on a stray tap. Re-linking a
  // working number means logging the owner's phone out of it, so it takes an
  // explicit force — and even then we reuse the session rather than build one.
  if (existing && business.whatsapp?.status === SESSION_STATUS.READY && !options.force) {
    return { ok: false, reason: 'already_linked' };
  }

  await Business.updateOne(
    { _id: business._id },
    { $set: { 'whatsapp.intent': SESSION_INTENT.LINKING } },
  );

  let sessionId = existing;

  try {
    if (!sessionId) {
      // The label is for the gateway's own console. The id it answers with is
      // the only thing anything may key on.
      const created = await deps.provider.provisionSession(business.slug);
      sessionId = created.sessionId;

      // A session id belongs to exactly one business: the webhook routes purely
      // on sessionId, so two businesses sharing one would cross-route every
      // inbound message into the wrong salon's booking flow.
      const taken = await Business.findOne({
        'whatsapp.sessionId': sessionId,
        _id: { $ne: business._id },
      });
      if (taken) {
        logger.error({ businessId, sessionId, taken: taken.slug }, 'gateway reissued a session id');
        await stop(businessId);
        return { ok: false, reason: 'session_taken' };
      }

      // Persisted before the webhook and the start, either of which can fail.
      // Losing the id here is what orphans a Chromium profile forever.
      await Business.updateOne(
        { _id: business._id },
        {
          $set: {
            'whatsapp.sessionId': sessionId,
            'whatsapp.status': created.status,
            'whatsapp.lastStatusChange': new Date(),
          },
        },
      );
      logger.info({ businessId, sessionId }, 'session provisioned');
    }
  } catch (err) {
    logger.error({ err, businessId }, 'could not provision a session');
    await stop(businessId);
    return { ok: false, reason: 'gateway_unreachable' };
  }

  // The block above either assigns sessionId or returns, so this cannot happen.
  // It is here because the assignment is inside a try, which is more than the
  // compiler can follow — and an unchecked `!` would hide a real regression if
  // anyone ever added a path through.
  if (!sessionId) return { ok: false, reason: 'gateway_unreachable' };

  // Re-registering on a resumed session is deliberate and safe: we cannot tell
  // from here whether the previous attempt got this far, and a duplicate
  // registration costs nothing next to a session that delivers nothing.
  try {
    await deps.provider.registerWebhook(
      sessionId,
      new URL('/webhooks/whatsapp', env.PUBLIC_URL).toString(),
      env.OPENWA_WEBHOOK_SECRET,
    );
  } catch (err) {
    // The session exists and is recorded, so this is retryable rather than
    // fatal — but it must NOT fall through to start(). A started session with
    // no webhook is the silent failure this ordering exists to prevent.
    logger.error({ err, businessId, sessionId }, 'webhook registration rejected');
    await stop(businessId);
    return { ok: false, reason: 'webhook_rejected' };
  }

  try {
    const started = await deps.provider.startSession(sessionId);

    await Business.updateOne(
      { _id: business._id },
      {
        $set: {
          'whatsapp.status': started.status,
          'whatsapp.lastStatusChange': new Date(),
          // Already authenticated — a restart recovers with no QR at all
          // (spike proof #9), so there is nothing to scan and nothing to wait
          // for. Anything else stays LINKING until the scan lands.
          ...(started.status === SESSION_STATUS.READY
            ? { 'whatsapp.intent': SESSION_INTENT.LIVE }
            : {}),
        },
      },
    );

    return {
      ok: true,
      sessionId,
      status: started.status,
      qrCode: started.qrCode ?? null,
    };
  } catch (err) {
    logger.error({ err, businessId, sessionId }, 'could not start the session');
    await stop(businessId);
    return { ok: false, reason: 'gateway_unreachable' };
  }
}

/**
 * Park the session as deliberately-stopped after a failed attempt.
 *
 * Not cosmetic: while intent is LINKING, Session Health treats every QR and
 * every disconnect as expected and stays silent. Leaving a failed attempt in
 * LINKING would disarm the outage alarm for that business indefinitely.
 */
async function stop(businessId: string): Promise<void> {
  await Business.updateOne(
    { _id: businessId },
    { $set: { 'whatsapp.intent': SESSION_INTENT.STOPPED } },
  );
}

/**
 * The number customers should message, cached on first ask.
 *
 * Lazy rather than written on every recovery: this is read on one onboarding
 * screen, while onSessionReady() is on the outage-recovery hot path, and adding
 * a gateway round trip there would slow the thing that matters for the sake of
 * the thing that does not.
 */
export async function connectedPhone(
  deps: ProvisionDeps,
  businessId: string,
): Promise<string | null> {
  const business = await Business.findById(businessId);
  if (!business) return null;
  if (business.whatsapp?.phone) return business.whatsapp.phone;

  const sessionId = business.whatsapp?.sessionId;
  if (!sessionId) return null;

  const phone = await deps.provider.getSessionPhone(sessionId);
  if (!phone) return null;

  await Business.updateOne({ _id: business._id }, { $set: { 'whatsapp.phone': phone } });
  return phone;
}
