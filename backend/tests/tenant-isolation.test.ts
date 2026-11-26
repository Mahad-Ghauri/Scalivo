import type { AddressInfo } from 'node:net';
import express from 'express';
import mongoose from 'mongoose';
import { Redis } from 'ioredis';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  BOOKING_STATUS,
  CAMPAIGN_AUDIENCE,
  SESSION_STATUS,
  type MessagingProvider,
} from '@scalivo/shared';
import { signToken } from '../src/auth/jwt.js';
import { AppointmentHolder } from '../src/models/AppointmentHolder.js';
import { BlockedTime } from '../src/models/BlockedTime.js';
import { Booking } from '../src/models/Booking.js';
import { Briefing } from '../src/models/Briefing.js';
import { Business } from '../src/models/Business.js';
import { Campaign } from '../src/models/Campaign.js';
import { Client } from '../src/models/Client.js';
import { ClientProfile } from '../src/models/ClientProfile.js';
import { Resource } from '../src/models/Resource.js';
import { Service } from '../src/models/Service.js';
import { Staff } from '../src/models/Staff.js';
import { createAgentRouter } from '../src/agent/routes.js';
import { createAnalyticsRouter } from '../src/analytics/routes.js';
import { createBookingRouter } from '../src/bookings/routes.js';
import { createBusinessRouter } from '../src/businesses/routes.js';
import { createCalendarRouter } from '../src/calendar/routes.js';
import { createResourceRouter } from '../src/catalog/resources.js';
import { createCatalogRouter } from '../src/catalog/routes.js';
import { createHolderRouter } from '../src/crm/holders.js';
import { createCrmRouter } from '../src/crm/routes.js';
import { createExportRouter } from '../src/export/routes.js';
import { createFollowUpRouter } from '../src/followups/routes.js';
import { createGrowRouter } from '../src/grow/routes.js';
import { createRetentionRouter } from '../src/retention/routes.js';
import { createReviewRouter } from '../src/reviews/routes.js';
import { infraReady } from './infra.js';

/**
 * Cross-tenant probe (Phase 4.2).
 *
 * requireTenant proves the caller owns the :businessId in the PATH. It cannot
 * prove that a booking/client/staff/service id further along the path, or in
 * the body, belongs to that business too — each handler has to. So this signs
 * in as business A's owner and aims every id-taking route at business B's
 * records, then checks B is untouched and nothing of B's came back.
 *
 * A new route that takes an id should get a line here.
 */

const silent: MessagingProvider = {
  name: 'silent',
  sendText: async () => {
    throw new Error('the isolation probe must never message anyone');
  },
  getSessionStatus: async () => SESSION_STATUS.READY,
  startSession: async () => ({ status: SESSION_STATUS.READY }),
  getSessionQr: async () => null,
  provisionSession: async () => ({ sessionId: 'x', status: SESSION_STATUS.READY }),
  registerWebhook: async () => {},
  getSessionPhone: async () => null,
  resolveContactPhone: async () => null,
  parseWebhook: () => [],
};

const ready = await infraReady({ replicaSet: true, redis: true });

describe.skipIf(!ready)('tenant isolation: A cannot reach B through ids', () => {
  let redis: Redis;
  let server: ReturnType<express.Express['listen']>;
  let base: string;
  let tokenA: string;
  const A = { id: '', service: '', staff: '', client: '', booking: '' };
  const B = {
    id: '',
    service: '',
    staff: '',
    client: '',
    booking: '',
    block: '',
    resource: '',
    holder: '',
    campaign: '',
    briefing: '',
  };
  const PHONE_B = '923004440202';
  const PHONE_A = '923004440101';
  const soon = () => new Date(Date.now() + 3 * 86_400_000).toISOString();

  beforeAll(async () => {
    redis = new Redis(process.env.REDIS_URL!, { db: 14 });
    await redis.flushdb();
    const stamp = Date.now();
    const hours = [0, 1, 2, 3, 4, 5, 6].map((dayOfWeek) => ({
      dayOfWeek,
      opensAt: '09:00',
      closesAt: '18:00',
      breaks: [],
    }));

    for (const [t, slug, phone] of [
      [A, `iso-a-${stamp}`, PHONE_A],
      [B, `iso-b-${stamp}`, PHONE_B],
    ] as const) {
      const biz = await Business.create({ name: slug, slug, category: 'salon' });
      t.id = String(biz._id);
      const service = await Service.create({
        businessId: t.id,
        name: 'Facial',
        durationMinutes: 30,
        priceMinor: 1000,
      });
      t.service = String(service._id);
      t.staff = String(
        (
          await Staff.create({
            businessId: t.id,
            name: 'Ayesha',
            serviceIds: [t.service],
            workingHours: hours,
          })
        )._id,
      );
      await Client.deleteMany({ phone });
      t.client = String((await Client.create({ phone, displayName: `client-${slug}` }))._id);
      await ClientProfile.create({ businessId: t.id, clientId: t.client, notes: 'secret notes' });
      t.booking = String(
        (
          await Booking.create({
            businessId: t.id,
            staffId: t.staff,
            clientId: t.client,
            serviceId: t.service,
            startsAt: new Date(Date.now() - 86_400_000),
            durationMinutes: 30,
            priceMinor: 1000,
            source: 'owner',
            status: BOOKING_STATUS.CONFIRMED,
          })
        )._id,
      );
    }
    B.block = String(
      (
        await BlockedTime.create({
          businessId: B.id,
          startsAt: new Date(),
          endsAt: new Date(Date.now() + 3_600_000),
        })
      )._id,
    );
    B.resource = String(
      (await Resource.create({ businessId: B.id, name: 'Room 1', kind: 'room' }))._id,
    );
    B.holder = String(
      (await AppointmentHolder.create({ businessId: B.id, clientId: B.client, name: 'Kid' }))._id,
    );
    B.campaign = String(
      (
        await Campaign.create({
          businessId: B.id,
          audience: CAMPAIGN_AUDIENCE.LAPSED,
          message: 'Come back soon please',
          recipients: 1,
        })
      )._id,
    );
    B.briefing = String(
      (
        await Briefing.create({
          businessId: B.id,
          kind: 'daily',
          dedupeKey: `iso-${stamp}`,
          scheduledFor: new Date(),
          headline: 'B secret',
          body: 'B secret',
          facts: {},
          phrasedBy: 'template',
        })
      )._id,
    );

    tokenA = signToken({ userId: 'iso-owner-a', role: 'owner', businessIds: [A.id] });
    const deps = { redis, provider: silent };
    const app = express();
    for (const router of [
      createBusinessRouter(silent),
      createCatalogRouter(),
      createResourceRouter(),
      createCrmRouter(),
      createHolderRouter(),
      createReviewRouter(),
      createAnalyticsRouter(),
      createGrowRouter(),
      createRetentionRouter(deps),
      createAgentRouter(deps),
      createBookingRouter(redis, silent),
      createCalendarRouter(redis, silent),
      createFollowUpRouter(),
      createExportRouter(),
    ]) {
      app.use('/businesses', router);
    }
    server = app.listen(0);
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    const ids = [A.id, B.id];
    await Promise.all([
      Booking.deleteMany({ businessId: { $in: ids } }),
      Service.deleteMany({ businessId: { $in: ids } }),
      Staff.deleteMany({ businessId: { $in: ids } }),
      ClientProfile.deleteMany({ businessId: { $in: ids } }),
      Client.deleteMany({ phone: { $in: [PHONE_A, PHONE_B] } }),
      BlockedTime.deleteMany({ businessId: { $in: ids } }),
      Resource.deleteMany({ businessId: { $in: ids } }),
      AppointmentHolder.deleteMany({ businessId: { $in: ids } }),
      Campaign.deleteMany({ businessId: { $in: ids } }),
      Briefing.deleteMany({ businessId: { $in: ids } }),
      Business.deleteMany({ _id: { $in: ids } }),
    ]);
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await Promise.all([mongoose.disconnect(), redis.quit()]);
  });

  async function call(method: string, path: string, body?: unknown) {
    const res = await fetch(`${base}/businesses/${A.id}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${tokenA}`,
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(10_000),
    });
    return { status: res.status, text: await res.text() };
  }

  /**
   * Every B value that must never show up in A's responses. A refusal that
   * repeats an id the caller itself sent ("not services of this business:
   * <id>") tells them nothing new, so ids present in the request are ignored
   * in error responses.
   */
  const leaks = (res: { status: number; text: string }, sent = '') =>
    [
      B.booking,
      B.client,
      B.staff,
      B.service,
      B.block,
      B.resource,
      B.holder,
      B.campaign,
      B.briefing,
      PHONE_B,
      'B secret',
    ].filter(
      (needle) => res.text.includes(needle) && !(res.status >= 400 && sent.includes(needle)),
    );

  it('refuses every path id that belongs to B', async () => {
    const probes: [string, string, unknown?][] = [
      ['GET', `/bookings/${B.booking}`],
      ['GET', `/bookings/${B.booking}/audit`],
      ['POST', `/bookings/${B.booking}/cancel`],
      ['POST', `/bookings/${B.booking}/outcome`, { outcome: 'completed' }],
      ['POST', `/bookings/${B.booking}/confirm`],
      [
        'POST',
        `/bookings/${B.booking}/correction`,
        { outcome: 'no_show', revision: 0, reason: 'probe reason' },
      ],
      ['POST', `/bookings/${B.booking}/reschedule`, { startsAt: soon() }],
      ['PUT', `/bookings/${B.booking}/follow-up`, { afterDays: 7 }],
      ['DELETE', `/bookings/${B.booking}/follow-up`],
      ['PATCH', `/services/${B.service}`, { name: 'pwned' }],
      ['DELETE', `/services/${B.service}`],
      ['PATCH', `/staff/${B.staff}`, { name: 'pwned' }],
      ['DELETE', `/staff/${B.staff}`],
      ['PATCH', `/resources/${B.resource}`, { name: 'pwned', kind: 'room' }],
      ['DELETE', `/blocked-time/${B.block}`],
      ['GET', `/clients/${B.client}`],
      ['PUT', `/clients/${B.client}/notes`, { notes: 'pwned' }],
      ['POST', `/clients/${B.client}/recompute`],
      ['GET', `/clients/${B.client}/holders`],
      ['POST', `/clients/${B.client}/holders`, { name: 'Pwned' }],
      ['PATCH', `/clients/${B.client}/holders/${B.holder}`, { name: 'Pwned' }],
      ['POST', `/clients/${B.client}/revoke-link`],
      ['POST', `/retention/campaigns/${B.campaign}/cancel`],
      ['POST', `/agent/briefings/${B.briefing}/read`],
    ];
    const accepted: string[] = [];
    for (const [method, path, body] of probes) {
      const res = await call(method, path, body);
      if (res.status < 400) accepted.push(`${method} ${path} → ${res.status}`);
      expect(leaks(res, path + JSON.stringify(body ?? '')), `${method} ${path}`).toEqual([]);
    }
    expect(accepted).toEqual([]);
  });

  it('refuses B ids smuggled in bodies and queries', async () => {
    const date = soon().slice(0, 10);
    const probes: [string, string, unknown?][] = [
      ['GET', `/availability?serviceId=${B.service}&date=${date}`],
      ['GET', `/availability?serviceId=${A.service}&date=${date}&staffId=${B.staff}`],
      ['GET', `/availability/next?serviceId=${B.service}`],
      [
        'POST',
        '/holds',
        { serviceId: B.service, staffId: B.staff, startsAt: soon(), source: 'owner' },
      ],
      [
        'POST',
        '/holds',
        { serviceId: A.service, staffId: B.staff, startsAt: soon(), source: 'owner' },
      ],
      [
        'POST',
        '/walk-ins',
        { serviceId: B.service, staffId: B.staff, startsAt: soon(), name: 'x' },
      ],
      [
        'POST',
        '/walk-ins',
        { serviceId: A.service, staffId: A.staff, startsAt: soon(), clientId: B.client },
      ],
      [
        'POST',
        '/sequences/availability',
        { date, steps: [{ serviceId: B.service, staffId: B.staff }] },
      ],
      ['PUT', `/bookings/${A.booking}/follow-up`, { afterDays: 7, serviceId: B.service }],
      ['PUT', `/bookings/${A.booking}/follow-up`, { afterDays: 7, staffId: B.staff }],
      ['POST', `/bookings/${A.booking}/reschedule`, { startsAt: soon(), staffId: B.staff }],
      ['POST', '/staff', { name: 'x', serviceIds: [B.service] }],
      [
        'POST',
        '/blocked-time',
        {
          staffId: B.staff,
          startsAt: soon(),
          endsAt: new Date(Date.now() + 4 * 86_400_000).toISOString(),
        },
      ],
      [
        'POST',
        '/blocked-time',
        {
          resourceId: B.resource,
          startsAt: soon(),
          endsAt: new Date(Date.now() + 4 * 86_400_000).toISOString(),
        },
      ],
      [
        'POST',
        '/services',
        {
          name: 'x',
          durationMinutes: 30,
          priceMinor: 1,
          resourceRequirements: [{ anyOfResourceIds: [B.resource] }],
        },
      ],
    ];
    const accepted: string[] = [];
    for (const [method, path, body] of probes) {
      const res = await call(method, path, body);
      // An availability lookup may answer 200 with nothing — that is fine, as
      // long as nothing of B's is in it.
      const emptyRead =
        method === 'GET' &&
        res.status === 200 &&
        /"slots":\[\]|^\[\]$/.test(res.text.replace(/\s/g, ''));
      if (res.status < 400 && !emptyRead)
        accepted.push(`${method} ${path} → ${res.status} ${res.text.slice(0, 120)}`);
      expect(leaks(res, path + JSON.stringify(body ?? '')), `${method} ${path}`).toEqual([]);
    }
    expect(accepted).toEqual([]);
  });

  it('lists, filters and exports only A, even when filtered by a B id', async () => {
    for (const path of [
      '/bookings',
      `/bookings?staffId=${B.staff}`,
      `/calendar?from=2000-01-01&to=2000-01-02&staffId=${B.staff}`,
      '/clients',
      '/services',
      '/staff',
      '/resources',
      '/follow-ups?status=all',
      '/retention/campaigns',
      '/agent/briefings',
      '/reviews',
      `/export/appointments.csv?from=${soon().slice(0, 10)}&to=${soon().slice(0, 10)}&staffId=${B.staff}`,
    ]) {
      const res = await call('GET', path);
      expect(leaks(res), path).toEqual([]);
    }
  });

  it("left every one of B's records exactly as it was", async () => {
    const [booking, service, staff, profile, holder, block, campaign, briefing] = await Promise.all(
      [
        Booking.findById(B.booking).lean(),
        Service.findById(B.service).lean(),
        Staff.findById(B.staff).lean(),
        ClientProfile.findOne({ businessId: B.id, clientId: B.client }).lean(),
        AppointmentHolder.findById(B.holder).lean(),
        BlockedTime.findById(B.block).lean(),
        Campaign.findById(B.campaign).lean(),
        Briefing.findById(B.briefing).lean(),
      ],
    );
    expect(booking!.status).toBe(BOOKING_STATUS.CONFIRMED);
    expect(booking!.followUp ?? null).toBeNull();
    expect(service!.name).toBe('Facial');
    expect(service!.active).toBe(true);
    expect(staff!.name).toBe('Ayesha');
    expect(staff!.active).toBe(true);
    expect(profile!.notes).toBe('secret notes');
    expect(holder!.name).toBe('Kid');
    expect(block).not.toBeNull();
    expect(campaign!.status).not.toBe('cancelled');
    expect(briefing!.readAt ?? null).toBeNull();
    // Nothing was created in A that points at B.
    expect(await BlockedTime.countDocuments({ businessId: A.id, staffId: B.staff })).toBe(0);
    expect(await Staff.countDocuments({ businessId: A.id, serviceIds: B.service })).toBe(0);
  });
});
