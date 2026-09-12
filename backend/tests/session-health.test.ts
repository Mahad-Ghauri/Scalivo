import mongoose from 'mongoose';
import { Redis } from 'ioredis';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { MessagingProvider, SendResult, SessionStatus } from '@scalivo/shared';
import { SESSION_INTENT, SESSION_STATUS, isSessionAlarm } from '@scalivo/shared';
import { Business } from '../src/models/Business.js';
import { User } from '../src/models/User.js';
import { handleSessionQr, handleSessionStatus } from '../src/session-health/monitor.js';
import { reconcileOnce } from '../src/session-health/reconcile.js';
import { drain, enqueue, queueDepth } from '../src/session-health/outbound-queue.js';

/**
 * Session Health, against the signals WhatsApp really sends.
 *
 * The single most important test in this file is the unsolicited-QR one. SPIKE
 * FINDING #2: a phone-side unlink emits `session.qr` then `qr_ready`, and
 * `disconnected` fired ZERO times across the entire spike. A monitor written
 * from the protocol docs rather than from the measurements would pass every
 * other test here and sit silent through a real outage.
 */

const SESSION_ID = 'test-session-health';

class FakeProvider implements MessagingProvider {
  readonly name = 'fake';
  status: SessionStatus = SESSION_STATUS.READY;
  sent: { to: string; text: string }[] = [];
  /** Simulates the session being down: sends throw, as the real one does. */
  failSends = false;
  /** Simulates the gateway itself being unreachable. */
  failStatus = false;

  async sendText(_sessionId: string, to: string, text: string): Promise<SendResult> {
    if (this.failSends) throw new Error('session not connected');
    this.sent.push({ to, text });
    return { providerMessageId: `m${this.sent.length}`, acceptedAt: new Date() };
  }
  async getSessionStatus(): Promise<SessionStatus> {
    if (this.failStatus) throw new Error('gateway unreachable');
    return this.status;
  }
  async startSession() {
    return { status: this.status };
  }
  async provisionSession() {
    return { sessionId: SESSION_ID, status: this.status };
  }
  async registerWebhook() {
    /* nothing to record — Session Health never provisions */
  }
  async getSessionPhone() {
    return null;
  }
  async resolveContactPhone() {
    return null;
  }
  parseWebhook() {
    return [];
  }
}

async function reachable(): Promise<boolean> {
  try {
    await mongoose.connect(process.env.MONGO_URI!, { serverSelectionTimeoutMS: 2000 });
    const probe = new Redis(process.env.REDIS_URL!, { lazyConnect: true, maxRetriesPerRequest: 1 });
    await probe.connect();
    await probe.quit();
    return true;
  } catch {
    return false;
  }
}

const infraUp = await reachable();

/** Pure, no infrastructure — the decision the whole subsystem rests on. */
describe('isSessionAlarm', () => {
  it('treats an unsolicited qr_ready as the alarm', () => {
    expect(isSessionAlarm(SESSION_STATUS.QR_READY, SESSION_INTENT.LIVE)).toBe(true);
  });

  it('does not alarm on a QR we asked for', () => {
    expect(isSessionAlarm(SESSION_STATUS.QR_READY, SESSION_INTENT.LINKING)).toBe(false);
  });

  it('stays silent for a session we stopped on purpose', () => {
    expect(isSessionAlarm(SESSION_STATUS.DISCONNECTED, SESSION_INTENT.STOPPED)).toBe(false);
  });

  it('still handles disconnected, for the network drops the spike never tested', () => {
    expect(isSessionAlarm(SESSION_STATUS.DISCONNECTED, SESSION_INTENT.LIVE)).toBe(true);
  });
});

describe.skipIf(!infraUp)('session health', () => {
  let redis: Redis;
  let provider: FakeProvider;
  let businessId: string;

  const deps = () => ({ redis, provider });
  const business = () => Business.findById(businessId);

  beforeAll(async () => {
    // Its own Redis database — see the note in conversation.test.ts.
    redis = new Redis(process.env.REDIS_URL!, { db: 3 });
    provider = new FakeProvider();
  });

  afterAll(async () => {
    await Promise.all([mongoose.disconnect(), redis.quit()]);
  });

  beforeEach(async () => {
    const doc = await Business.findOneAndUpdate(
      { slug: 'health-test' },
      {
        slug: 'health-test',
        name: 'Health Test Salon',
        category: 'salon',
        whatsapp: {
          sessionId: SESSION_ID,
          status: SESSION_STATUS.READY,
          intent: SESSION_INTENT.LIVE,
        },
      },
      { upsert: true, new: true, setDefaultsOnInsert: true },
    );
    businessId = String(doc._id);

    await User.deleteMany({ email: 'health-owner@test.pk' });
    await redis.flushdb();
    provider.sent = [];
    provider.failSends = false;
    provider.failStatus = false;
    provider.status = SESSION_STATUS.READY;
  });

  describe('detection', () => {
    /**
     * THE test. This is the sequence a real unlink produces, and the reason the
     * monitor cannot watch for `disconnected`.
     */
    it('raises the alarm on an unsolicited QR, with no disconnected event at all', async () => {
      await handleSessionQr(deps(), {
        sessionId: SESSION_ID,
        qrCode: 'data:image/png;base64,xxx',
        occurredAt: new Date(),
      });

      const after = await business();
      expect(after?.whatsapp?.reconnectAttempts).toBe(1);
      expect(after?.whatsapp?.lastAlertAt).toBeInstanceOf(Date);
    });

    it('stays silent for a QR we caused by linking', async () => {
      await Business.updateOne(
        { _id: businessId },
        { $set: { 'whatsapp.intent': SESSION_INTENT.LINKING } },
      );

      await handleSessionQr(deps(), {
        sessionId: SESSION_ID,
        qrCode: 'data:image/png;base64,xxx',
        occurredAt: new Date(),
      });

      // Byte-identical event, opposite meaning. Intent is the only thing that
      // separates them.
      expect((await business())?.whatsapp?.lastAlertAt).toBeNull();
    });

    it('alarms on a disconnected status too', async () => {
      await handleSessionStatus(deps(), {
        sessionId: SESSION_ID,
        status: SESSION_STATUS.DISCONNECTED,
        occurredAt: new Date(),
      });

      expect((await business())?.whatsapp?.lastAlertAt).toBeInstanceOf(Date);
    });

    it('does not re-alarm while the outage continues', async () => {
      await handleSessionStatus(deps(), {
        sessionId: SESSION_ID,
        status: SESSION_STATUS.DISCONNECTED,
        occurredAt: new Date(),
      });
      const first = (await business())?.whatsapp?.lastAlertAt;

      await handleSessionStatus(deps(), {
        sessionId: SESSION_ID,
        status: SESSION_STATUS.DISCONNECTED,
        occurredAt: new Date(),
      });

      // An alert every 5 minutes for an afternoon is an alert nobody reads.
      expect((await business())?.whatsapp?.lastAlertAt).toEqual(first);
    });

    it('alarms again after a recovery, because the cooldown is cleared', async () => {
      await handleSessionStatus(deps(), {
        sessionId: SESSION_ID,
        status: SESSION_STATUS.DISCONNECTED,
        occurredAt: new Date(),
      });
      const first = (await business())?.whatsapp?.lastAlertAt;

      await handleSessionStatus(deps(), {
        sessionId: SESSION_ID,
        status: SESSION_STATUS.READY,
        occurredAt: new Date(),
      });
      await handleSessionStatus(deps(), {
        sessionId: SESSION_ID,
        status: SESSION_STATUS.DISCONNECTED,
        occurredAt: new Date(),
      });

      expect((await business())?.whatsapp?.lastAlertAt).not.toEqual(first);
    });

    it('never infers liveness from phone or connectedAt', async () => {
      // A dead session still reports its original phone and connectedAt, and
      // lastError stays null. Nothing in the monitor may read them — so the
      // alarm above fires on a business record that has none of those fields set.
      await handleSessionQr(deps(), {
        sessionId: SESSION_ID,
        qrCode: 'x',
        occurredAt: new Date(),
      });
      expect((await business())?.whatsapp?.lastAlertAt).toBeInstanceOf(Date);
    });
  });

  describe('recovery and the outbound queue', () => {
    it('drains everything queued during the outage when the session returns', async () => {
      provider.failSends = true;
      await enqueue(redis, businessId, { sessionId: SESSION_ID, to: 'x@lid', text: 'confirmation' });
      await enqueue(redis, businessId, { sessionId: SESSION_ID, to: 'x@lid', text: 'reminder' });
      expect(await queueDepth(redis, businessId)).toBe(2);

      provider.failSends = false;
      await handleSessionStatus(deps(), {
        sessionId: SESSION_ID,
        status: SESSION_STATUS.READY,
        occurredAt: new Date(),
      });

      expect(await queueDepth(redis, businessId)).toBe(0);
      // Order preserved: a confirmation must not land after the reminder that
      // assumes it.
      expect(provider.sent.map((s) => s.text)).toEqual(['confirmation', 'reminder']);
    });

    it('flips intent back to LIVE on recovery so the next QR is an alarm', async () => {
      await Business.updateOne(
        { _id: businessId },
        { $set: { 'whatsapp.intent': SESSION_INTENT.LINKING } },
      );

      await handleSessionStatus(deps(), {
        sessionId: SESSION_ID,
        status: SESSION_STATUS.READY,
        occurredAt: new Date(),
      });

      const after = await business();
      expect(after?.whatsapp?.intent).toBe(SESSION_INTENT.LIVE);
      expect(after?.whatsapp?.reconnectAttempts).toBe(0);
    });

    it('stops draining and keeps order when the session drops again mid-drain', async () => {
      await enqueue(redis, businessId, { sessionId: SESSION_ID, to: 'x@lid', text: 'first' });
      await enqueue(redis, businessId, { sessionId: SESSION_ID, to: 'x@lid', text: 'second' });

      provider.failSends = true;
      const result = await drain(redis, provider, businessId);

      expect(result.sent).toBe(0);
      // Both still queued, still in order — not burned against a dead session.
      expect(await queueDepth(redis, businessId)).toBe(2);

      provider.failSends = false;
      await drain(redis, provider, businessId);
      expect(provider.sent.map((s) => s.text)).toEqual(['first', 'second']);
    });

    it('gives up on a message after repeated failures rather than blocking forever', async () => {
      await enqueue(redis, businessId, { sessionId: SESSION_ID, to: 'x@lid', text: 'doomed' });
      provider.failSends = true;

      // MAX_ATTEMPTS is 5; each drain burns one attempt then stops.
      for (let i = 0; i < 6; i++) await drain(redis, provider, businessId);

      expect(await queueDepth(redis, businessId)).toBe(0);
    });
  });

  describe('the reconcile safety net', () => {
    it('catches an outage whose webhook never arrived', async () => {
      // We still believe READY; the gateway says otherwise. This is the case a
      // webhook-only monitor cannot see, because the signal is the one missing.
      provider.status = SESSION_STATUS.QR_READY;

      await reconcileOnce(deps());

      const after = await business();
      expect(after?.whatsapp?.status).toBe(SESSION_STATUS.QR_READY);
      expect(after?.whatsapp?.lastAlertAt).toBeInstanceOf(Date);
    });

    it('drains a backlog when the recovery webhook was the one that went missing', async () => {
      await enqueue(redis, businessId, { sessionId: SESSION_ID, to: 'x@lid', text: 'stranded' });
      provider.status = SESSION_STATUS.READY;

      await reconcileOnce(deps());

      expect(await queueDepth(redis, businessId)).toBe(0);
      expect(provider.sent.map((s) => s.text)).toEqual(['stranded']);
    });

    it('does not alarm the owner when the GATEWAY is unreachable', async () => {
      provider.failStatus = true;

      await reconcileOnce(deps());

      // Infrastructure being down is not this business's session dying. Sending
      // the owner to re-scan a QR that will never load is worse than silence.
      expect((await business())?.whatsapp?.lastAlertAt).toBeNull();
    });

    it('ignores sessions we stopped on purpose', async () => {
      await Business.updateOne(
        { _id: businessId },
        { $set: { 'whatsapp.intent': SESSION_INTENT.STOPPED } },
      );
      provider.status = SESSION_STATUS.DISCONNECTED;

      await reconcileOnce(deps());

      expect((await business())?.whatsapp?.lastAlertAt).toBeNull();
    });
  });
});
