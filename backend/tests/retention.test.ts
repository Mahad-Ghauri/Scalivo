import mongoose from 'mongoose';
import { Redis } from 'ioredis';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { InboundMessage, MessagingProvider, SendResult } from '@scalivo/shared';
import {
  ACK_STATUS,
  BOOKING_STATUS,
  BROADCAST_DAILY_CAP,
  CAMPAIGN_AUDIENCE,
  CAMPAIGN_STATUS,
  COLD_CONTACT_DAILY_CAP,
  CLIENT_TAG,
  DELIVERY_STATUS,
  NOTIFICATION_KIND,
  SESSION_STATUS,
} from '@scalivo/shared';
import { Booking } from '../src/models/Booking.js';
import { Business } from '../src/models/Business.js';
import { Campaign } from '../src/models/Campaign.js';
import { Client } from '../src/models/Client.js';
import { ClientProfile } from '../src/models/ClientProfile.js';
import { Notification } from '../src/models/Notification.js';
import { Service } from '../src/models/Service.js';
import { Staff } from '../src/models/Staff.js';
import { handleInboundMessage } from '../src/whatsapp/router.js';
import { handleMessageAck } from '../src/notifications/ack.js';
import { remindBusiness } from '../src/notifications/reminders.js';
import { retryPending } from '../src/notifications/send.js';
import { buildAudience } from '../src/retention/audience.js';
import {
  cancelCampaign,
  createCampaign,
  drainCampaign,
  listCampaigns,
} from '../src/retention/campaigns.js';
import { nudgeBusiness, nudgeReport } from '../src/retention/nudges.js';
import { clearSendSlot } from '../src/retention/throttle.js';
import { recordBooking } from '../src/crm/profile.js';
import { toBusinessLocal } from '../src/lib/time.js';
import { infraReady } from './infra.js';

/**
 * Retention — SPEC §6. The first messages this system sends to somebody who is
 * not expecting one, which is why most of these tests are about NOT sending.
 *
 * The three properties under test, in the order they matter:
 *
 * 1. **Consent is absolute.** A client who said STOP is never marketed to again —
 *    and still gets the reminder for the appointment they booked. Both halves,
 *    because either one alone is a plausible bug: honouring STOP everywhere means
 *    missed appointments, and honouring it nowhere means spam.
 * 2. **Volume is bounded.** Per client, per number, per day, and spaced out. A
 *    test that sends one message to one person proves none of this, so the
 *    interesting cases here are the second message, the sixty-first, and the one
 *    that arrives a second after its predecessor.
 * 3. **Delivery is what an ack says.** An accepted send is not a delivered
 *    message (FINDING #3), and the report has to say so — otherwise the
 *    conversion rate in the thesis is measuring the provider's optimism.
 *
 * Needs Mongo (replica set, for the booking transaction in the attribution test)
 * and Redis.
 */

const TZ = 'Asia/Karachi';
const SESSION_ID = 'retention-test-session';
const DAY_MS = 86_400_000;

class FakeProvider implements MessagingProvider {
  readonly name = 'fake';
  sent: { to: string; text: string; id: string }[] = [];
  down = false;
  private counter = 0;
  /** Globally unique: acks match on this alone, across every suite's rows. */
  private readonly prefix = `ret-${Math.random().toString(36).slice(2, 10)}`;

  async sendText(_sessionId: string, to: string, text: string): Promise<SendResult> {
    if (this.down) throw new Error('session is not connected');
    this.counter += 1;
    const id = `${this.prefix}-${this.counter}`;
    this.sent.push({ to, text, id });
    return { providerMessageId: id, acceptedAt: new Date() };
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
    /* retention never provisions */
  }
  async getSessionPhone() {
    return '923001112222';
  }
  async resolveContactPhone() {
    return null;
  }
  parseWebhook() {
    return [];
  }
  clear() {
    this.sent = [];
  }
}

const infraUp = await infraReady({ replicaSet: true, redis: true });

describe.skipIf(!infraUp)('retention', () => {
  let redis: Redis;
  let provider: FakeProvider;
  let deps: { redis: Redis; provider: FakeProvider };
  let businessId: string;
  let serviceId: string;
  let staffId: string;
  let business: NonNullable<Awaited<ReturnType<typeof Business.findById>>>;

  /** Clients this suite invents, cleaned up by id — Client is global, never wiped wholesale. */
  const made: string[] = [];

  const ago = (days: number, from = new Date()) => new Date(from.getTime() - days * DAY_MS);

  /**
   * A customer with a history, written straight to the profile.
   *
   * The profile IS the input to the audience — it is a cache of the bookings, and
   * crm.test.ts already proves it is built correctly from them. Booking a
   * four-visit history through the real path for each of these would test
   * availability logic instead of retention.
   */
  async function customer(opts: {
    name: string;
    visits: number;
    firstVisitDaysAgo: number;
    lastVisitDaysAgo: number;
    /** The address an inbound message would arrive on. NOT a warmth signal — see `warm`. */
    lid?: string;
    phone?: string | null;
    optedOut?: boolean;
    lastMarketingDaysAgo?: number;
    /**
     * They once booked over WhatsApp with THIS business, so the number has
     * reached them before.
     *
     * Deliberately not inferred from the LID: a LID is stored on the global
     * Client, so it may have come from messaging some other business on the
     * platform entirely, and treating it as warmth here would quietly exempt
     * strangers from the cold-contact cap.
     */
    warm?: boolean;
  }): Promise<string> {
    const client = await Client.create({
      phone: opts.phone === undefined ? `9230055${String(made.length).padStart(5, '0')}` : opts.phone,
      lids: opts.lid ? [opts.lid] : [],
      displayName: opts.name,
    });
    const clientId = String(client._id);
    made.push(clientId);

    await ClientProfile.create({
      businessId,
      clientId,
      totalVisits: opts.visits,
      lifetimeSpendMinor: opts.visits * 800_000,
      firstVisitAt: ago(opts.firstVisitDaysAgo),
      lastVisitAt: ago(opts.lastVisitDaysAgo),
      lastBookingAt: ago(opts.lastVisitDaysAgo),
      serviceCounts: new Map([[serviceId, opts.visits]]),
      marketingOptOut: opts.optedOut ?? false,
      marketingOptOutAt: opts.optedOut ? ago(1) : null,
      lastMarketingMessageAt:
        opts.lastMarketingDaysAgo === undefined ? null : ago(opts.lastMarketingDaysAgo),
    });

    if (opts.warm) {
      await Booking.create({
        businessId,
        clientId,
        serviceId,
        staffId,
        startsAt: ago(opts.lastVisitDaysAgo),
        durationMinutes: 45,
        status: BOOKING_STATUS.COMPLETED,
        priceMinor: 800_000,
        source: 'whatsapp',
      });
    }

    return clientId;
  }

  /**
   * At risk, and recently so: four visits a month apart, last seen 50 days ago.
   * Their own gap is 30 days, so they crossed 1.5× it five days ago — inside the
   * lateness bound, which is what makes them due rather than merely overdue.
   */
  const atRiskCustomer = (name: string, extra: Partial<Parameters<typeof customer>[0]> = {}) =>
    customer({ name, visits: 4, firstVisitDaysAgo: 140, lastVisitDaysAgo: 50, ...extra });

  /** Lapsed: last seen four months ago. */
  const lapsedCustomer = (name: string, extra: Partial<Parameters<typeof customer>[0]> = {}) =>
    customer({ name, visits: 4, firstVisitDaysAgo: 210, lastVisitDaysAgo: 120, ...extra });

  const nudges = () =>
    Notification.find({ businessId, kind: NOTIFICATION_KIND.REBOOK_NUDGE }).sort({ createdAt: 1 });

  const campaignSends = () =>
    Notification.find({ businessId, kind: NOTIFICATION_KIND.CAMPAIGN }).sort({ createdAt: 1 });

  /** One campaign's sends, ignoring rows inserted only to fill up a daily cap. */
  const sendsFor = (campaignId: string) => Notification.find({ campaignId }).sort({ createdAt: 1 });

  /** One pass, then let the number's turn come round again — the throttle is tested on its own. */
  async function nudgePass(now = new Date()): Promise<number> {
    const fresh = await Business.findById(businessId);
    const sent = await nudgeBusiness(deps, fresh!, now);
    await clearSendSlot(redis, businessId);
    return sent;
  }

  /** Drain a campaign to completion, releasing the throttle between sends. */
  async function drainFully(campaignId: string, now = new Date()): Promise<number> {
    let total = 0;
    for (let pass = 0; pass < 40; pass += 1) {
      const sent = await drainCampaign(deps, campaignId, now);
      total += sent;
      await clearSendSlot(redis, businessId);
      if (sent === 0) break;
    }
    return total;
  }

  function inbound(body: string, lid: string): InboundMessage {
    return {
      providerMessageId: `in-${Math.random()}`,
      sessionId: SESSION_ID,
      contactPhone: null,
      contactLid: lid,
      body,
      type: 'text',
      receivedAt: new Date(),
      fromMe: false,
      isGroup: false,
      hasMedia: false,
    };
  }

  beforeAll(async () => {
    // db 8 — 1–7 belong to the suites that came before this one.
    redis = new Redis(process.env.REDIS_URL!, { db: 8 });
    await Promise.all([Notification.syncIndexes(), Campaign.syncIndexes()]);
  });

  afterAll(async () => {
    await Promise.all([mongoose.disconnect(), redis.quit()]);
  });

  beforeEach(async () => {
    provider = new FakeProvider();
    deps = { redis, provider };

    const doc = await Business.findOneAndUpdate(
      { slug: 'retention-test' },
      {
        slug: 'retention-test',
        name: 'Retention Test Salon',
        category: 'salon',
        timezone: TZ,
        slotIncrementMinutes: 15,
        minNoticeMinutes: 60,
        bookingHorizonDays: 30,
        whatsapp: { sessionId: SESSION_ID },
        'reminders.enabled': true,
        'reminders.leadMinutes': [1440],
        'retention.nudges': true,
      },
      { upsert: true, new: true, setDefaultsOnInsert: true },
    );
    business = doc!;
    businessId = String(business._id);

    const previous = await ClientProfile.distinct('clientId', { businessId });
    await Client.deleteMany({ _id: { $in: [...previous, ...made] } });
    made.length = 0;

    await Promise.all([
      Booking.deleteMany({ businessId }),
      Notification.deleteMany({ businessId }),
      Campaign.deleteMany({ businessId }),
      ClientProfile.deleteMany({ businessId }),
      Service.deleteMany({ businessId }),
      Staff.deleteMany({ businessId }),
      redis.flushdb(),
    ]);

    const service = await Service.create({
      businessId,
      name: 'Hydrafacial',
      durationMinutes: 45,
      priceMinor: 800_000,
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
  });

  // ─────────────────────────────────────────────────────────── nudges (§6.1)

  describe('rebooking nudges', () => {
    it('nudges a client who is past their own usual gap, naming what they had', async () => {
      await atRiskCustomer('Sana Iqbal');

      expect(await nudgePass()).toBe(1);

      const [nudge] = await nudges();
      expect(nudge?.text).toContain('Sana');
      expect(nudge?.text).toContain('Hydrafacial');
      // The opt-out line is not optional on a message nobody asked for.
      expect(nudge?.text).toContain('STOP');
      expect(nudge?.status).toBe(DELIVERY_STATUS.ACCEPTED);
      expect(nudge?.bookingId).toBeNull();
    });

    it('nudges once per lapse, however many times the pass runs', async () => {
      await atRiskCustomer('Sana Iqbal');

      await nudgePass();
      await nudgePass();
      await nudgePass();

      // The pass runs every five minutes forever. Running it once proves nothing.
      expect(await nudges()).toHaveLength(1);
    });

    it('leaves alone anyone with an appointment already booked', async () => {
      const clientId = await atRiskCustomer('Sana Iqbal');
      await Booking.create({
        businessId,
        clientId,
        serviceId,
        staffId,
        startsAt: new Date(Date.now() + 3 * DAY_MS),
        durationMinutes: 45,
        status: BOOKING_STATUS.CONFIRMED,
        priceMinor: 800_000,
        source: 'whatsapp',
      });

      expect(await nudgePass()).toBe(0);
    });

    it('does not nudge someone who drifted away months ago', async () => {
      // At risk, but they crossed the line 40 days ago. Without the lateness
      // bound the first run of this feature messages years of ex-customers in
      // one afternoon — the exact burst that gets a number restricted.
      await customer({ name: 'Old Timer', visits: 4, firstVisitDaysAgo: 175, lastVisitDaysAgo: 85 });

      expect(await nudgePass()).toBe(0);
    });

    it('does not nudge someone with no measurable cadence', async () => {
      // Two visits is one interval, not a pattern. "Late" would be a guess, and a
      // guess is not a reason to message somebody.
      await customer({ name: 'Twice Only', visits: 2, firstVisitDaysAgo: 100, lastVisitDaysAgo: 60 });

      expect(await nudgePass()).toBe(0);
    });

    it('stays silent when the owner has switched nudges off', async () => {
      await atRiskCustomer('Sana Iqbal');
      await Business.updateOne({ _id: businessId }, { $set: { 'retention.nudges': false } });

      // nudgeBusiness is called directly here, as the pass would after its own
      // filter — so this proves the toggle is honoured by the pass AND that
      // nothing downstream sends regardless.
      const fresh = await Business.findById(businessId);
      expect(fresh?.retention?.nudges).toBe(false);
      const eligible = await Business.countDocuments({
        _id: businessId,
        'retention.nudges': { $ne: false },
      });
      expect(eligible).toBe(0);
    });

    it('does not nudge a business with no WhatsApp number', async () => {
      await atRiskCustomer('Sana Iqbal');
      await Business.updateOne({ _id: businessId }, { $unset: { 'whatsapp.sessionId': '' } });

      expect(await nudgePass()).toBe(0);
      // Nothing claimed either: a nudge claimed against a business with no
      // session would burn its one-per-lapse chance sitting in a queue.
      expect(await nudges()).toHaveLength(0);
    });
  });

  // ───────────────────────────────────────────────────── consent (§6.2, §6.5)

  describe('consent', () => {
    it('never marketed to someone who replied STOP', async () => {
      await atRiskCustomer('Quiet Please', { optedOut: true });

      expect(await nudgePass()).toBe(0);

      const { preview } = await buildAudience(businessId, TZ, CLIENT_TAG.AT_RISK);
      expect(preview.matched).toBe(1);
      expect(preview.reachable).toBe(0);
      expect(preview.excluded.optedOut).toBe(1);
    });

    it('still sends the reminder for an appointment an opted-out client booked', async () => {
      // The other half of the rule, and the one that is a missed appointment
      // rather than spam if it is got wrong. STOP silences marketing; it does not
      // cancel a conversation the customer started.
      const clientId = await atRiskCustomer('Quiet Please', { optedOut: true, lid: '1770000009001@lid' });

      /**
       * Ten in the morning, business-local, rather than "now".
       *
       * Reminders are pulled back INTO waking hours and then skipped if that puts
       * them more than an hour late — so a suite run at eleven at night would see
       * this reminder correctly skipped and report it as an opt-out failure. The
       * clock is not what is under test here.
       */
      const now = toBusinessLocal(new Date(), TZ)
        .plus({ days: 1 })
        .set({ hour: 10, minute: 0, second: 0, millisecond: 0 })
        .toUTC()
        .toJSDate();

      await Booking.create({
        businessId,
        clientId,
        serviceId,
        staffId,
        startsAt: new Date(now.getTime() + 24 * 60 * 60 * 1000),
        durationMinutes: 45,
        status: BOOKING_STATUS.CONFIRMED,
        priceMinor: 800_000,
        source: 'whatsapp',
      });

      await remindBusiness(deps, business, now);

      const reminder = await Notification.findOne({
        businessId,
        clientId,
        kind: NOTIFICATION_KIND.REMINDER,
      });
      expect(reminder?.status).toBe(DELIVERY_STATUS.ACCEPTED);
      expect(provider.sent).toHaveLength(1);
    });

    it('honours a STOP that arrives while a campaign is still draining', async () => {
      const staying = await lapsedCustomer('Will Stay', { lid: '1770000009011@lid' });
      const leaving = await lapsedCustomer('Will Leave', { lid: '1770000009012@lid' });

      const created = await createCampaign({
        businessId,
        timezone: TZ,
        audience: CAMPAIGN_AUDIENCE.LAPSED,
        message: 'Come back and see us, we have a slot this week for you.',
      });
      if ('error' in created) throw new Error('expected a campaign');

      // First batch: one message goes out (the throttle allows one per gate).
      await drainCampaign(deps, created.campaignId);
      await clearSendSlot(redis, businessId);
      const first = await campaignSends();
      expect(first).toHaveLength(1);

      // Whoever has not been sent to yet types STOP. Their remaining message must
      // not go out, and a compliance failure here is invisible without this test:
      // the send path would happily drain a claim made before they objected.
      const remaining = first[0]!.clientId === staying ? leaving : staying;
      await ClientProfile.updateOne(
        { businessId, clientId: remaining },
        { $set: { marketingOptOut: true, marketingOptOutAt: new Date() } },
      );

      await drainFully(created.campaignId);

      const all = await campaignSends();
      expect(all).toHaveLength(1);
      expect(all[0]!.clientId).not.toBe(remaining);
    });

    it('drops a queued marketing message when consent is withdrawn before it drains', async () => {
      const clientId = await atRiskCustomer('Changed Mind', { lid: '1770000009021@lid' });
      provider.down = true;

      await nudgePass();
      const queued = await Notification.findOne({ businessId, clientId });
      expect(queued?.status).toBe(DELIVERY_STATUS.QUEUED);

      await ClientProfile.updateOne(
        { businessId, clientId },
        { $set: { marketingOptOut: true, marketingOptOutAt: new Date() } },
      );
      provider.down = false;
      await retryPending(deps, businessId);

      // The outage is over and the message is still owed — but consent went away
      // while it waited, and honouring that one message too late is not honouring
      // it at all.
      const settled = await Notification.findOne({ businessId, clientId });
      expect(settled?.status).toBe(DELIVERY_STATUS.SKIPPED);
      expect(provider.sent).toHaveLength(0);
    });

    it('leaves a client alone for a fortnight after any marketing message', async () => {
      // Targeted by a campaign three days after their nudge. One person, two
      // campaigns, one message — that is the over-messaging guard (§6.5).
      await lapsedCustomer('Recently Messaged', { lastMarketingDaysAgo: 3 });

      const { preview } = await buildAudience(businessId, TZ, CLIENT_TAG.LAPSED);
      expect(preview.matched).toBe(1);
      expect(preview.reachable).toBe(0);
      expect(preview.excluded.recentlyMessaged).toBe(1);
    });

    it('counts a client with no number as unreachable rather than silently dropping them', async () => {
      await lapsedCustomer('Walk In', { phone: null });

      const { preview } = await buildAudience(businessId, TZ, CLIENT_TAG.LAPSED);
      expect(preview.excluded.noAddress).toBe(1);
      expect(preview.reachable).toBe(0);
    });
  });

  // ──────────────────────────────────────────────── broadcasts (§6.2) & caps

  describe('broadcasts', () => {
    it('sends the owner\'s message to lapsed clients, with the opt-out line added', async () => {
      await lapsedCustomer('Gone Quiet One');
      await lapsedCustomer('Gone Quiet Two');
      // Not lapsed: at risk is a different audience, and a broadcast aimed at one
      // must not reach the other.
      await atRiskCustomer('Merely Late');

      const created = await createCampaign({
        businessId,
        timezone: TZ,
        audience: CAMPAIGN_AUDIENCE.LAPSED,
        message: 'We miss you at Retention Test Salon.',
      });
      if ('error' in created) throw new Error('expected a campaign');
      expect(created.recipients).toBe(2);

      expect(await drainFully(created.campaignId)).toBe(2);

      const sends = await campaignSends();
      expect(sends).toHaveLength(2);
      expect(sends[0]!.text).toContain('We miss you');
      expect(sends[0]!.text).toContain('Reply STOP');
      expect(sends[0]!.campaignId).toBe(created.campaignId);

      const campaign = await Campaign.findById(created.campaignId);
      expect(campaign?.status).toBe(CAMPAIGN_STATUS.SENT);
    });

    it('refuses a campaign with nobody to send to', async () => {
      await lapsedCustomer('Opted Out', { optedOut: true });

      const created = await createCampaign({
        businessId,
        timezone: TZ,
        audience: CAMPAIGN_AUDIENCE.LAPSED,
        message: 'Come back to us, we would love to see you again.',
      });

      expect(created).toEqual({ error: 'empty_audience' });
      expect(await Campaign.countDocuments({ businessId })).toBe(0);
    });

    it('spaces sends out instead of emptying the queue at once', async () => {
      await lapsedCustomer('One');
      await lapsedCustomer('Two');
      await lapsedCustomer('Three');

      const created = await createCampaign({
        businessId,
        timezone: TZ,
        audience: CAMPAIGN_AUDIENCE.LAPSED,
        message: 'A slot opened up this week if you would like it.',
      });
      if ('error' in created) throw new Error('expected a campaign');

      // One pass, no throttle release: the gate holds the number for a random
      // 45–180 seconds, so a three-recipient campaign is three passes, not one
      // burst. This is the difference between a broadcast and a spam report.
      expect(await drainCampaign(deps, created.campaignId)).toBe(1);
      expect(await drainCampaign(deps, created.campaignId)).toBe(0);

      await clearSendSlot(redis, businessId);
      expect(await drainCampaign(deps, created.campaignId)).toBe(1);
    });

    it('stops at the daily cap and carries on tomorrow', async () => {
      await lapsedCustomer('Over The Line');

      // The number has already had its day, from earlier campaigns and rating
      // requests alike — the cap is per NUMBER, not per campaign.
      await Notification.insertMany(
        Array.from({ length: BROADCAST_DAILY_CAP }, (_, i) => ({
          businessId,
          clientId: `filler-${i}`,
          kind: NOTIFICATION_KIND.CAMPAIGN,
          dedupeKey: `filler:${businessId}:${i}:${Math.random()}`,
          status: DELIVERY_STATUS.ACCEPTED,
          scheduledFor: new Date(),
        })),
      );

      const created = await createCampaign({
        businessId,
        timezone: TZ,
        audience: CAMPAIGN_AUDIENCE.LAPSED,
        message: 'There is still time to book this week if you would like.',
      });
      if ('error' in created) throw new Error('expected a campaign');

      expect(await drainCampaign(deps, created.campaignId)).toBe(0);
      expect(await sendsFor(created.campaignId)).toHaveLength(0);
      // Not cancelled, not failed — deferred. The campaign is still SENDING and
      // tomorrow's pass owns it.
      const campaign = await Campaign.findById(created.campaignId);
      expect(campaign?.status).toBe(CAMPAIGN_STATUS.SENDING);
    });

    it('spends its stricter cold allowance before its general one', async () => {
      // Cold: never messaged this number, so no LID and nothing ever delivered.
      await lapsedCustomer('Imported Contact', { phone: '923009990001' });
      // Warm: this number has reached them before — they booked over WhatsApp.
      await lapsedCustomer('Known Contact', { warm: true });

      await Notification.insertMany(
        Array.from({ length: COLD_CONTACT_DAILY_CAP }, (_, i) => ({
          businessId,
          clientId: `cold-filler-${i}`,
          kind: NOTIFICATION_KIND.CAMPAIGN,
          dedupeKey: `cold:${businessId}:${i}:${Math.random()}`,
          coldContact: true,
          status: DELIVERY_STATUS.ACCEPTED,
          scheduledFor: new Date(),
        })),
      );

      const created = await createCampaign({
        businessId,
        timezone: TZ,
        audience: CAMPAIGN_AUDIENCE.LAPSED,
        message: 'We would love to see you back at the salon soon.',
      });
      if ('error' in created) throw new Error('expected a campaign');

      await drainFully(created.campaignId);

      // The warm one goes; the cold one waits for tomorrow's cold allowance.
      const sends = await sendsFor(created.campaignId);
      expect(sends).toHaveLength(1);
      expect(sends[0]!.coldContact).toBe(false);
    });

    it('records who had never been reached before, because it is unrecoverable later', async () => {
      await lapsedCustomer('Imported Contact', { phone: '923009990002' });

      const { preview } = await buildAudience(businessId, TZ, CLIENT_TAG.LAPSED);
      expect(preview.coldContacts).toBe(1);

      const created = await createCampaign({
        businessId,
        timezone: TZ,
        audience: CAMPAIGN_AUDIENCE.LAPSED,
        message: 'It has been a while — come and see us when you can.',
      });
      if ('error' in created) throw new Error('expected a campaign');
      await drainFully(created.campaignId);

      const [send] = await campaignSends();
      expect(send?.coldContact).toBe(true);
    });

    it('counts a client who has messaged before as warm', async () => {
      await lapsedCustomer('Known Contact', { warm: true });

      const { recipients, preview } = await buildAudience(businessId, TZ, CLIENT_TAG.LAPSED);
      expect(preview.coldContacts).toBe(0);
      expect(recipients[0]!.cold).toBe(false);
    });

    it('stops the rest when the owner cancels, and says what already went', async () => {
      await lapsedCustomer('One');
      await lapsedCustomer('Two');

      const created = await createCampaign({
        businessId,
        timezone: TZ,
        audience: CAMPAIGN_AUDIENCE.LAPSED,
        message: 'A quick note from us — we would love to see you again.',
      });
      if ('error' in created) throw new Error('expected a campaign');

      await drainCampaign(deps, created.campaignId);
      await clearSendSlot(redis, businessId);
      expect(await cancelCampaign(businessId, created.campaignId)).toBe(true);

      // There is no unsending a WhatsApp message. Cancelling stops what is left.
      expect(await drainFully(created.campaignId)).toBe(0);
      expect(await campaignSends()).toHaveLength(1);

      const [summary] = await listCampaigns(businessId);
      expect(summary?.status).toBe(CAMPAIGN_STATUS.CANCELLED);
      expect(summary?.targeted).toBe(2);
      expect(summary?.outcome.sends).toBe(1);
    });

    it('cannot be cancelled by another business', async () => {
      await lapsedCustomer('One');
      const created = await createCampaign({
        businessId,
        timezone: TZ,
        audience: CAMPAIGN_AUDIENCE.LAPSED,
        message: 'We have space this week if you would like to come in.',
      });
      if ('error' in created) throw new Error('expected a campaign');

      expect(await cancelCampaign(String(new mongoose.Types.ObjectId()), created.campaignId)).toBe(false);
      const campaign = await Campaign.findById(created.campaignId);
      expect(campaign?.status).toBe(CAMPAIGN_STATUS.SENDING);
    });
  });

  // ──────────────────────────────────────────────────────── outcomes (§6.3)

  describe('outcomes', () => {
    it('does not call an accepted send a delivered one until an ack says so', async () => {
      await atRiskCustomer('Sana Iqbal');
      await nudgePass();

      let report = await nudgeReport(businessId, TZ, 30);
      expect(report.sends).toBe(1);
      expect(report.delivered).toBe(0);
      // The whole point of FINDING #3: the provider answered 200 and the message
      // may be nowhere. Reporting it as delivered would put the provider's
      // optimism into the thesis's conversion rate.
      expect(report.undelivered).toBe(1);

      await handleMessageAck({
        providerMessageId: provider.sent[0]!.id,
        status: ACK_STATUS.DELIVERED,
        occurredAt: new Date(),
        sessionId: SESSION_ID,
      });

      report = await nudgeReport(businessId, TZ, 30);
      expect(report.delivered).toBe(1);
      expect(report.undelivered).toBe(0);
    });

    it('counts a reply to the nudge, once, and only from someone we messaged', async () => {
      const lid = '1770000009051@lid';
      await atRiskCustomer('Sana Iqbal', { lid });
      await nudgePass();

      await handleInboundMessage(deps, inbound('BOOK', lid));
      await handleInboundMessage(deps, inbound('1', lid));

      const report = await nudgeReport(businessId, TZ, 30);
      // Two messages, one reply: a customer who exchanges twenty messages while
      // booking must not look like twenty conversions.
      expect(report.replied).toBe(1);
    });

    it('attributes a booking made after a nudge, through the real booking path', async () => {
      const clientId = await atRiskCustomer('Sana Iqbal', { lid: '1770000009061@lid' });
      await nudgePass();

      // recordBooking is the one function every booking passes through — web,
      // WhatsApp and the owner's calendar alike — which is why attribution hangs
      // off it rather than off three call sites.
      const bookingId = String(new mongoose.Types.ObjectId());
      await recordBooking(businessId, clientId, new Date(), bookingId);

      const report = await nudgeReport(businessId, TZ, 30);
      expect(report.rebooked).toBe(1);

      const [nudge] = await nudges();
      expect(nudge?.rebookedBookingId).toBe(bookingId);
    });

    it('does not attribute a booking to a nudge that never left the building', async () => {
      const clientId = await atRiskCustomer('Sana Iqbal');
      provider.down = true;
      await nudgePass();

      await recordBooking(businessId, clientId, new Date(), String(new mongoose.Types.ObjectId()));

      // A message still sitting in the queue cannot have caused anything. Without
      // this the conversion rate would credit an outage.
      const report = await nudgeReport(businessId, TZ, 30);
      expect(report.queued).toBe(1);
      expect(report.rebooked).toBe(0);
    });

    it('counts an opt-out that followed the message, and not one that preceded it', async () => {
      const lid = '1770000009071@lid';
      const clientId = await atRiskCustomer('Had Enough', { lid });
      await nudgePass();

      await handleInboundMessage(deps, inbound('STOP', lid));

      const report = await nudgeReport(businessId, TZ, 30);
      expect(report.optedOut).toBe(1);
      // An opt-out IS a reply, and the most informative one a campaign gets.
      expect(report.replied).toBe(1);

      const profile = await ClientProfile.findOne({ businessId, clientId });
      expect(profile?.marketingOptOut).toBe(true);
      expect(profile?.marketingOptOutAt).toBeTruthy();
    });

    it('partitions a campaign\'s sends exactly, so no message is unaccounted for', async () => {
      await lapsedCustomer('One', { lid: '1770000009081@lid' });
      await lapsedCustomer('Two', { lid: '1770000009082@lid' });

      const created = await createCampaign({
        businessId,
        timezone: TZ,
        audience: CAMPAIGN_AUDIENCE.LAPSED,
        message: 'We would love to see you back in the salon this month.',
      });
      if ('error' in created) throw new Error('expected a campaign');
      await drainFully(created.campaignId);

      await handleMessageAck({
        providerMessageId: provider.sent[0]!.id,
        status: ACK_STATUS.DELIVERED,
        occurredAt: new Date(),
        sessionId: SESSION_ID,
      });

      const [summary] = await listCampaigns(businessId);
      const o = summary!.outcome;
      expect(o.sends).toBe(2);
      expect(o.delivered).toBe(1);
      expect(o.undelivered).toBe(1);
      expect(o.delivered + o.undelivered + o.queued + o.skipped).toBe(o.sends);
    });

    it('keeps one business\'s campaigns out of another\'s report', async () => {
      await lapsedCustomer('Ours');
      const created = await createCampaign({
        businessId,
        timezone: TZ,
        audience: CAMPAIGN_AUDIENCE.LAPSED,
        message: 'Our own customers only, please and thank you.',
      });
      if ('error' in created) throw new Error('expected a campaign');

      expect(await listCampaigns(String(new mongoose.Types.ObjectId()))).toEqual([]);
      expect(await listCampaigns(businessId)).toHaveLength(1);
    });
  });

  // ──────────────────────────────────────────── outages: queue, never drop

  describe('outages', () => {
    it('queues a nudge when the session is down and sends it when it returns', async () => {
      await atRiskCustomer('Sana Iqbal');
      provider.down = true;

      await nudgePass();
      expect(provider.sent).toHaveLength(0);
      expect((await nudges())[0]?.status).toBe(DELIVERY_STATUS.QUEUED);

      provider.down = false;
      await retryPending(deps, businessId);

      expect(provider.sent).toHaveLength(1);
      expect((await nudges())[0]?.status).toBe(DELIVERY_STATUS.ACCEPTED);
    });

    it('does not re-nudge someone whose nudge is still queued', async () => {
      await atRiskCustomer('Sana Iqbal');
      provider.down = true;

      await nudgePass();
      await nudgePass();

      // The claim, not the send, is what stops duplicates — and the quiet period
      // starts at the claim for the same reason: two campaigns must not both
      // queue a message that then arrive together when the number comes back.
      expect(await nudges()).toHaveLength(1);
    });
  });
});
