import crypto from 'node:crypto';
import type { AddressInfo } from 'node:net';
import express from 'express';
import type { ProviderEvent } from '@scalivo/shared';
import { afterEach, describe, expect, it } from 'vitest';
import { InvalidSignatureError, OpenWAProvider, verifySignature } from '../src/messaging/OpenWAProvider.js';
import { createWebhookRouter, type DedupeStore } from '../src/messaging/webhook.js';

const SECRET = 'test-webhook-secret-value';
const SESSION = '83444661-0542-4064-8fa4-06d129a7e30c';
const provider = new OpenWAProvider('http://localhost:2785', 'owa_k1_test', SECRET);

/** Envelope + signature exactly as OpenWA sends them. */
function delivery(event: string, data: Record<string, unknown>) {
  const raw = Buffer.from(
    JSON.stringify({
      event,
      timestamp: '2026-08-08T17:27:01.275Z',
      sessionId: SESSION,
      idempotencyKey: `${event}_${SESSION}_x`,
      deliveryId: 'dlv_ed2250aa',
      data,
    }),
  );
  const sig = 'sha256=' + crypto.createHmac('sha256', SECRET).update(raw).digest('hex');
  return { raw, headers: { 'x-openwa-signature': sig } };
}

// The real inbound payload recorded during the spike.
const INBOUND = {
  id: 'false_1774039625903@lid_3A2C98539D95FAFC1FF9',
  from: '1774039625903@lid',
  to: '923209263011@c.us',
  chatId: '1774039625903@lid',
  body: 'This is a test message',
  type: 'text',
  timestamp: 1786210021,
  fromMe: false,
  isGroup: false,
  contact: { pushName: '🌼', name: 'Ghauri' },
};

describe('signature verification', () => {
  it('accepts a signature computed over the raw bytes', () => {
    const { raw, headers } = delivery('message.received', INBOUND);
    expect(verifySignature(raw, headers['x-openwa-signature'], SECRET)).toBe(true);
  });

  it('rejects a tampered body', () => {
    const { headers } = delivery('message.received', INBOUND);
    const tampered = Buffer.from(JSON.stringify({ event: 'message.received', data: {} }));
    expect(verifySignature(tampered, headers['x-openwa-signature'], SECRET)).toBe(false);
  });

  it('rejects a missing signature rather than throwing', () => {
    const { raw } = delivery('message.received', INBOUND);
    expect(verifySignature(raw, undefined, SECRET)).toBe(false);
  });

  it('rejects a wrong-length signature without throwing', () => {
    // timingSafeEqual throws on length mismatch — the length pre-check matters.
    const { raw } = delivery('message.received', INBOUND);
    expect(() => verifySignature(raw, 'sha256=deadbeef', SECRET)).not.toThrow();
    expect(verifySignature(raw, 'sha256=deadbeef', SECRET)).toBe(false);
  });
});

describe('parsing inbound messages', () => {
  it('takes the phone from senderPhone, never from `from`', () => {
    const { raw, headers } = delivery('message.received', {
      ...INBOUND,
      senderPhone: '923102027781',
    });
    const [event] = provider.parseWebhook(raw, headers);

    expect(event?.kind).toBe('message');
    if (event?.kind !== 'message') throw new Error('wrong kind');
    expect(event.payload.contactPhone).toBe('923102027781');
    expect(event.payload.contactLid).toBe('1774039625903@lid');
  });

  it('degrades to a null phone but keeps the LID when resolution failed', () => {
    // RESOLVE_LID_TO_PHONE off, or a lookup that missed. This must stay a
    // processable message — an unmatched contact, never a dropped one.
    const { raw, headers } = delivery('message.received', INBOUND);
    const [event] = provider.parseWebhook(raw, headers);

    if (event?.kind !== 'message') throw new Error('wrong kind');
    expect(event.payload.contactPhone).toBeNull();
    expect(event.payload.contactLid).toBe('1774039625903@lid');
  });

  it('converts the epoch-SECONDS timestamp to milliseconds', () => {
    const { raw, headers } = delivery('message.received', INBOUND);
    const [event] = provider.parseWebhook(raw, headers);

    if (event?.kind !== 'message') throw new Error('wrong kind');
    expect(event.payload.receivedAt.getTime()).toBe(1786210021 * 1000);
    // Read as milliseconds this would land in 1970.
    expect(event.payload.receivedAt.getUTCFullYear()).toBeGreaterThan(2020);
  });

  it('prefers the saved contact name over the self-set pushName', () => {
    const { raw, headers } = delivery('message.received', INBOUND);
    const [event] = provider.parseWebhook(raw, headers);

    if (event?.kind !== 'message') throw new Error('wrong kind');
    expect(event.payload.displayName).toBe('Ghauri');
  });

  it('throws InvalidSignatureError before parsing anything', () => {
    const { raw } = delivery('message.received', INBOUND);
    expect(() => provider.parseWebhook(raw, { 'x-openwa-signature': 'sha256=wrong' })).toThrow(
      InvalidSignatureError,
    );
  });
});

describe('parsing other events', () => {
  it('reads a delivery ack', () => {
    const { raw, headers } = delivery('message.ack', {
      id: 'true_120363166512227267@g.us_ACBFD8',
      messageId: 'true_120363166512227267@g.us_ACBFD8',
      status: 'delivered',
      ack: 2,
    });
    const [event] = provider.parseWebhook(raw, headers);

    if (event?.kind !== 'ack') throw new Error('wrong kind');
    expect(event.payload.status).toBe('delivered');
  });

  it('reads the qr_ready status that a phone-side unlink actually produces', () => {
    // The spike measured zero `disconnected` events on unlink — it goes
    // straight to qr_ready, which is what Session Health alarms on.
    const { raw, headers } = delivery('session.status', {
      sessionId: SESSION,
      status: 'qr_ready',
    });
    const [event] = provider.parseWebhook(raw, headers);

    if (event?.kind !== 'session-status') throw new Error('wrong kind');
    expect(event.payload.status).toBe('qr_ready');
  });

  it('reads a QR event, the earliest death signal', () => {
    const { raw, headers } = delivery('session.qr', {
      sessionId: SESSION,
      qr: 'data:image/png;base64,iVBORw0KGgo',
    });
    const [event] = provider.parseWebhook(raw, headers);

    if (event?.kind !== 'session-qr') throw new Error('wrong kind');
    expect(event.payload.qrCode).toContain('data:image/png');
  });

  it('ignores events it has no use for', () => {
    const { raw, headers } = delivery('session.authenticated', { sessionId: SESSION, phone: '92' });
    expect(provider.parseWebhook(raw, headers)).toEqual([]);
  });
});

describe('the webhook route', () => {
  const servers: ReturnType<express.Express['listen']>[] = [];
  afterEach(() => servers.forEach((s) => s.close()));

  async function post(
    body: Buffer,
    headers: Record<string, string>,
    dedupe: DedupeStore,
    seen: ProviderEvent[],
  ) {
    const app = express();
    app.use(
      '/webhooks',
      createWebhookRouter({
        provider,
        dedupe,
        onEvent: async (e) => void seen.push(e),
      }),
    );
    const server = app.listen(0);
    servers.push(server);
    const { port } = server.address() as AddressInfo;

    return fetch(`http://127.0.0.1:${port}/webhooks/whatsapp`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: body as unknown as BodyInit,
    });
  }

  const alwaysNew: DedupeStore = { isFirstDelivery: async () => true };

  it('acks 200 and dispatches a valid delivery', async () => {
    const { raw, headers } = delivery('message.received', INBOUND);
    const seen: ProviderEvent[] = [];

    const res = await post(raw, { 'X-OpenWA-Signature': headers['x-openwa-signature'] }, alwaysNew, seen);

    expect(res.status).toBe(200);
    await vi_tick();
    expect(seen).toHaveLength(1);
  });

  it('answers 401 and dispatches nothing when the secret is wrong', async () => {
    const { raw } = delivery('message.received', INBOUND);
    const seen: ProviderEvent[] = [];

    const res = await post(raw, { 'X-OpenWA-Signature': 'sha256=wrong' }, alwaysNew, seen);

    expect(res.status).toBe(401);
    await vi_tick();
    expect(seen).toHaveLength(0);
  });

  it('processes a retried delivery only once', async () => {
    // At-least-once delivery: the same idempotency key arrives again with a
    // fresh deliveryId. Without this, one customer message advances the FSM twice.
    const { raw, headers } = delivery('message.received', INBOUND);
    const keys = new Set<string>();
    const dedupe: DedupeStore = {
      isFirstDelivery: async (key) => (keys.has(key) ? false : (keys.add(key), true)),
    };
    const seen: ProviderEvent[] = [];
    const sent = {
      'X-OpenWA-Signature': headers['x-openwa-signature'] as string,
      'X-OpenWA-Idempotency-Key': 'msg_session_abc',
    };

    await post(raw, sent, dedupe, seen);
    await vi_tick();
    await post(raw, { ...sent, 'X-OpenWA-Delivery-Id': 'dlv_a_different_one' }, dedupe, seen);
    await vi_tick();

    expect(seen).toHaveLength(1);
  });
});

/** The handler acks before dispatching, so give the async tail a turn to run. */
function vi_tick() {
  return new Promise((resolve) => setTimeout(resolve, 20));
}
