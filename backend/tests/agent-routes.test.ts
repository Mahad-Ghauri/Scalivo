import type { AddressInfo } from 'node:net';
import express from 'express';
import mongoose from 'mongoose';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { signToken } from '../src/auth/jwt.js';
import { createAgentRouter } from '../src/agent/routes.js';
import { Briefing } from '../src/models/Briefing.js';
import { Business } from '../src/models/Business.js';
import type { SendDeps } from '../src/notifications/send.js';
import { infraReady } from './infra.js';

const ready = await infraReady();
describe.skipIf(!ready)('mobile briefing API', () => {
  let businessId: string;
  let token: string;
  let base: string;
  let server: ReturnType<express.Express['listen']>;
  const request = async (
    path: string,
    method = 'GET',
    body?: object,
    bearer: string | null = token,
  ) => {
    return fetch(`${base}/businesses/${businessId}/agent${path}`, {
      method,
      headers: {
        ...(bearer ? { Authorization: `Bearer ${bearer}` } : {}),
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(5000),
    });
  };
  beforeAll(async () => {
    const business = await Business.create({
      name: 'Briefing API Test',
      slug: `briefing-api-${Date.now()}`,
      category: 'salon',
      agent: { briefings: false, hour: 7 },
    });
    businessId = String(business._id);
    token = signToken({ userId: 'briefing-owner', role: 'owner', businessIds: [businessId] });
    const app = express();
    // These tests never invoke the development send route.
    app.use('/businesses', createAgentRouter({} as SendDeps));
    server = app.listen(0);
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  beforeEach(async () => {
    await Briefing.deleteMany({ businessId });
  });
  afterAll(async () => {
    await Briefing.deleteMany({ businessId });
    await Business.deleteOne({ _id: businessId });
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await mongoose.disconnect();
  });
  const create = (key: string, readAt: Date | null = null, tenant = businessId) =>
    Briefing.create({
      businessId: tenant,
      kind: 'daily',
      dedupeKey: key,
      scheduledFor: new Date('2026-10-10T02:00:00Z'),
      headline: 'Morning summary',
      body: 'No bookings today.',
      facts: { kind: 'daily' },
      phrasedBy: 'template',
      readAt,
    });
  it('rejects unauthenticated, other-tenant and staff access to owner briefings/settings', async () => {
    const other = signToken({ userId: 'other', role: 'owner', businessIds: ['other'] });
    const staff = signToken({ userId: 'staff', role: 'staff', businessIds: [businessId] });
    for (const [bearer, expected] of [
      [null, 401],
      [other, 404],
      [staff, 404],
    ] as const) {
      expect((await request('/briefings', 'GET', undefined, bearer)).status).toBe(expected);
      expect((await request('/settings', 'PATCH', { enabled: true }, bearer)).status).toBe(
        expected,
      );
      expect(
        (await request('/briefings/65a000000000000000000001/read', 'POST', undefined, bearer))
          .status,
      ).toBe(expected);
    }
  });
  it('caps the feed, uses deterministic ordering and counts unread history', async () => {
    for (let i = 0; i < 21; i++) await create(`briefing-${i}`, i === 0 ? new Date() : null);
    const res = await request('/briefings?limit=20');
    const data = (await res.json()) as { briefings: { id: string }[]; unread: number };
    expect(data.briefings).toHaveLength(20);
    expect(data.unread).toBe(20);
    expect(data.briefings.map((row) => row.id)).toEqual(
      [...data.briefings.map((row) => row.id)].sort().reverse(),
    );
    expect((await request('/briefings?limit=101')).status).toBe(400);
  });
  it('read receipts are idempotent and cannot mutate foreign or missing records', async () => {
    const row = await create('read');
    const first = (await (await request(`/briefings/${row._id}/read`, 'POST')).json()) as {
      readAt: string;
    };
    const second = (await (await request(`/briefings/${row._id}/read`, 'POST')).json()) as {
      readAt: string;
    };
    expect(first.readAt).toBeTruthy();
    expect(second.readAt).toBe(first.readAt);
    const foreign = await create('foreign', null, 'foreign-briefing-business');
    try {
      expect((await request(`/briefings/${foreign._id}/read`, 'POST')).status).toBe(404);
      expect((await Briefing.findById(foreign._id))?.readAt).toBeNull();
    } finally {
      await Briefing.deleteOne({ _id: foreign._id });
    }
    expect((await request('/briefings/not-an-id/read', 'POST')).status).toBe(404);
    expect((await request('/briefings/65a000000000000000000001/read', 'POST')).status).toBe(404);
  });
  it('validates settings and preserves unrelated fields on partial updates', async () => {
    await Business.updateOne(
      { _id: businessId },
      { $set: { 'agent.briefings': true, 'agent.hour': 7, 'agent.whatsappTo': '12025550101' } },
    );
    for (const body of [
      { hour: 4 },
      { hour: 12 },
      { hour: 7.5 },
      { enabled: 'true' },
      {},
      { whatsappTo: '1'.repeat(100) },
      { whatsappTo: '1'.repeat(16) },
    ]) {
      expect((await request('/settings', 'PATCH', body)).status).toBe(400);
    }
    const response = await request('/settings', 'PATCH', { hour: 9 });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      enabled: true,
      hour: 9,
      whatsappTo: '12025550101',
    });
    expect((await request('/settings', 'PATCH', { enabled: false })).status).toBe(200);
    expect((await Business.findById(businessId))?.agent?.hour).toBe(9);
  });
});
