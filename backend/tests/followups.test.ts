import mongoose from 'mongoose';
import { Redis } from 'ioredis';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { InboundMessage, MessagingProvider, SendResult } from '@scalivo/shared';
import {
  BOOKING_STATUS,
  FOLLOW_UP_STATUS,
  NOTIFICATION_KIND,
  SESSION_STATUS,
} from '@scalivo/shared';

/**
 * Owner-set follow-ups: set → offered 3 days before due → nudged → lapsed,
 * closed as BOOKED the moment a later booking for that service exists, and
 * the customer's 1/2/3 reply driven through the real inbound chain.
 */

const pushes: { title: string; route?: string | undefined }[] = [];
vi.mock('../src/push/fcm.js', async (orig) => ({
  ...(await orig<typeof import('../src/push/fcm.js')>()),
  pushToOwners: vi.fn(async (_b: string, m: { title: string; route?: string }) => {
    pushes.push({ title: m.title, route: m.route });
    return 1;
  }),
}));

const { Booking } = await import('../src/models/Booking.js');
const { Business } = await import('../src/models/Business.js');
const { Client } = await import('../src/models/Client.js');
const { ClientProfile } = await import('../src/models/ClientProfile.js');
const { Notification } = await import('../src/models/Notification.js');
const { Service } = await import('../src/models/Service.js');
const { Staff } = await import('../src/models/Staff.js');
const { SlotOccupancy } = await import('../src/models/SlotOccupancy.js');
const { CapacityOccupancy } = await import('../src/models/CapacityOccupancy.js');
const { FlowRun } = await import('../src/models/FlowRun.js');
const { setFollowUp, clearFollowUp, listFollowUps } = await import('../src/followups/service.js');
const { followUpsForBusiness } = await import('../src/followups/job.js');
const { handleInboundMessage } = await import('../src/whatsapp/router.js');
const { readPendingPrompt, readConversation } = await import('../src/whatsapp/state.js');
const { CONVERSATION_STATE } = await import('../src/whatsapp/fsm/states.js');
const { wallClockToUtc, toBusinessLocal } = await import('../src/lib/time.js');
const { infraReady } = await import('./infra.js');

const TZ = 'Asia/Karachi';
const SESSION_ID = 'followups-test-session';
const LID = '1779900000123@lid';
const PHONE = '923008765123';
const DAY = 86_400_000;

class FakeProvider implements MessagingProvider {
  readonly name = 'fake';
  sent: string[] = [];
  async sendText(_s: string, _to: string, text: string): Promise<SendResult> {
    this.sent.push(text);
    return { providerMessageId: `fu-${Math.random()}`, acceptedAt: new Date() };
  }
  async getSessionStatus() {
    return SESSION_STATUS.READY;
  }
  async startSession() {
    return { status: SESSION_STATUS.READY };
  }
  async getSessionQr() {
    return null;
  }
  async provisionSession() {
    return { sessionId: 'fake', status: SESSION_STATUS.READY };
  }
  async registerWebhook() {}
  async getSessionPhone() {
    return PHONE;
  }
  async resolveContactPhone() {
    return PHONE;
  }
  parseWebhook() {
    return [];
  }
}

const inbound = (body: string): InboundMessage => ({
  providerMessageId: `in-${Math.random()}`,
  sessionId: SESSION_ID,
  contactPhone: PHONE,
  contactLid: LID,
  body,
  type: 'text',
  receivedAt: new Date(),
  fromMe: false,
  isGroup: false,
  displayName: 'Sana Khan',
  hasMedia: false,
});

const infraUp = await infraReady({ replicaSet: true, redis: true });

describe.skipIf(!infraUp)('follow-ups', () => {
  let redis: Redis;
  let provider: FakeProvider;
  let deps: { redis: Redis; provider: FakeProvider };
  let businessId: string;
  let clientId: string;
  let staffId: string;
  let laser: string;
  let facial: string;
  /** 10:00 local tomorrow — inside waking hours, whenever the suite runs. */
  let now: Date;

  const tick = (at: Date) => followUpsForBusiness(deps, businessId, at);

  async function say(text: string) {
    provider.sent = [];
    await handleInboundMessage({ redis, provider }, inbound(text));
    return provider.sent.join('\n');
  }

  /** A completed laser visit 19 days ago with a 21-day follow-up → due in 2 days. */
  async function completedVisit(afterDays = 21, status: string = BOOKING_STATUS.COMPLETED) {
    const visit = await Booking.create({
      businessId,
      clientId,
      staffId,
      serviceId: laser,
      startsAt: new Date(now.getTime() - 19 * DAY),
      durationMinutes: 30,
      priceMinor: 500_000,
      source: 'owner',
      status,
      completedAt: status === BOOKING_STATUS.COMPLETED ? new Date(now.getTime() - 19 * DAY) : null,
    });
    const set = await setFollowUp({
      businessId,
      bookingId: String(visit._id),
      afterDays,
      note: 'Session 2 of 6',
      now: new Date(now.getTime() - 19 * DAY),
    });
    expect(set.ok).toBe(true);
    return visit;
  }

  const followUp = async (id: unknown) => (await Booking.findById(id))!.followUp!;

  beforeAll(async () => {
    redis = new Redis(process.env.REDIS_URL!, { db: 13 });
    await SlotOccupancy.syncIndexes();
    const tomorrow = toBusinessLocal(new Date(Date.now() + DAY), TZ).toISODate()!;
    now = wallClockToUtc(`${tomorrow}T10:00`, TZ);
  });

  afterAll(async () => {
    await Client.deleteMany({ lids: LID });
    await Promise.all([mongoose.disconnect(), redis.quit()]);
  });

  beforeEach(async () => {
    pushes.length = 0;
    provider = new FakeProvider();
    deps = { redis, provider };
    const business = await Business.findOneAndUpdate(
      { slug: 'followups-test' },
      {
        slug: 'followups-test',
        name: 'Glow Clinic',
        category: 'clinic',
        timezone: TZ,
        slotIncrementMinutes: 15,
        minNoticeMinutes: 60,
        bookingHorizonDays: 60,
        'whatsapp.sessionId': SESSION_ID,
      },
      { upsert: true, new: true, setDefaultsOnInsert: true },
    );
    businessId = String(business._id);
    await Promise.all([
      Booking.deleteMany({ businessId }),
      SlotOccupancy.deleteMany({ businessId }),
      CapacityOccupancy.deleteMany({ businessId }),
      Notification.deleteMany({ businessId }),
      FlowRun.deleteMany({ businessId }),
      Service.deleteMany({ businessId }),
      Staff.deleteMany({ businessId }),
      ClientProfile.deleteMany({ businessId }),
      Client.deleteMany({ lids: LID }),
      redis.flushdb(),
    ]);
    const [l, f] = await Service.insertMany([
      { businessId, name: 'Laser', durationMinutes: 30, priceMinor: 500_000, displayOrder: 1 },
      { businessId, name: 'Facial', durationMinutes: 30, priceMinor: 300_000, displayOrder: 2 },
    ]);
    laser = String(l!._id);
    facial = String(f!._id);
    const hours = [0, 1, 2, 3, 4, 5, 6].map((dayOfWeek) => ({
      dayOfWeek,
      opensAt: '09:00',
      closesAt: '18:00',
      breaks: [],
    }));
    staffId = String(
      (await Staff.create({ businessId, name: 'Ayesha', serviceIds: [laser], workingHours: hours }))
        ._id,
    );
    clientId = String(
      (await Client.create({ phone: PHONE, lids: [LID], displayName: 'Sana Khan' }))._id,
    );
  });

  describe('setting it', () => {
    it('defaults to the same service and professional, due N days after the visit', async () => {
      const visit = await completedVisit(21);
      const f = await followUp(visit._id);
      expect(f.status).toBe(FOLLOW_UP_STATUS.SCHEDULED);
      expect(f.serviceId).toBe(laser);
      expect(f.staffId).toBe(staffId);
      expect(f.dueAt.getTime()).toBe(visit.startsAt.getTime() + 21 * DAY);
    });

    it('drops an inherited professional who cannot do the follow-up service', async () => {
      const visit = await completedVisit();
      const r = await setFollowUp({
        businessId,
        bookingId: String(visit._id),
        afterDays: 7,
        serviceId: facial,
      });
      expect(r.ok && r.followUp.staffId).toBeNull();
      const bad = await setFollowUp({
        businessId,
        bookingId: String(visit._id),
        afterDays: 7,
        serviceId: facial,
        staffId,
      });
      expect(bad).toEqual({ ok: false, reason: 'invalid_staff' });
    });

    it('refuses a cancelled visit and another tenant', async () => {
      const visit = await completedVisit(21, BOOKING_STATUS.CANCELLED).catch(() => null);
      expect(visit).toBeNull(); // completedVisit asserts ok — so it threw
      const other = await setFollowUp({
        businessId: new mongoose.Types.ObjectId().toString(),
        bookingId: new mongoose.Types.ObjectId().toString(),
        afterDays: 7,
      });
      expect(other).toEqual({ ok: false, reason: 'not_found' });
    });
  });

  describe('the job', () => {
    it('offers a concrete slot once inside the window, once only', async () => {
      const visit = await completedVisit(25); // due in 6 days: too early
      await tick(now);
      expect(provider.sent).toHaveLength(0);

      await tick(new Date(now.getTime() + 3 * DAY + 60_000));
      await tick(new Date(now.getTime() + 3 * DAY + 120_000));
      expect(provider.sent).toHaveLength(1);
      expect(provider.sent[0]).toContain('Your follow-up Laser is due');
      expect(provider.sent[0]).toContain('Session 2 of 6');
      expect(provider.sent[0]).toContain('with Ayesha');
      expect(provider.sent[0]).toContain('Reply 1 to book it');

      expect((await followUp(visit._id)).status).toBe(FOLLOW_UP_STATUS.OFFERED);
      const prompt = await readPendingPrompt(redis, businessId, clientId);
      expect(prompt).toMatchObject({ kind: 'followup', bookingId: String(visit._id), staffId });
      expect(
        await Notification.countDocuments({ businessId, kind: NOTIFICATION_KIND.FOLLOW_UP }),
      ).toBe(1);
    });

    it('waits for quiet hours to end', async () => {
      await completedVisit();
      const night = wallClockToUtc(`${toBusinessLocal(now, TZ).toISODate()}T22:30`, TZ);
      await tick(night);
      expect(provider.sent).toHaveLength(0);
    });

    it('waits until the visit is marked complete', async () => {
      const visit = await completedVisit(21, BOOKING_STATUS.CONFIRMED);
      await tick(now);
      expect(provider.sent).toHaveLength(0);
      expect((await followUp(visit._id)).status).toBe(FOLLOW_UP_STATUS.SCHEDULED);
    });

    it('cancels itself when the visit is cancelled', async () => {
      const visit = await completedVisit(21, BOOKING_STATUS.CONFIRMED);
      await Booking.updateOne({ _id: visit._id }, { status: BOOKING_STATUS.CANCELLED });
      await tick(now);
      expect((await followUp(visit._id)).status).toBe(FOLLOW_UP_STATUS.CANCELLED);
    });

    it('closes as booked, without messaging, when a later booking already exists', async () => {
      const visit = await completedVisit();
      const later = await Booking.create({
        businessId,
        clientId,
        staffId,
        serviceId: laser,
        startsAt: new Date(now.getTime() + 2 * DAY),
        durationMinutes: 30,
        priceMinor: 1,
        source: 'owner',
        status: BOOKING_STATUS.CONFIRMED,
      });
      await tick(now);
      expect(provider.sent).toHaveLength(0);
      const f = await followUp(visit._id);
      expect(f.status).toBe(FOLLOW_UP_STATUS.BOOKED);
      expect(f.bookedBookingId).toBe(String(later._id));
    });

    it('nudges after 3 silent days, then lapses to the owner after 3 more', async () => {
      const visit = await completedVisit();
      await tick(now);
      await tick(new Date(now.getTime() + 3 * DAY + 60_000));
      expect(provider.sent).toHaveLength(2);
      expect(provider.sent[1]).toContain('Just checking in');
      expect((await followUp(visit._id)).status).toBe(FOLLOW_UP_STATUS.NUDGED);

      await tick(new Date(now.getTime() + 6 * DAY + 120_000));
      expect(provider.sent).toHaveLength(2);
      const f = await followUp(visit._id);
      expect(f.status).toBe(FOLLOW_UP_STATUS.LAPSED);
      expect(f.lapsedReason).toBe('no_reply');
      expect(pushes).toEqual([{ title: 'Follow-up: contact Sana Khan', route: '/follow-ups' }]);
    });

    it('lapses straight to the owner for an opted-out customer', async () => {
      const visit = await completedVisit();
      await Client.updateOne({ _id: clientId }, { marketingOptOut: true });
      await tick(now);
      expect(provider.sent).toHaveLength(0);
      expect((await followUp(visit._id)).lapsedReason).toBe('opted_out');
      expect(pushes).toHaveLength(1);
    });
  });

  describe("the customer's reply", () => {
    async function offered() {
      const visit = await completedVisit();
      await tick(now);
      expect(provider.sent).toHaveLength(1);
      return visit;
    }

    it('"1" asks to confirm the offered slot, YES books it, and the job closes it', async () => {
      const visit = await offered();
      expect(await say('1')).toContain('YES');
      expect((await readConversation(redis, businessId, clientId))?.state).toBe(
        CONVERSATION_STATE.CONFIRMING,
      );
      await say('yes');
      const booked = await Booking.findOne({ businessId, clientId, _id: { $ne: visit._id } });
      expect(booked?.serviceId).toBe(laser);
      expect(booked?.staffId).toBe(staffId);

      await tick(new Date(now.getTime() + 60_000));
      expect((await followUp(visit._id)).status).toBe(FOLLOW_UP_STATUS.BOOKED);
    });

    it('"2" opens the date menu for the follow-up service', async () => {
      await offered();
      await say('2');
      const c = await readConversation(redis, businessId, clientId);
      expect(c?.serviceId).toBe(laser);
      expect(c?.state).not.toBe(CONVERSATION_STATE.AWAITING_FOLLOWUP_REPLY);
    });

    it('"3" declines, and the job stops', async () => {
      const visit = await offered();
      expect(await say('3')).toContain("won't remind you");
      expect((await followUp(visit._id)).status).toBe(FOLLOW_UP_STATUS.DECLINED);
      provider.sent = [];
      await tick(new Date(now.getTime() + 4 * DAY));
      expect(provider.sent).toHaveLength(0);
    });

    it('an unrelated message gets the normal menu', async () => {
      await offered();
      expect(await say('hi')).toContain('Laser');
      expect(await readPendingPrompt(redis, businessId, clientId)).toBeNull();
    });
  });

  describe("the owner's list", () => {
    it('shows open follow-ups with lapsed first, and clearing removes one', async () => {
      const a = await completedVisit();
      await Client.updateOne({ _id: clientId }, { marketingOptOut: true });
      await tick(now); // lapses
      await Client.updateOne({ _id: clientId }, { marketingOptOut: false });
      const b = await completedVisit(40);

      const list = await listFollowUps(businessId, 'open');
      expect(list.map((i) => i.bookingId)).toEqual([String(a._id), String(b._id)]);
      expect(list[0]).toMatchObject({
        status: FOLLOW_UP_STATUS.LAPSED,
        serviceName: 'Laser',
        staffName: 'Ayesha',
        clientName: 'Sana Khan',
        clientPhone: PHONE,
      });

      expect(await clearFollowUp(businessId, String(b._id))).toBe(true);
      expect((await listFollowUps(businessId, 'open')).map((i) => i.bookingId)).toEqual([
        String(a._id),
      ]);
    });
  });
});
