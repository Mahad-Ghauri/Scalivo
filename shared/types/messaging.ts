import type { SessionStatus } from '../constants/session-status.js';

/**
 * Normalised inbound message — provider-independent.
 *
 * Field mapping to OpenWA is recorded in open-wa/NOTES.md ("Field mapping to our
 * domain model"). The two that bite:
 *
 *   - `data.from` is NOT a phone number (FINDING #1)
 *   - `data.timestamp` is epoch SECONDS, not milliseconds
 */
export interface InboundMessage {
  /** OpenWA `data.id`. Unique per message. */
  providerMessageId: string;

  /** Envelope `.sessionId` — NOT inside `data`. Routes to a business. */
  sessionId: string;

  /**
   * SPIKE FINDING #1 — the customer's phone in E.164, WITHOUT the leading '+'.
   *
   * Comes from `data.senderPhone`, which only exists when OpenWA runs with
   * RESOLVE_LID_TO_PHONE=true. It is NOT `data.from`, which is an opaque LID.
   *
   * Null when resolution failed. A null here must degrade to an unmatched-contact
   * row, never a dropped message — see resolveIdentity() in the backend.
   */
  contactPhone: string | null;

  /**
   * `data.from` / `data.chatId` — e.g. "1774039625903@lid".
   *
   * WhatsApp's linked identity: opaque, per-account, and NOT derivable from a
   * phone number. Always present, always stored, and it is what replies address.
   * This is the stable routing id even when contactPhone is null.
   */
  contactLid: string;

  body: string;
  /** OpenWA `data.type` — 'text', 'image', 'audio', ... */
  type: string;
  /** Already converted from OpenWA's epoch seconds. */
  receivedAt: Date;
  fromMe: boolean;
  isGroup: boolean;
  /** `data.contact.name` (saved) ?? `data.contact.pushName` (self-set). */
  displayName: string | null;
  hasMedia: boolean;
}

/**
 * The result of asking a provider to send.
 *
 * SPIKE FINDING #3: OpenWA returns `{messageId, timestamp}` whether or not the
 * message is ever delivered. Under upstream issue #830 WhatsApp silently drops
 * first-contact messages to brand-new contacts while the API still reports
 * success.
 *
 * So this type deliberately has no `delivered` field. It means ACCEPTED. Real
 * delivery arrives later, as a MessageAck reaching 'delivered'. Anything
 * user-visible or metric-bearing must key on the ack, never on this.
 */
export interface SendResult {
  providerMessageId: string;
  acceptedAt: Date;
}

/** Ack progression. Only 'delivered' and 'read' prove the message arrived. */
export const ACK_STATUS = {
  PENDING: 'pending',
  SENT: 'sent',
  DELIVERED: 'delivered',
  READ: 'read',
  FAILED: 'failed',
} as const;

export type AckStatus = (typeof ACK_STATUS)[keyof typeof ACK_STATUS];

export interface MessageAck {
  providerMessageId: string;
  sessionId: string;
  status: AckStatus;
  occurredAt: Date;
}

export interface SessionStatusEvent {
  sessionId: string;
  status: SessionStatus;
  occurredAt: Date;
}

/** A QR arriving unsolicited is the earliest possible death signal (~4ms before the status). */
export interface SessionQrEvent {
  sessionId: string;
  /** PNG data URL, renderable directly by the Flutter app. */
  qrCode: string;
  occurredAt: Date;
}

export type ProviderEvent =
  | { kind: 'message'; payload: InboundMessage }
  | { kind: 'ack'; payload: MessageAck }
  | { kind: 'session-status'; payload: SessionStatusEvent }
  | { kind: 'session-qr'; payload: SessionQrEvent };

/**
 * Every WhatsApp I/O goes through this. Nothing above this layer may know which
 * provider is live — enforced by a no-restricted-imports rule in eslint.config.js.
 */
export interface MessagingProvider {
  readonly name: string;

  /** Returns ACCEPTED, not delivered. See SendResult. */
  sendText(sessionId: string, to: string, text: string): Promise<SendResult>;

  getSessionStatus(sessionId: string): Promise<SessionStatus>;

  /** Creates the session if needed and returns a QR when one is required. */
  startSession(sessionId: string): Promise<{ status: SessionStatus; qrCode?: string }>;

  /**
   * FINDING #1 fallback path: resolve a LID to a phone on demand. Works
   * regardless of RESOLVE_LID_TO_PHONE, so it covers the case where
   * `senderPhone` is missing from a payload.
   */
  resolveContactPhone(sessionId: string, contactLid: string): Promise<string | null>;

  /** Parse + verify a raw inbound webhook into normalised events. */
  parseWebhook(rawBody: Buffer, headers: Record<string, string | undefined>): ProviderEvent[];
}
