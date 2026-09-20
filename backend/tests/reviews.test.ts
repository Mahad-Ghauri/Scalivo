import mongoose from 'mongoose';
import { Redis } from 'ioredis';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { InboundMessage, MessagingProvider, SendResult } from '@scalivo/shared';
import {
  BOOKING_STATUS,
  DELIVERY_STATUS,
  NOTIFICATION_KIND,
  REVIEW_REQUEST_DELAY_MINUTES,
  REVIEW_REQUEST_MAX_LATE_HOURS,
  SESSION_STATUS,
} from '@scalivo/shared';
import { Booking } from '../src/models/Booking.js';
import { Business } from '../src/models/Business.js';
import { Client } from '../src/models/Client.js';
import { Notification } from '../src/models/Notification.js';
import { Review } from '../src/models/Review.js';
import { Service } from '../src/models/Service.js';
import { Staff } from '../src/models/Staff.js';
import { setBookingOutcome } from '../src/bookings/outcome.js';
import { requestReviewsFor } from '../src/reviews/request.js';
import { retryPending } from '../src/notifications/send.js';
import { handleInboundMessage } from '../src/whatsapp/router.js';
import { readConversation, readPendingPrompt, writePendingPrompt } from '../src/whatsapp/state.js';
import { CONVERSATION_STATE } from '../src/whatsapp/fsm/states.js';
import { getBusinessBySlug } from '../src/public/profiles.js';
import { addMinutes } from '../src/lib/time.js';
import { infraReady } from './infra.js';

/**
 * Review collection — milestone 2.2, SPEC §9.
 *
 * Two properties carry the whole feature, and each is easy to get almost right:
 *
 * 1. **Asked once, and only about a visit that happened.** A pass that sends on
 *    every tick looks correct in a single-run test, so every request test here
 *    runs the pass TWICE. A customer who cancelled or never turned up must not
 *    be asked how it went, and that is the case the generic "is the booking
 *    over?" guard in send.ts used to get wrong in the other direction.
 *
 * 2. **A low rating never reaches a stranger.** Asserted on the PUBLIC profile
 *    projection rather than on the Review document — a test that only checks
 *    `published === false` would pass against a profile page that ignores the
 *    flag, which is the only way this failure ever actually happens.
 *
 * Needs Mongo (replica set, for the outcome transaction) and Redis.
 */

const TZ = 'Asia/Karachi';
const SESSION_ID = 'test-session-reviews';
const LID = '1779000000442@lid';

class FakeProvider implements MessagingProvider {
  readonly name = 'fake';
  sent: string[] = [];
  /** Set to make every send throw, the way a dead session does. */
  down = false;

  async sendText(_sessionId: string, _to: string, text: string): Promise<SendResult> {
    if (this.down) throw new Error('session is down');
    this.sent.push(text);
    return { providerMessageId: `rev-${Math.random()}`, acceptedAt: new Date() };
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
    /* never provisions on this path */
  }
  async getSessionPhone() {
    return '923004440001';
  }
  async resolveContactPhone() {
    return '923004440001';
  }
  parseWebhook() {
    return [];
  }
  clear() {
    this.sent = [];
  }
}

function inbound(body: string): InboundMessage {
  return {
    providerMessageId: `in-${Math.random()}`,
    sessionId: SESSION_ID,
    contactPhone: '923004440001',
    contactLid: LID,
    body,
    type: 'text',
    receivedAt: new Date(),
    fromMe: false,
    isGroup: false,
    displayName: 'Hina Raza',
    hasMedia: false,
  };
}

const infraUp = await infraReady({ replicaSet: true, redis: true });

describe.skipIf(!infraUp)('review collection', () => {
  let redis: Redis;
  let provider: FakeProvider;
  let businessId: string;
  let clientId: string;
  let serviceId: string;
  let staffId: string;

  /** One customer message through the whole interceptor chain. */
  async function say(text: string): Promise<string> {
    provider.clear();
    await handleInboundMessage({ redis, provider }, inbound(text));
    return provider.sent.join('\n');
  }

  /**
   * A booking that happened and was marked done `minutesAgo` ago.
   *
   * Written directly rather than booked through the FSM: this suite is about
   * what happens AFTER an appointment, and walking the menus for each one would
   * make every test here depend on availability logic it does not test.
   */
  async function completedBooking(minutesAgo: number, now = new Date()): Promise<string> {
    const booking = await Booking.create({
      businessId,
      staffId,
      clientId,
      serviceId,
      startsAt: addMinutes(now, -minutesAgo - 60),
      durationMinutes: 45,
      status: BOOKING_STATUS.CONFIRMED,
      priceMinor: 800_000,
      source: 'whatsapp',
    });

    const bookingId = String(booking._id);
    // Through the real outcome path, so completedAt is stamped the way
    // production stamps it rather than by this test asserting its own fixture.
    await setBookingOutcome(bookingId, businessId, BOOKING_STATUS.COMPLETED);
    await Booking.updateOne({ _id: bookingId }, { $set: { completedAt: addMinutes(now, -minutesAgo) } });

    return bookingId;
  }

  /** The pass, as the cron runs it, for this business only. */
  async function runPass(now = new Date()): Promise<void> {
    const business = await Business.findById(businessId);
    await requestReviewsFor({ redis, provider }, business!, now);
  }

  const requests = () =>
    Notification.countDocuments({ businessId, kind: NOTIFICATION_KIND.REVIEW_REQUEST });

  beforeAll(async () => {
    // Its own Redis database — this suite flushes, and vitest runs files in
    // parallel. Sharing db 0 would wipe another suite's conversations mid-test.
    redis = new Redis(process.env.REDIS_URL!, { db: 4 });
    provider = new FakeProvider();
    await Review.syncIndexes();
  });

  afterAll(async () => {
    await Promise.all([mongoose.disconnect(), redis.quit()]);
  });

  beforeEach(async () => {
    const business = await Business.findOneAndUpdate(
      { slug: 'reviews-test' },
      {
        slug: 'reviews-test',
        name: 'Reviews Test Salon',
        category: 'salon',
        timezone: TZ,
        slotIncrementMinutes: 15,
        minNoticeMinutes: 60,
        bookingHorizonDays: 30,
        published: true,
        whatsapp: { sessionId: SESSION_ID },
      },
      { upsert: true, new: true, setDefaultsOnInsert: true },
    );
    businessId = String(business._id);

    await Promise.all([
      Booking.deleteMany({ businessId }),
      Notification.deleteMany({ businessId }),
      Review.deleteMany({ businessId }),
      Service.deleteMany({ businessId }),
      Staff.deleteMany({ businessId }),
      Client.deleteMany({ lids: LID }),
      redis.flushdb(),
    ]);

    const service = await Service.create({
      businessId,
      name: 'Hydrafacial',
      durationMinutes: 45,
      priceMinor: 800_000,
      displayOrder: 1,
    });
    serviceId = String(service._id);

    const staff = await Staff.create({
      businessId,
      name: 'Ayesha',
      serviceIds: [serviceId],
      workingHours: [0, 1, 2, 3, 4, 5, 6].map((dayOfWeek) => ({
        dayOfWeek,
        opensAt: '09:00',
        closesAt: '18:00',
        breaks: [],
      })),
    });
    staffId = String(staff._id);

    const client = await Client.create({
      phone: '923004440001',
      lids: [LID],
      displayName: 'Hina Raza',
    });
    clientId = String(client._id);
    provider.clear();
  });

  describe('asking', () => {
    it('asks once, a delay after the appointment was completed', async () => {
      await completedBooking(REVIEW_REQUEST_DELAY_MINUTES + 10);

      await runPass();
      expect(provider.sent.join('\n')).toContain('1 to 5');
      expect(await requests()).toBe(1);

      // The pass runs every five minutes forever. Running it again is the
      // realistic case, not an unusual one.
      provider.clear();
      await runPass();
      expect(provider.sent).toHaveLength(0);
      expect(await requests()).toBe(1);
    });

    it('arms the pending prompt, so the reply is a rating and not a menu pick', async () => {
      const bookingId = await completedBooking(REVIEW_REQUEST_DELAY_MINUTES + 10);
      await runPass();

      expect(await readPendingPrompt(redis, businessId, clientId)).toEqual({
        kind: 'rating',
        bookingId,
      });
    });

    it('waits out the delay rather than asking on the way out of the door', async () => {
      await completedBooking(REVIEW_REQUEST_DELAY_MINUTES - 30);

      await runPass();
      expect(await requests()).toBe(0);
    });

    it('never asks about an appointment old enough to have been forgotten', async () => {
      await completedBooking(REVIEW_REQUEST_MAX_LATE_HOURS * 60 + 60);

      // This is the bound that stops the first run after an outage — or after
      // this feature shipped — messaging every customer the business ever had.
      await runPass();
      expect(await requests()).toBe(0);
    });

    it('honours a marketing opt-out, unlike a confirmation or a reminder', async () => {
      await Client.updateOne({ _id: clientId }, { $set: { marketingOptOut: true } });
      await completedBooking(REVIEW_REQUEST_DELAY_MINUTES + 10);

      await runPass();
      expect(await requests()).toBe(0);
    });

    it('does not ask a customer who never turned up how it went', async () => {
      const booking = await Booking.create({
        businessId,
        staffId,
        clientId,
        serviceId,
        startsAt: addMinutes(new Date(), -300),
        durationMinutes: 45,
        status: BOOKING_STATUS.CONFIRMED,
        priceMinor: 800_000,
        source: 'whatsapp',
      });
      await setBookingOutcome(String(booking._id), businessId, BOOKING_STATUS.NO_SHOW);

      await runPass();
      expect(await requests()).toBe(0);
    });

    it('drops a request owed from an outage once the visit is un-completed', async () => {
      const bookingId = await completedBooking(REVIEW_REQUEST_DELAY_MINUTES + 10);

      // Claimed on Saturday with the session down, so it stays QUEUED.
      provider.down = true;
      await runPass();
      expect(
        (await Notification.findOne({ bookingId, kind: NOTIFICATION_KIND.REVIEW_REQUEST }))?.status,
      ).toBe(DELIVERY_STATUS.QUEUED);

      // The owner corrects a mis-tap on Sunday: they never actually came in.
      await Booking.updateOne({ _id: bookingId }, { $set: { status: BOOKING_STATUS.CANCELLED } });

      // Session back. The drain must not ask about an appointment that no
      // longer happened — the send path re-reads the booking for exactly this.
      provider.down = false;
      provider.clear();
      await retryPending({ redis, provider }, businessId);

      expect(
        (await Notification.findOne({ bookingId, kind: NOTIFICATION_KIND.REVIEW_REQUEST }))?.status,
      ).toBe(DELIVERY_STATUS.SKIPPED);
      expect(provider.sent).toHaveLength(0);
    });
  });

  describe('answering', () => {
    async function askAbout(): Promise<string> {
      const bookingId = await completedBooking(REVIEW_REQUEST_DELAY_MINUTES + 10);
      await runPass();
      return bookingId;
    }

    it('publishes a 5 with its comment, on the public profile', async () => {
      const bookingId = await askAbout();

      expect(await say('5')).toContain('few words');
      expect((await readConversation(redis, businessId, clientId))?.state).toBe(
        CONVERSATION_STATE.AWAITING_REVIEW_COMMENT,
      );

      expect(await say('Ayesha was lovely and my skin looks great')).toContain('on our profile');

      const review = await Review.findOne({ bookingId });
      expect(review?.rating).toBe(5);
      expect(review?.published).toBe(true);
      expect(review?.authorName).toBe('Hina'); // first name only — never the phone
      expect(review?.serviceName).toBe('Hydrafacial');

      const profile = await getBusinessBySlug('reviews-test');
      expect(profile?.reviews.map((r) => r.comment)).toContain(
        'Ayesha was lovely and my skin looks great',
      );
    });

    it('keeps a 2 off the profile and thanks the customer anyway', async () => {
      const bookingId = await askAbout();

      const reply = await say('2');
      expect(reply).toContain("sorry it wasn't better");
      // Never asked to write it down: that is the complaint going public.
      expect(reply).not.toContain('few words');

      const review = await Review.findOne({ bookingId });
      expect(review?.rating).toBe(2);
      expect(review?.published).toBe(false);

      const profile = await getBusinessBySlug('reviews-test');
      expect(profile?.reviews).toHaveLength(0);
      expect(profile?.rating).toBeNull();
    });

    it('re-prompts a rating that is not a number from 1 to 5', async () => {
      const bookingId = await askAbout();

      expect(await say('9')).toContain('1 to 5');
      expect(await say('lovely thanks')).toContain('1 to 5');
      expect(await Review.countDocuments({ bookingId })).toBe(0);

      // And still takes the real answer afterwards.
      expect(await say('4')).toContain('few words');
    });

    it('records one review however many times the question is answered', async () => {
      const bookingId = await askAbout();

      await say('5');
      await say('skip');

      // Re-arming is what a duplicate webhook delivery of the request, or a
      // second pass against a re-opened booking, would leave behind. The unique
      // index on bookingId is the guard, not a look-before-writing.
      await writePendingPrompt(redis, businessId, clientId, { kind: 'rating', bookingId }, 600);
      expect(await say('2')).toContain('Thanks');

      const reviews = await Review.find({ bookingId });
      expect(reviews).toHaveLength(1);
      // The first answer stands. A second rating does not overwrite the first,
      // which is what keeps a published 5 from being quietly demoted.
      expect(reviews[0]?.rating).toBe(5);
    });

    it('takes the rating but publishes nothing when the visit is no longer completed', async () => {
      const bookingId = await askAbout();
      await Booking.updateOne({ _id: bookingId }, { $set: { status: BOOKING_STATUS.CANCELLED } });

      expect(await say('5')).toContain('Thanks');
      expect(await Review.countDocuments({ bookingId })).toBe(0);
    });

    it('treats a greeting after a rating as a new conversation, not a review', async () => {
      const bookingId = await askAbout();
      await say('5');

      // Taken literally, this publishes "hi" on the profile forever.
      expect(await say('hi')).not.toContain('on our profile');
      expect((await Review.findOne({ bookingId }))?.comment).toBe('');
    });
  });

  describe('the metric', () => {
    it('counts the capture rate over requests sent, not appointments held', async () => {
      await completedBooking(REVIEW_REQUEST_DELAY_MINUTES + 10);
      await runPass();
      await say('5');
      await say('skip');

      // A second visit, asked and unanswered.
      await completedBooking(REVIEW_REQUEST_DELAY_MINUTES + 20);
      await runPass();

      expect(await requests()).toBe(2);
      expect(await Review.countDocuments({ businessId, bookingId: { $ne: null } })).toBe(1);
    });
  });
});
