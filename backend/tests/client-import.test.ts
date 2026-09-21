import type { AddressInfo } from 'node:net';
import express from 'express';
import mongoose from 'mongoose';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { BOOKING_STATUS, CLIENT_IMPORT_MAX_ROWS, CLIENT_TAG } from '@scalivo/shared';
import { Booking } from '../src/models/Booking.js';
import { Business } from '../src/models/Business.js';
import { Client } from '../src/models/Client.js';
import { ClientProfile } from '../src/models/ClientProfile.js';
import { createCrmRouter } from '../src/crm/routes.js';
import { loadProfile, recomputeProfile } from '../src/crm/profile.js';
import { signToken } from '../src/auth/jwt.js';
import { infraReady } from './infra.js';

/**
 * CSV client import — milestone 2.7.
 *
 * What these guard against is duplication and erasure, both silent:
 *
 *   - a customer who already messaged on WhatsApp imported as a second person,
 *   - a re-import doubling everybody's visit count,
 *   - a recompute wiping the imported history because it only reads bookings.
 *
 * Each would leave a CRM that looks plausible and is wrong.
 *
 * Needs Mongo.
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const json = (res: Response): Promise<any> => res.json();

/** Numbers only this suite uses, so cleanup cannot touch anyone else's. */
const PHONES = ['923001110001', '923001110002', '923001110003', '923001110004'];

const infraUp = await infraReady();

describe.skipIf(!infraUp)('client import', () => {
  let businessId: string;
  let otherBusinessId: string;
  let token: string;
  let serverUrl: string;
  let server: ReturnType<express.Express['listen']>;

  const post = (rows: unknown[], { dryRun = false, id = businessId } = {}) =>
    fetch(`${serverUrl}/businesses/${id}/clients/import${dryRun ? '?dryRun=true' : ''}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ rows }),
    });

  const profileFor = async (phone: string) => {
    const client = await Client.findOne({ phone });
    return client ? ClientProfile.findOne({ businessId, clientId: String(client._id) }) : null;
  };

  beforeAll(() => {
    const app = express();
    app.use('/businesses', createCrmRouter());
    server = app.listen(0);
    serverUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    if (server) server.close();
    await mongoose.disconnect();
  });

  beforeEach(async () => {
    const seed = (slug: string) =>
      Business.findOneAndReplace(
        { slug },
        { slug, name: slug, category: 'salon', timezone: 'Asia/Karachi' },
        { upsert: true, new: true },
      );
    businessId = String((await seed('import-test'))!._id);
    otherBusinessId = String((await seed('import-other'))!._id);
    token = signToken({ userId: 'owner-import', role: 'owner', businessIds: [businessId] });

    const ids = (await Client.find({ phone: { $in: PHONES } })).map((c) => String(c._id));
    await Promise.all([
      Client.deleteMany({ phone: { $in: PHONES } }),
      ClientProfile.deleteMany({ clientId: { $in: ids } }),
      Booking.deleteMany({ businessId }),
    ]);
  });

  it('a dry run reports every row and writes nothing', async () => {
    const res = await post(
      [
        { name: 'Hina', phone: '0300 1110001' },
        { name: 'No number', phone: '' },
        { name: 'Hina again', phone: '+92 300 1110001' },
      ],
      { dryRun: true },
    );
    expect(res.status).toBe(200);

    const body = await json(res);
    expect(body.dryRun).toBe(true);
    expect(body.rows.map((r: { outcome: string }) => r.outcome)).toEqual([
      'created',
      'invalid',
      'duplicate',
    ]);
    expect(body.rows[2].duplicateOf).toBe(0);
    expect(await Client.countDocuments({ phone: { $in: PHONES } })).toBe(0);
  });

  it('creates the customer with their history, in the WhatsApp phone format', async () => {
    const res = await post([
      { name: 'Hina Raza', phone: '0300-1110001', visits: 6, spend: 'Rs. 42,000', lastVisit: '14/03/2026' },
    ]);
    expect((await json(res)).counts.created).toBe(1);

    const client = await Client.findOne({ phone: '923001110001' });
    expect(client!.displayName).toBe('Hina Raza');

    const profile = await profileFor('923001110001');
    expect(profile!.totalVisits).toBe(6);
    expect(profile!.lifetimeSpendMinor).toBe(4_200_000);
    // 14 March, not 3 December: DD/MM is the Pakistani order.
    expect(profile!.lastVisitAt!.toISOString().slice(0, 10)).toBe('2026-03-14');
  });

  it('links a customer who already messaged on WhatsApp instead of creating a second person', async () => {
    await Client.create({ phone: '923001110002', displayName: 'Sana (WhatsApp)', lids: ['123@lid'] });

    const body = await json(await post([{ name: 'Sana Khan', phone: '03001110002', visits: 2 }]));
    expect(body.counts.linked).toBe(1);

    const people = await Client.find({ phone: '923001110002' });
    expect(people).toHaveLength(1);
    // Their own WhatsApp name is not overwritten by the spreadsheet's.
    expect(people[0]!.displayName).toBe('Sana (WhatsApp)');
  });

  it('fills in a missing name, but only a missing one', async () => {
    await Client.create({ phone: '923001110003', displayName: null });
    await post([{ name: 'Ayesha', phone: '03001110003' }]);
    expect((await Client.findOne({ phone: '923001110003' }))!.displayName).toBe('Ayesha');
  });

  it('re-importing the same file replaces the history rather than doubling it', async () => {
    const rows = [{ phone: '03001110001', visits: 4, spend: 10_000 }];
    await post(rows);
    const second = await json(await post(rows));

    expect(second.counts.updated).toBe(1);
    const profile = await profileFor('923001110001');
    expect(profile!.totalVisits).toBe(4);
    expect(profile!.lifetimeSpendMinor).toBe(1_000_000);
  });

  it('a recompute keeps the imported history and adds real bookings on top', async () => {
    await post([{ phone: '03001110001', visits: 5, spend: 20_000, lastVisit: '2026-01-10' }]);
    const client = await Client.findOne({ phone: '923001110001' });
    const clientId = String(client!._id);

    await Booking.create({
      businessId,
      staffId: 'staff-1',
      clientId,
      serviceId: 'service-1',
      startsAt: new Date('2026-02-01T09:00:00Z'),
      durationMinutes: 45,
      status: BOOKING_STATUS.COMPLETED,
      priceMinor: 300_000,
      source: 'whatsapp',
    });
    await recomputeProfile(businessId, clientId);

    const profile = await profileFor('923001110001');
    expect(profile!.totalVisits).toBe(6);
    expect(profile!.lifetimeSpendMinor).toBe(2_000_000 + 300_000);
    expect(profile!.firstVisitAt!.toISOString().slice(0, 10)).toBe('2026-01-10');
    expect(profile!.lastVisitAt!.toISOString().slice(0, 10)).toBe('2026-02-01');
  });

  it('importing someone who already has bookings adds the history to them', async () => {
    const client = await Client.create({ phone: '923001110004', displayName: 'Maria' });
    const clientId = String(client._id);
    await Booking.create({
      businessId,
      staffId: 'staff-1',
      clientId,
      serviceId: 'service-1',
      startsAt: new Date('2026-05-01T09:00:00Z'),
      durationMinutes: 45,
      status: BOOKING_STATUS.COMPLETED,
      priceMinor: 100_000,
      source: 'owner',
    });
    await recomputeProfile(businessId, clientId);

    await post([{ phone: '03001110004', visits: 3 }]);
    expect((await profileFor('923001110004'))!.totalVisits).toBe(4);
  });

  it('a regular from the old system shows up as lapsed on day one', async () => {
    await post([{ phone: '03001110001', visits: 8, firstVisit: '01/01/2025', lastVisit: '01/03/2026' }]);
    const client = await Client.findOne({ phone: '923001110001' });

    const view = await loadProfile(businessId, String(client!._id), new Date('2026-09-22T12:00:00Z'));
    expect(view!.tags).toContain(CLIENT_TAG.LAPSED);
    expect(view!.tags).toContain(CLIENT_TAG.VIP);
  });

  it('a last-visit date counts as a visit even with no count column', async () => {
    await post([{ phone: '03001110001', lastVisit: '2026-06-01' }]);
    expect((await profileFor('923001110001'))!.totalVisits).toBe(1);
  });

  it('refuses rows it cannot read, and says which', async () => {
    const body = await json(
      await post(
        [
          { phone: '12' },
          { phone: '03001110001', lastVisit: '03/13/2026' },
          { phone: '03001110002', lastVisit: '2099-01-01' },
          { phone: '03001110003', firstVisit: '2026-05-01', lastVisit: '2026-01-01' },
          { phone: '03001110004', visits: 'lots' },
        ],
        { dryRun: true },
      ),
    );

    expect(body.counts.invalid).toBe(5);
    const reasons = body.rows.map((r: { reason: string }) => r.reason);
    expect(reasons[0]).toMatch(/not a phone number/);
    expect(reasons[1]).toMatch(/not a real date/);
    expect(reasons[2]).toMatch(/future/);
    expect(reasons[3]).toMatch(/after the last/);
    expect(reasons[4]).toMatch(/not a number/);
  });

  it('never creates a profile at another business', async () => {
    await post([{ phone: '03001110001', visits: 2 }]);
    const client = await Client.findOne({ phone: '923001110001' });
    expect(
      await ClientProfile.exists({ businessId: otherBusinessId, clientId: String(client!._id) }),
    ).toBeNull();

    // And cannot be pointed at one.
    expect((await post([{ phone: '03001110002' }], { id: otherBusinessId })).status).toBe(404);
  });

  it('refuses an empty or oversized batch outright', async () => {
    expect((await post([])).status).toBe(400);
    const tooMany = Array.from({ length: CLIENT_IMPORT_MAX_ROWS + 1 }, () => ({ phone: '03001110001' }));
    expect((await post(tooMany)).status).toBe(400);
  });
});
