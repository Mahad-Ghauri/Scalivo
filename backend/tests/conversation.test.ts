import mongoose from 'mongoose';
import { Redis } from 'ioredis';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { InboundMessage, MessagingProvider, SendResult } from '@scalivo/shared';
import { BOOKING_STATUS, SESSION_STATUS } from '@scalivo/shared';
import { Booking } from '../src/models/Booking.js';
import { Business } from '../src/models/Business.js';
import { Client } from '../src/models/Client.js';
import { ClientProfile } from '../src/models/ClientProfile.js';
import { Service } from '../src/models/Service.js';
import { SlotOccupancy } from '../src/models/SlotOccupancy.js';
import { Staff } from '../src/models/Staff.js';
import { BlockedTime } from '../src/models/BlockedTime.js';
import { handleInboundMessage } from '../src/whatsapp/router.js';
import { readConversation, writePendingPrompt } from '../src/whatsapp/state.js';
import { CONVERSATION_STATE } from '../src/whatsapp/fsm/states.js';
import { infraReady } from './infra.js';

/**
 * The conversation, end to end: a webhook payload goes in, replies come out,
 * and a booking exists at the end of it.
 *
 * Driven through handleInboundMessage rather than the machine directly, because
 * the ORDER of the interceptor chain is most of what Phase 1.4 gets right or
 * wrong. Testing `advance()` in isolation would pass happily while STOP was
 * being routed into the menu handler.
 *
 * Needs Mongo (replica set) and Redis: `docker compose up -d mongo redis`.
 */

const TZ = 'Asia/Karachi';
const SESSION_ID = 'test-session-fsm';
const LID = '1774039625903@lid';

/** Captures what the bot said, and never touches a network. */
class FakeProvider implements MessagingProvider {
  readonly name = 'fake';
  sent: string[] = [];

  async sendText(_sessionId: string, _to: string, text: string): Promise<SendResult> {
    this.sent.push(text);
    return { providerMessageId: `m${this.sent.length}`, acceptedAt: new Date() };
  }
  async getSessionStatus() {
    return SESSION_STATUS.READY;
  }
  async startSession() {
    return { status: SESSION_STATUS.READY };
  }
  async provisionSession() {
    return { sessionId: 'fake-session', status: SESSION_STATUS.READY };
  }
  async registerWebhook() {
    /* the conversation path never provisions */
  }
  async getSessionPhone() {
    return '923001234567';
  }
  async resolveContactPhone() {
    return '923001234567';
  }
  parseWebhook() {
    return [];
  }
  /** What the bot said in reply to the last message only. */
  lastReplies(): string {
    return this.sent.join('\n');
  }
  clear() {
    this.sent = [];
  }
}

function inbound(body: string, overrides: Partial<InboundMessage> = {}): InboundMessage {
  return {
    providerMessageId: `in-${Math.random()}`,
    sessionId: SESSION_ID,
    contactPhone: '923001234567',
    contactLid: LID,
    body,
    type: 'text',
    receivedAt: new Date(),
    fromMe: false,
    isGroup: false,
    displayName: 'Sana Khan',
    hasMedia: false,
    ...overrides,
  };
}


const infraUp = await infraReady({ replicaSet: true, redis: true });

describe.skipIf(!infraUp)('conversation FSM', () => {
  let redis: Redis;
  let provider: FakeProvider;
  let businessId: string;
  let clientId: string;
  let hydrafacial: string;

  /** One customer message through the whole chain; returns what the bot said. */
  async function say(text: string, overrides: Partial<InboundMessage> = {}): Promise<string> {
    provider.clear();
    await handleInboundMessage({ redis, provider }, inbound(text, overrides));
    return provider.lastReplies();
  }

  const conversation = () => readConversation(redis, businessId, clientId);

  beforeAll(async () => {
    // Its OWN Redis database. This suite and the concurrency suite both call
    // flushdb() in beforeEach, and vitest runs files in parallel — sharing db 0
    // means each one periodically wipes the other's conversations mid-test.
    redis = new Redis(process.env.REDIS_URL!, { db: 2 });
    provider = new FakeProvider();
    await SlotOccupancy.syncIndexes();
  });

  afterAll(async () => {
    await Promise.all([mongoose.disconnect(), redis.quit()]);
  });

  beforeEach(async () => {
    const business = await Business.findOneAndUpdate(
      { slug: 'fsm-test' },
      {
        slug: 'fsm-test',
        name: 'FSM Test Salon',
        category: 'salon',
        timezone: TZ,
        slotIncrementMinutes: 15,
        minNoticeMinutes: 60,
        bookingHorizonDays: 30,
        whatsapp: { sessionId: SESSION_ID },
      },
      { upsert: true, new: true, setDefaultsOnInsert: true },
    );
    businessId = String(business._id);

    await Promise.all([
      SlotOccupancy.deleteMany({ businessId }),
      Booking.deleteMany({ businessId }),
      Service.deleteMany({ businessId }),
      Staff.deleteMany({ businessId }),
      BlockedTime.deleteMany({ businessId }),
      Client.deleteMany({ lids: LID }),
      redis.flushdb(),
    ]);

    const [a] = await Service.insertMany([
      { businessId, name: 'Hydrafacial', durationMinutes: 45, priceMinor: 800_000, displayOrder: 1 },
      { businessId, name: 'Laser', durationMinutes: 20, priceMinor: 500_000, displayOrder: 2 },
    ]);
    hydrafacial = String(a!._id);

    // Open every day so the date menu always has options regardless of when the
    // suite runs — a test that only passes on weekdays is a flaky test.
    const hours = [0, 1, 2, 3, 4, 5, 6].map((dayOfWeek) => ({
      dayOfWeek,
      opensAt: '09:00',
      closesAt: '18:00',
      breaks: [],
    }));

    const serviceIds = (await Service.find({ businessId })).map((s) => String(s._id));
    await Staff.insertMany([
      { businessId, name: 'Ayesha', serviceIds, workingHours: hours },
      { businessId, name: 'Sana', serviceIds, workingHours: hours },
    ]);

    const client = await Client.create({ phone: '923001234567', lids: [LID], displayName: 'Sana Khan' });
    clientId = String(client._id);
    provider.clear();
  });

  /** Walks the menus to CONFIRMING: service 1, staff "no preference", day 1, slot 1. */
  async function walkToConfirming() {
    await say('hi');
    await say('1'); // Hydrafacial
    await say('3'); // No preference (2 staff + 1)
    await say('1'); // first available day
    return say('1'); // first slot
  }

  it('books end to end from a cold "hi"', async () => {
    const opening = await say('hi');
    expect(opening).toContain('Hydrafacial');
    expect(opening).toContain('45 min');
    expect((await conversation())?.state).toBe(CONVERSATION_STATE.SELECTING_SERVICE);

    const staffPrompt = await say('1');
    expect(staffPrompt).toContain('Ayesha');
    expect(staffPrompt).toContain('No preference');

    const datePrompt = await say('3');
    expect(datePrompt).toContain('Which day');

    const slotPrompt = await say('1');
    expect(slotPrompt).toContain('Available times');

    const confirm = await say('1');
    expect(confirm).toContain('Please confirm');
    expect(confirm).toContain('Hydrafacial');
    expect((await conversation())?.state).toBe(CONVERSATION_STATE.CONFIRMING);

    const done = await say('yes');
    expect(done).toContain("You're booked");

    const booking = await Booking.findOne({ businessId, clientId });
    expect(booking).not.toBeNull();
    expect(booking!.serviceId).toBe(hydrafacial);
    expect(booking!.source).toBe('whatsapp');

    // Three occupancy rows for a 45-min service on a 15-min grid.
    expect(await SlotOccupancy.countDocuments({ bookingId: String(booking!._id) })).toBe(3);

    // CONFIRMED is terminal — the next message starts fresh, it does not resume.
    expect(await conversation()).toBeNull();
  });

  it('greets a returning customer by name', async () => {
    expect(await say('hi')).toContain('Sana');
  });

  describe('global commands beat the FSM', () => {
    it('honours STOP mid-booking and discards the conversation', async () => {
      await walkToConfirming();
      expect((await conversation())?.state).toBe(CONVERSATION_STATE.CONFIRMING);

      const reply = await say('STOP');
      expect(reply).toContain("won't receive any more offers");

      // Not advanced — discarded. Answering "reply YES or NO" to an opt-out is
      // the exact bug the interceptor ordering exists to prevent.
      expect(await conversation()).toBeNull();
      expect(
        (await ClientProfile.findOne({ businessId, clientId }))?.marketingOptOut,
      ).toBe(true);
      expect(await Booking.countDocuments({ businessId })).toBe(0);
    });

    /**
     * The opt-out belongs to the BUSINESS they messaged, not to the person.
     *
     * A Client row is global across the platform — one human, every business
     * they have ever dealt with. Telling one salon to stop must not silence
     * their gym, their clinic, and every business they have never heard of.
     */
    it('scopes the opt-out to the business they messaged', async () => {
      await say('STOP');

      const otherBusiness = String(new mongoose.Types.ObjectId());
      expect(
        await ClientProfile.exists({ businessId: otherBusiness, clientId, marketingOptOut: true }),
      ).toBeNull();
    });

    it('does not treat a sentence containing "stop" as an opt-out', async () => {
      await say("please don't stop sending me offers");
      expect(
        (await ClientProfile.findOne({ businessId, clientId }))?.marketingOptOut ?? false,
      ).toBe(false);
    });

    it('re-subscribes on START', async () => {
      await say('STOP');
      expect(await say('START')).toContain('back on the list');
      expect((await Client.findById(clientId))?.marketingOptOut).toBe(false);
    });

    it('routes HELP to a human from any state', async () => {
      await walkToConfirming();
      expect(await say('help')).toContain('get back to you');
      expect((await conversation())?.state).toBe(CONVERSATION_STATE.HELP);
    });

    it('cancels an existing booking and frees the grid', async () => {
      await walkToConfirming();
      await say('yes');
      const booking = await Booking.findOne({ businessId, clientId });

      const prompt = await say('CANCEL');
      expect(prompt).toContain('Cancel Hydrafacial');
      expect((await conversation())?.state).toBe(CONVERSATION_STATE.CANCELLING);

      expect(await say('yes')).toContain('cancelled');
      expect((await Booking.findById(booking!._id))?.status).toBe(BOOKING_STATUS.CANCELLED);
      expect(await SlotOccupancy.countDocuments({ bookingId: String(booking!._id) })).toBe(0);
    });

    it('keeps the booking when a cancel is declined', async () => {
      await walkToConfirming();
      await say('yes');

      await say('CANCEL');
      expect(await say('no')).toContain('unchanged');
      expect(await Booking.countDocuments({ businessId, status: BOOKING_STATUS.CANCELLED })).toBe(0);
    });

    it('says so plainly when there is nothing to cancel', async () => {
      expect(await say('CANCEL')).toContain("don't have any upcoming");
    });
  });

  describe('invalid input', () => {
    it('re-prompts, then hands over to a human on the third try', async () => {
      await say('hi');

      expect(await say('banana')).toContain("didn't catch that");
      expect((await conversation())?.invalidCount).toBe(1);

      expect(await say('99')).toContain("didn't catch that");
      expect((await conversation())?.invalidCount).toBe(2);

      expect(await say('???')).toContain('not following');
      expect((await conversation())?.state).toBe(CONVERSATION_STATE.HELP);
    });

    it('resets the counter on a valid reply', async () => {
      await say('hi');
      await say('banana');
      expect((await conversation())?.invalidCount).toBe(1);

      await say('1');
      expect((await conversation())?.invalidCount).toBe(0);
    });

    it('treats a voice note as invalid input, not an error', async () => {
      await say('hi');
      const reply = await say('', { type: 'audio', hasMedia: true, body: '' });
      expect(reply).toContain("didn't catch that");
    });
  });

  describe('the ambiguity the pending-prompt interceptor exists for', () => {
    it('reads a bare "4" as a rating when one is outstanding, not a menu pick', async () => {
      await walkToConfirming();
      await say('yes');
      const booking = await Booking.findOne({ businessId, clientId });

      await writePendingPrompt(
        redis,
        businessId,
        clientId,
        { kind: 'rating', bookingId: String(booking!._id) },
        600,
      );

      // Without the interceptor this "4" would start a booking for service #4.
      expect(await say('4')).toContain('Thanks for the feedback');
      expect(await Booking.countDocuments({ businessId })).toBe(1);
    });

    it('stops asking once the rating is answered', async () => {
      await walkToConfirming();
      await say('yes');
      const booking = await Booking.findOne({ businessId, clientId });
      await writePendingPrompt(
        redis,
        businessId,
        clientId,
        { kind: 'rating', bookingId: String(booking!._id) },
        600,
      );

      await say('5');
      expect(await say('hi')).toContain('Hydrafacial'); // a normal new booking
    });
  });

  describe('races and edge cases', () => {
    it('re-offers instead of double booking when the slot goes at confirm', async () => {
      await walkToConfirming();
      const held = await conversation();

      // Someone else committed the slot while this customer was reading the
      // confirmation. Writing the occupancy rows directly is exactly what their
      // transaction would have done.
      await SlotOccupancy.create({
        businessId,
        staffId: held!.heldStaffId,
        slotStart: new Date(held!.slotStart!),
        bookingId: 'someone-elses-booking',
      });

      const reply = await say('yes');
      expect(reply).toContain('just went');
      expect(reply).toContain('Available times');

      // No booking for this customer, and the conversation is usable, not stuck.
      expect(await Booking.countDocuments({ businessId, clientId })).toBe(0);
      expect((await conversation())?.state).toBe(CONVERSATION_STATE.SELECTING_SLOT);
    });

    /**
     * The TTLs disagree on purpose: holds last 5 minutes, conversations 30. A
     * customer who takes a phone call mid-booking lands here routinely.
     */
    it('still books when the hold expired but the slot is free', async () => {
      await walkToConfirming();
      const held = await conversation();
      expect(held!.holdToken).toBeTruthy();

      // The hold's TTL, fast-forwarded. Deleting only the hold keys leaves the
      // conversation intact — exactly the state the mismatch produces.
      const holdKeys = await redis.keys(`hold:${businessId}:*`);
      expect(holdKeys.length).toBeGreaterThan(0);
      await redis.del(...holdKeys);

      // The hold is advisory. Nothing else wants this slot, so the customer
      // must not be punished for reading slowly.
      expect(await say('yes')).toContain("You're booked");
      expect(await Booking.countDocuments({ businessId, clientId })).toBe(1);
    });

    it('re-offers when the hold expired AND someone else took the slot', async () => {
      await walkToConfirming();
      const held = await conversation();

      const holdKeys = await redis.keys(`hold:${businessId}:*`);
      await redis.del(...holdKeys);

      // Someone else's booking committed in the gap.
      await SlotOccupancy.create({
        businessId,
        staffId: held!.heldStaffId,
        slotStart: new Date(held!.slotStart!),
        bookingId: 'someone-elses-booking',
      });

      expect(await say('yes')).toContain('just went');
      expect(await Booking.countDocuments({ businessId, clientId })).toBe(0);
    });

    it('serialises two messages sent faster than processing', async () => {
      await say('hi');
      provider.clear();

      // Both pick service 1. Without the lock both would read SELECTING_SERVICE
      // and both would advance it.
      await Promise.all([
        handleInboundMessage({ redis, provider }, inbound('1')),
        handleInboundMessage({ redis, provider }, inbound('1')),
      ]);

      // Exactly one advanced the conversation; the other was dropped.
      const state = (await conversation())?.state;
      expect([CONVERSATION_STATE.SELECTING_STAFF, CONVERSATION_STATE.SELECTING_DATE]).toContain(
        state,
      );
    });

    it('starts clean after the conversation TTL expires', async () => {
      await say('hi');
      await say('1');
      await redis.del(`conv:${businessId}:${clientId}`); // the 30-min TTL

      // No stale half-booking — a fresh greeting, from the top.
      const reply = await say('1');
      expect(reply).toContain('Welcome');
      expect((await conversation())?.state).toBe(CONVERSATION_STATE.SELECTING_SERVICE);
    });

    it('ignores group chats and its own messages', async () => {
      await say('hi', { isGroup: true });
      expect(provider.sent).toHaveLength(0);

      await say('hi', { fromMe: true });
      expect(provider.sent).toHaveLength(0);
    });

    it('ignores a message for a session no business owns', async () => {
      await say('hi', { sessionId: 'not-a-real-session' });
      expect(provider.sent).toHaveLength(0);
    });

    it('records lastInboundAt for session health', async () => {
      await say('hi');
      const business = await Business.findById(businessId);
      expect(business?.whatsapp?.lastInboundAt).toBeInstanceOf(Date);
    });
  });
});
