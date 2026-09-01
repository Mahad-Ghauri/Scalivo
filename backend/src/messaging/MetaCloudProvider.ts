import type { MessagingProvider, ProviderEvent, SendResult, SessionStatus } from '@scalivo/shared';

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
 */
export class MetaCloudProvider implements MessagingProvider {
  readonly name = 'meta';

  sendText(): Promise<SendResult> {
    throw new NotImplemented('sendText');
  }

  getSessionStatus(): Promise<SessionStatus> {
    throw new NotImplemented('getSessionStatus');
  }

  startSession(): Promise<{ status: SessionStatus; qrCode?: string }> {
    // Cloud API has no QR pairing at all — numbers are registered against a
    // verified business account instead. Worth remembering before anyone
    // designs a UI that assumes scanning.
    throw new NotImplemented('startSession');
  }

  resolveContactPhone(): Promise<string | null> {
    // Cloud API delivers real phone numbers inbound, so this becomes a no-op
    // rather than the fallback path it is on OpenWA.
    throw new NotImplemented('resolveContactPhone');
  }

  parseWebhook(): ProviderEvent[] {
    throw new NotImplemented('parseWebhook');
  }
}

class NotImplemented extends Error {
  constructor(method: string) {
    super(
      `MetaCloudProvider.${method} is not implemented. It is a stub proving the ` +
        `MessagingProvider abstraction holds; set MESSAGING_PROVIDER=openwa.`,
    );
    this.name = 'NotImplemented';
  }
}
