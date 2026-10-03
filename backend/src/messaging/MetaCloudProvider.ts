import type { MessagingProvider } from '@scalivo/shared';

/**
 * Meta WhatsApp Cloud API — deliberately unimplemented.
 *
 * It exists to prove the claim the architecture rests on: that swapping
 * providers is an env change, not a rewrite. If this file ever needs a field
 * that OpenWAProvider invented, the abstraction has leaked and the FSM, CRM,
 * retention engine and agent are all coupled to OpenWA.
 *
 * That matters beyond tidiness — upstream deems OpenWA unapproved for
 * commercial messaging, so a real migration path is a project risk control, not
 * a hypothetical.
 *
 * **Annotated `: MessagingProvider`, never cast.** The annotation is the whole
 * mechanism: add a method to the interface and this object stops compiling until
 * someone decides what Cloud API would do about it. A cast — including the one
 * a Proxy-based stub needs — silences that and leaves a file whose comments
 * claim a guarantee it no longer provides.
 */

class NotImplemented extends Error {
  constructor(method: string) {
    super(
      `MetaCloudProvider.${method} is not implemented. It is a stub proving the ` +
        `MessagingProvider abstraction holds; set MESSAGING_PROVIDER=openwa.`,
    );
    this.name = 'NotImplemented';
  }
}

const stub =
  (method: string) =>
  (): never => {
    throw new NotImplemented(method);
  };

export const MetaCloudProvider: MessagingProvider = {
  name: 'meta',

  sendText: stub('sendText'),
  getSessionStatus: stub('getSessionStatus'),

  // There is nothing to provision: Cloud API numbers are registered against a
  // verified business account through Meta's own console, and the "session id"
  // becomes a phone number id from configuration. Onboarding's Connect step
  // would be a different screen entirely — which is the honest answer, and
  // exactly what this stub is for.
  provisionSession: stub('provisionSession'),

  // One webhook per app, configured in Meta's console, not one per session.
  registerWebhook: stub('registerWebhook'),

  // Cloud API has no QR pairing at all — numbers are registered against a
  // verified business account instead. Worth remembering before anyone designs
  // a UI that assumes scanning.
  startSession: stub('startSession'),

  // Cloud API has no QR at all — a number is claimed through Meta's own console,
  // not by scanning. Null rather than a throw: "there is no code to show" is the
  // honest answer for this provider, not a failure.
  getSessionQr: async () => null,

  getSessionPhone: stub('getSessionPhone'),

  // Cloud API delivers real phone numbers inbound, so this becomes a no-op
  // rather than the fallback path it is on OpenWA.
  resolveContactPhone: stub('resolveContactPhone'),

  parseWebhook: stub('parseWebhook'),
};
