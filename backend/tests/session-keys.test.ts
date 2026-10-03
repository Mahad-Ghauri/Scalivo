import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { OpenWAProvider } from '../src/messaging/OpenWAProvider.js';
import type { SessionKeyStore } from '../src/messaging/session-keys.js';

/**
 * Per-business gateway keys — milestone 4.2.
 *
 * The behaviour under test is which CREDENTIAL leaves the process on each call,
 * so these assert on the `X-API-Key` header rather than on any response. Fetch
 * is stubbed: the gateway's half of this was proven against a real instance and
 * written up as open-wa/NOTES.md FINDING #8 (a scoped key answers 200 on its own
 * session, 401 on another's — including on send — and the other session vanishes
 * from the listing). Re-asserting that here would be testing OpenWA's auth code,
 * which is not ours. What IS ours is never sending the admin key where a scoped
 * one belongs, and recovering when scoping is impossible.
 */

const ADMIN = 'owa_k1_admin';
const SESSION = 'session-alpha';

interface Call {
  url: string;
  key: string | undefined;
  body: unknown;
}

let calls: Call[];
let mintedCount: number;

/** Answers the key-creation call with a fresh secret; everything else with `{}`. */
function stubFetch(options: { mintFails?: boolean } = {}) {
  return vi.fn(async (input: string | URL, init?: RequestInit) => {
    const url = String(input);
    const headers = (init?.headers ?? {}) as Record<string, string>;
    calls.push({
      url,
      key: headers['X-API-Key'],
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
    });

    if (url.includes('/api/auth/api-keys')) {
      mintedCount += 1;
      if (options.mintFails) {
        return new Response('forbidden', { status: 403 });
      }
      return Response.json({ id: 'k1', apiKey: `owa_k1_scoped_${mintedCount}` });
    }

    return Response.json({ messageId: 'm1', timestamp: 1_700_000_000, status: 'READY' });
  });
}

/** In-memory stand-in for the Mongo-backed store. */
function memoryStore(seed: Record<string, string> = {}): SessionKeyStore & { data: Map<string, string> } {
  const data = new Map(Object.entries(seed));
  return {
    data,
    async get(sessionId) {
      return data.get(sessionId) ?? null;
    },
    async put(sessionId, apiKey) {
      data.set(sessionId, apiKey);
    },
  };
}

const keyFor = (fragment: string) => calls.find((c) => c.url.includes(fragment))?.key;

beforeEach(() => {
  calls = [];
  mintedCount = 0;
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('per-business gateway keys', () => {
  it('mints a scoped key on first use and sends with it, not the admin key', async () => {
    vi.stubGlobal('fetch', stubFetch());
    const store = memoryStore();
    const provider = new OpenWAProvider('http://gw.test', ADMIN, 'secret', store);

    await provider.sendText(SESSION, '923001234567', 'hello');

    // The mint itself is the one call that legitimately carries the admin key.
    expect(keyFor('/api/auth/api-keys')).toBe(ADMIN);
    expect(keyFor('/messages/send-text')).toBe('owa_k1_scoped_1');
    expect(keyFor('/messages/send-text')).not.toBe(ADMIN);
  });

  it('scopes the key to exactly one session, with no power to mint more', async () => {
    vi.stubGlobal('fetch', stubFetch());
    const provider = new OpenWAProvider('http://gw.test', ADMIN, 'secret', memoryStore());

    await provider.sendText(SESSION, '923001234567', 'hello');
    const mint = calls.find((c) => c.url.includes('/api/auth/api-keys'))!;

    expect(mint.body).toMatchObject({ role: 'operator', allowedSessions: [SESSION] });
    // An admin key confined to one session could still mint itself a wider one.
    expect((mint.body as { role: string }).role).not.toBe('admin');
  });

  it('stores the key, because the gateway only ever returns it once', async () => {
    vi.stubGlobal('fetch', stubFetch());
    const store = memoryStore();
    const provider = new OpenWAProvider('http://gw.test', ADMIN, 'secret', store);

    await provider.sendText(SESSION, '923001234567', 'hello');

    expect(store.data.get(SESSION)).toBe('owa_k1_scoped_1');
  });

  it('reuses a stored key instead of minting a second one', async () => {
    vi.stubGlobal('fetch', stubFetch());
    const store = memoryStore({ [SESSION]: 'owa_k1_already_mine' });
    const provider = new OpenWAProvider('http://gw.test', ADMIN, 'secret', store);

    await provider.sendText(SESSION, '923001234567', 'one');

    expect(mintedCount).toBe(0);
    expect(keyFor('/messages/send-text')).toBe('owa_k1_already_mine');
  });

  it('mints once for a session however many calls it serves', async () => {
    vi.stubGlobal('fetch', stubFetch());
    const provider = new OpenWAProvider('http://gw.test', ADMIN, 'secret', memoryStore());

    await provider.sendText(SESSION, '923001234567', 'one');
    await provider.sendText(SESSION, '923001234567', 'two');
    await provider.getSessionStatus(SESSION);

    expect(mintedCount).toBe(1);
  });

  it('gives two businesses two different keys', async () => {
    vi.stubGlobal('fetch', stubFetch());
    const store = memoryStore();
    const provider = new OpenWAProvider('http://gw.test', ADMIN, 'secret', store);

    await provider.sendText('session-alpha', '923001234567', 'a');
    await provider.sendText('session-beta', '923009999999', 'b');

    expect(store.data.get('session-alpha')).not.toBe(store.data.get('session-beta'));
    expect(store.data.size).toBe(2);
  });

  /**
   * Creating a session cannot use a session's own key — there is no session
   * yet. This is one of exactly two calls that stay on the admin key.
   */
  it('still provisions a session on the admin key', async () => {
    vi.stubGlobal('fetch', stubFetch());
    const provider = new OpenWAProvider('http://gw.test', ADMIN, 'secret', memoryStore());

    await provider.provisionSession('skinare');

    expect(calls).toHaveLength(1);
    expect(calls[0]!.key).toBe(ADMIN);
  });

  /**
   * The behaviour that matters most in production: a business must not lose its
   * WhatsApp because a hardening measure could not complete. The likeliest
   * cause is a configured key that is not an admin one, which is precisely the
   * question that could not be answered before shipping this.
   */
  it('falls back to the shared key rather than failing the send', async () => {
    vi.stubGlobal('fetch', stubFetch({ mintFails: true }));
    const provider = new OpenWAProvider('http://gw.test', ADMIN, 'secret', memoryStore());

    const result = await provider.sendText(SESSION, '923001234567', 'hello');

    expect(result.providerMessageId).toBe('m1');
    expect(keyFor('/messages/send-text')).toBe(ADMIN);
  });

  it('stops retrying a mint that cannot succeed', async () => {
    vi.stubGlobal('fetch', stubFetch({ mintFails: true }));
    const provider = new OpenWAProvider('http://gw.test', ADMIN, 'secret', memoryStore());

    await provider.sendText(SESSION, '923001234567', 'one');
    await provider.sendText(SESSION, '923001234567', 'two');
    await provider.sendText(SESSION, '923001234567', 'three');

    // Once. A gateway refusing to mint will refuse every time, and hammering it
    // on every outbound message turns one misconfiguration into a load problem.
    expect(mintedCount).toBe(1);
  });

  /**
   * Without a store the provider behaves exactly as it did before 4.2. That is
   * what lets the Meta provider and the test suites ignore a concept that
   * belongs to OpenWA.
   */
  it('uses the shared key when no store is wired', async () => {
    vi.stubGlobal('fetch', stubFetch());
    const provider = new OpenWAProvider('http://gw.test', ADMIN, 'secret');

    await provider.sendText(SESSION, '923001234567', 'hello');

    expect(mintedCount).toBe(0);
    expect(keyFor('/messages/send-text')).toBe(ADMIN);
  });

  it('carries the scoped key on every session-addressed call, not just sends', async () => {
    vi.stubGlobal('fetch', stubFetch());
    const provider = new OpenWAProvider('http://gw.test', ADMIN, 'secret', memoryStore());

    await provider.getSessionStatus(SESSION);
    await provider.getSessionPhone(SESSION);
    await provider.resolveContactPhone(SESSION, '1774039625903@lid');
    await provider.registerWebhook(SESSION, 'http://here/webhooks/whatsapp', 'shh');

    const sessionCalls = calls.filter(
      (c) => c.url.includes(`/api/sessions/${SESSION}`) && !c.url.includes('/api/auth/'),
    );
    expect(sessionCalls.length).toBeGreaterThanOrEqual(4);
    for (const call of sessionCalls) {
      expect(call.key).toBe('owa_k1_scoped_1');
    }
  });
});
