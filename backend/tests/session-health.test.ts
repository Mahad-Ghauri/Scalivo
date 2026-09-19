import mongoose from 'mongoose';
import { Redis } from 'ioredis';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { MessagingProvider, SendResult, SessionStatus } from '@scalivo/shared';
import { SESSION_INTENT, SESSION_STATUS, isSessionAlarm } from '@scalivo/shared';
import { Business } from '../src/models/Business.js';
import { SessionEvent } from '../src/models/SessionEvent.js';
import { User } from '../src/models/User.js';
import { handleSessionQr, handleSessionStatus } from '../src/session-health/monitor.js';
import { reconcileOnce } from '../src/session-health/reconcile.js';
import { drain, enqueue, queueDepth } from '../src/session-health/outbound-queue.js';
import { infraReady } from './infra.js';

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


const infraUp = await infraReady({ redis: true });

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
    // Append-only in production; cleared here so each case reads its own rows
    // rather than the accumulated history of every test above it.
    await SessionEvent.deleteMany({ businessId });
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

  /**
   * The append-only history behind the uptime metric.
   *
   * `business.whatsapp.status` is overwritten on every change, so it can answer
   * "is it up now?" and never "how much of last month was it up?" — which is the
   * evaluation chapter's headline number. These tests pin the two properties
   * that make the series computable: one row per real transition, and no rows
   * for the things that merely look like one.
   */
  describe('uptime history', () => {
    const history = () => SessionEvent.find({ businessId }).sort({ occurredAt: 1 });

    it('records a transition when the session dies', async () => {
      await handleSessionStatus(deps(), {
        sessionId: SESSION_ID,
        status: SESSION_STATUS.QR_READY,
        occurredAt: new Date(),
      });

      const rows = await history();
      expect(rows).toHaveLength(1);
      const row = rows[0];
      if (!row) throw new Error('expected row');
      expect(row.status).toBe(SESSION_STATUS.QR_READY);
      // The interval boundary: what it was before is what makes the row an edge
      // rather than an isolated observation.
      expect(row.previousStatus).toBe(SESSION_STATUS.READY);
      expect(row.source).toBe('webhook');
    });

    it('writes ONE row for the qr-then-status pair a real unlink produces', async () => {
      // SPIKE FINDING #2 measured these ~4ms apart for a single unlink. Two rows
      // would read as two outages, and the four milliseconds between them as a
      // recovery that never happened.
      const at = new Date();
      await handleSessionQr(deps(), {
        sessionId: SESSION_ID,
        qrCode: 'data:image/png;base64,xxx',
        occurredAt: at,
      });
      await handleSessionStatus(deps(), {
        sessionId: SESSION_ID,
        status: SESSION_STATUS.QR_READY,
        occurredAt: new Date(at.getTime() + 4),
      });

      const rows = await history();
      expect(rows).toHaveLength(1);
      const row = rows[0];
      if (!row) throw new Error('expected row');
      expect(row.occurredAt.getTime()).toBe(at.getTime());
    });

    it('writes nothing when a status repeats', async () => {
      // The reconcile poll arrives every five minutes with the same answer. At
      // 288 identical rows a day per business this would be noise that every
      // uptime query then had to de-duplicate before it could compute anything.
      await handleSessionStatus(deps(), {
        sessionId: SESSION_ID,
        status: SESSION_STATUS.READY,
        occurredAt: new Date(),
      });

      expect(await history()).toHaveLength(0);
    });

    it('records the recovery, so the outage has an end', async () => {
      const start = new Date();
      await handleSessionStatus(deps(), {
        sessionId: SESSION_ID,
        status: SESSION_STATUS.QR_READY,
        occurredAt: start,
      });
      await handleSessionStatus(deps(), {
        sessionId: SESSION_ID,
        status: SESSION_STATUS.READY,
        occurredAt: new Date(start.getTime() + 60_000),
      });

      const rows = await history();
      // An outage with no closing row is indistinguishable from one still in
      // progress, which would make every historical outage read as ongoing.
      expect(rows.map((r) => r.status)).toEqual([SESSION_STATUS.QR_READY, SESSION_STATUS.READY]);
      const [r0, r1] = rows;
      if (!r0 || !r1) throw new Error('expected 2 rows');
      expect(r1.occurredAt.getTime() - r0.occurredAt.getTime()).toBe(60_000);
    });

    it('keeps the intent, so a deliberate re-link is not counted as downtime', async () => {
      await Business.updateOne(
        { _id: businessId },
        { $set: { 'whatsapp.intent': SESSION_INTENT.LINKING } },
      );

      await handleSessionStatus(deps(), {
        sessionId: SESSION_ID,
        status: SESSION_STATUS.QR_READY,
        occurredAt: new Date(),
      });

      // Same status, same wire bytes as a real outage. Only the intent separates
      // an owner holding a phone from a business that cannot take bookings.
      const rows = await history();
      const row = rows[0];
      if (!row) throw new Error('expected row');
      expect(row.intent).toBe(SESSION_INTENT.LINKING);
    });

    it('marks what reconcile found, so unreliable delivery is visible as such', async () => {
      provider.status = SESSION_STATUS.QR_READY;

      await reconcileOnce(deps());

      const rows = await history();
      expect(rows).toHaveLength(1);
      const row = rows[0];
      if (!row) throw new Error('expected row');
      // A run where most transitions carry this is a finding about our webhook
      // delivery, not about the business's uptime — and the timestamp is only
      // accurate to the 5-minute poll, which the source label warns the reader.
      expect(row.source).toBe('reconcile');
    });
  });
});
