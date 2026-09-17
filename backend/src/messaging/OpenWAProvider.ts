import crypto from 'node:crypto';
import {
  ACK_STATUS,
  SESSION_STATUS,
  type AckStatus,
  type MessagingProvider,
  type ProviderEvent,
  type SendResult,
  type SessionStatus,
} from '@scalivo/shared';

/**
 * OpenWA v0.14.6.
 *
 * Every shape below was measured against a live session during the spike
 * (open-wa/NOTES.md + findings/webhooks.ndjson, 45 verified deliveries), not
 * read off upstream's docs. Where the two disagreed, the measurement won.
 */

/**
 * Every gateway call answers from memory and should be fast — a slow one here
 * means the gateway is in trouble, and waiting longer just moves the failure.
 */
const REQUEST_TIMEOUT_MS = 10_000;

/**
 * Except starting a session, which boots a Chromium profile and is the only
 * call whose honest cost is tens of seconds. See startSession for the
 * measurement that set this.
 */
const START_TIMEOUT_MS = 60_000;

/** The webhook envelope every delivery is wrapped in. */
interface Envelope {
  event: string;
  timestamp: string;
  sessionId: string;
  idempotencyKey: string;
  deliveryId: string;
  data: Record<string, unknown>;
}

export class OpenWAProvider implements MessagingProvider {
  readonly name = 'openwa';

  constructor(
    private readonly baseUrl: string,
    private readonly apiKey: string,
    private readonly webhookSecret: string,
  ) {}

  /**
   * Returns ACCEPTED, never delivered.
   *
   * The API answers `{messageId, timestamp}` whether or not the message ever
   * arrives — under upstream #830 WhatsApp silently drops first contact to a
   * brand-new number while still reporting success. Delivery is only proven by
   * a later message.ack reaching 'delivered'.
   */
  async sendText(sessionId: string, to: string, text: string): Promise<SendResult> {
    const res = await this.request<{ messageId: string; timestamp: number }>(
      `/api/sessions/${sessionId}/messages/send-text`,
      { method: 'POST', body: JSON.stringify({ chatId: toChatId(to), text }) },
    );
    return { providerMessageId: res.messageId, acceptedAt: new Date(res.timestamp * 1000) };
  }

  async getSessionStatus(sessionId: string): Promise<SessionStatus> {
    const res = await this.request<{ status: string }>(`/api/sessions/${sessionId}`);
    return toSessionStatus(res.status);
  }

  /**
   * `POST /api/sessions {name}` → `{id, status:"created"}`.
   *
   * The returned `id` is a UUID the gateway assigns; `name` is only a label.
   * The spike's own scripts stash it in `open-wa/.session-<name>` precisely
   * because the two are not interchangeable.
   */
  async provisionSession(name: string): Promise<{ sessionId: string; status: SessionStatus }> {
    const res = await this.request<{ id: string; status?: string }>('/api/sessions', {
      method: 'POST',
      body: JSON.stringify({ name }),
    });
    return { sessionId: res.id, status: toSessionStatus(str(res.status)) };
  }

  /** `POST /api/sessions/:id/webhooks {url, events, secret}`. */
  async registerWebhook(sessionId: string, url: string, secret: string): Promise<void> {
    await this.request(`/api/sessions/${sessionId}/webhooks`, {
      method: 'POST',
      body: JSON.stringify({
        url,
        secret,
        // session.qr is subscribed deliberately, not for completeness: it is the
        // EARLIEST death signal, ~4ms ahead of the status change (FINDING #2).
        events: [
          'message.received',
          'message.ack',
          'session.status',
          'session.qr',
          'session.authenticated',
          'session.disconnected',
        ],
      }),
    });
  }

  /**
   * Start (or resume) a session. After a container restart this recovers in
   * ~7s with no QR at all — the credentials live in the named volume. A QR
   * only comes back when the link is genuinely gone.
   */
  async startSession(sessionId: string): Promise<{ status: SessionStatus; qrCode?: string }> {
    const started = await this.request<{ status: string }>(
      `/api/sessions/${sessionId}/start`,
      { method: 'POST' },
      // The one call that boots a browser rather than answering from memory.
      // Measured cold on a first link: session created at 18:03:32.0, QR at
      // 18:03:43.9 — 11.9s, which the default 10s abort cut off by two seconds.
      // The session came up fine and the owner got "could not reach the
      // messaging gateway", so the timeout has to clear a cold Chromium start
      // with room to spare rather than sit near the measurement.
      START_TIMEOUT_MS,
    );
    const status = toSessionStatus(started.status);
    if (status !== SESSION_STATUS.QR_READY) return { status };

    const qr = await this.request<{ qrCode?: string }>(`/api/sessions/${sessionId}/qr`);
    return qr.qrCode ? { status, qrCode: qr.qrCode } : { status };
  }

  /**
   * The linked number, for the "message us here" link an owner puts on a poster.
   *
   * Swallows failures into null: not knowing the number is a cosmetic gap on one
   * screen, and throwing would turn it into a broken onboarding page.
   */
  async getSessionPhone(sessionId: string): Promise<string | null> {
    try {
      const res = await this.request<{ phone?: string }>(`/api/sessions/${sessionId}`);
      return res.phone ? res.phone.replace(/\D/g, '') : null;
    } catch {
      return null;
    }
  }

  /**
   * FINDING #1 fallback. Inbound payloads carry `senderPhone` only when OpenWA
   * runs with RESOLVE_LID_TO_PHONE=true, and even then it can be absent. This
   * endpoint works regardless, so it is the safety net that keeps an unresolved
   * contact from becoming a dropped message.
   */
  async resolveContactPhone(sessionId: string, contactLid: string): Promise<string | null> {
    try {
      const res = await this.request<{ phone?: string }>(
        `/api/sessions/${sessionId}/contacts/${encodeURIComponent(contactLid)}/phone`,
      );
      return res.phone ?? null;
    } catch {
      return null;
    }
  }

  /**
   * Verify and normalise one inbound delivery.
   *
   * Throws on a bad signature — the caller decides the HTTP response. Returns
   * an empty array for events we don't act on, which is not an error.
   */
  parseWebhook(rawBody: Buffer, headers: Record<string, string | undefined>): ProviderEvent[] {
    if (!verifySignature(rawBody, headers['x-openwa-signature'], this.webhookSecret)) {
      throw new InvalidSignatureError();
    }

    const envelope = JSON.parse(rawBody.toString('utf8')) as Envelope;
    const { event, sessionId, data } = envelope;
    const occurredAt = new Date(envelope.timestamp);

    switch (event) {
      case 'message.received': {
        // `from` is an @lid, never a phone number. See FINDING #1.
        const contactLid = str(data.from) ?? str(data.chatId) ?? '';
        const contact = (data.contact ?? {}) as { name?: string; pushName?: string };
        return [
          {
            kind: 'message',
            payload: {
              providerMessageId: str(data.id) ?? '',
              sessionId,
              contactPhone: str(data.senderPhone),
              contactLid,
              body: str(data.body) ?? '',
              type: str(data.type) ?? 'unknown',
              // OpenWA sends epoch SECONDS here, unlike the envelope's ISO string.
              receivedAt: new Date(Number(data.timestamp ?? 0) * 1000),
              fromMe: Boolean(data.fromMe),
              isGroup: Boolean(data.isGroup),
              displayName: contact.name ?? contact.pushName ?? null,
              hasMedia: Boolean(data.hasMedia),
            },
          },
        ];
      }

      case 'message.ack':
        return [
          {
            kind: 'ack',
            payload: {
              providerMessageId: str(data.messageId) ?? str(data.id) ?? '',
              sessionId,
              status: toAckStatus(str(data.status)),
              occurredAt,
            },
          },
        ];

      case 'session.status':
        return [
          {
            kind: 'session-status',
            payload: { sessionId, status: toSessionStatus(str(data.status)), occurredAt },
          },
        ];

      // Arrives ~4ms BEFORE the status change, making it the earliest signal
      // that a session died. Session Health treats an unsolicited one as the
      // same alarm as an unsolicited qr_ready.
      case 'session.qr':
        return [
          { kind: 'session-qr', payload: { sessionId, qrCode: str(data.qr) ?? '', occurredAt } },
        ];

      default:
        return [];
    }
  }

  private async request<T>(
    path: string,
    init: RequestInit = {},
    timeoutMs = REQUEST_TIMEOUT_MS,
  ): Promise<T> {
    const res = await fetch(new URL(path, this.baseUrl), {
      ...init,
      headers: {
        'X-API-Key': this.apiKey,
        'Content-Type': 'application/json',
        ...init.headers,
      },
      signal: AbortSignal.timeout(timeoutMs),
    });

    if (!res.ok) {
      throw new Error(`OpenWA ${init.method ?? 'GET'} ${path} failed: ${res.status}`);
    }
    return (await res.json()) as T;
  }
}

export class InvalidSignatureError extends Error {
  constructor() {
    super('X-OpenWA-Signature did not verify');
    this.name = 'InvalidSignatureError';
  }
}

/**
 * HMAC-SHA256 over the RAW request bytes.
 *
 * Verifying against a re-serialized parse drifts on key order and unicode
 * escaping, so the caller must hand over the untouched buffer. Lifted from the
 * spike receiver, which verified VALID on all 45 deliveries.
 */
export function verifySignature(
  rawBody: Buffer,
  header: string | undefined,
  secret: string,
): boolean {
  if (!header) return false;

  const expected = 'sha256=' + crypto.createHmac('sha256', secret).update(rawBody).digest('hex');
  const a = Buffer.from(header);
  const b = Buffer.from(expected);
  // timingSafeEqual throws on a length mismatch, so check that first.
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/**
 * Both addressing forms work on send — the gateway normalises a phone chatId to
 * the contact's LID either way. A LID we already hold is passed through
 * untouched; a bare phone number becomes `<e164-no-plus>@c.us`.
 */
function toChatId(to: string): string {
  return to.includes('@') ? to : `${to.replace(/\D/g, '')}@c.us`;
}

function str(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function toSessionStatus(value: string | null): SessionStatus {
  const known = Object.values(SESSION_STATUS) as string[];
  return known.includes(value ?? '') ? (value as SessionStatus) : SESSION_STATUS.FAILED;
}

function toAckStatus(value: string | null): AckStatus {
  const known = Object.values(ACK_STATUS) as string[];
  return known.includes(value ?? '') ? (value as AckStatus) : ACK_STATUS.PENDING;
}
