import type { AddressInfo } from 'node:net';
import express from 'express';
import mongoose from 'mongoose';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { describeRequest, recordActivity } from '../src/audit/activity.js';
import { createAuditRouter } from '../src/audit/routes.js';
import type { AuditReport } from '../src/audit/report.js';
import { signToken } from '../src/auth/jwt.js';
import { requireAuth, requireTenant } from '../src/auth/middleware.js';
import { ActivityLog } from '../src/models/ActivityLog.js';
import { Booking } from '../src/models/Booking.js';
import { Business } from '../src/models/Business.js';
import { Notification } from '../src/models/Notification.js';
import { infraReady } from './infra.js';

const B = '6a0000000000000000a0d170';

describe('describeRequest', () => {
  it('names owner changes and finds the record they touched', () => {
    expect(describeRequest('PATCH', `/${B}/services/6a0000000000000000000001`)).toMatchObject({
      businessId: B,
      category: 'services',
      action: 'Edited a service',
      targetId: '6a0000000000000000000001',
    });
    expect(describeRequest('POST', `/${B}/bookings/6a0000000000000000000002/reschedule`)?.action).toBe(
      'Rescheduled an appointment',
    );
    expect(describeRequest('PATCH', `/${B}`)?.action).toBe('Changed business settings');
  });

  it('ignores reads and unknown paths', () => {
    expect(describeRequest('GET', `/${B}/services`)).toBeNull();
    expect(describeRequest('POST', `/${B}/nothing-here`)).toBeNull();
  });
});

const infraUp = await infraReady();
describe.skipIf(!infraUp)('audit report', () => {
  const token = signToken({ userId: '6a0000000000000000a0d171', role: 'owner', businessIds: [B] });
  let url: string;
  let server: ReturnType<express.Express['listen']>;
  const get = (path: string, bearer: string | null = token) =>
    fetch(`${url}/businesses/${B}${path}`, {
      headers: bearer ? { Authorization: `Bearer ${bearer}` } : {},
      signal: AbortSignal.timeout(10000),
    });
  const today = new Date().toISOString().slice(0, 10);

  beforeAll(async () => {
    await Promise.all([
      Business.deleteMany({ _id: B }),
      Booking.deleteMany({ businessId: B }),
      Notification.deleteMany({ businessId: B }),
      ActivityLog.deleteMany({ businessId: B }),
    ]);
    await Business.collection.insertOne({ _id: new mongoose.Types.ObjectId(B), name: 'Audit Test Salon', timezone: 'UTC' } as never);
    await Booking.collection.insertOne({
      businessId: B, staffId: 's', clientId: 'c', serviceId: 'v', startsAt: new Date(), durationMinutes: 30,
      status: 'completed', priceMinor: 500000, source: 'whatsapp', completedAt: new Date(),
      createdAt: new Date(), updatedAt: new Date(),
    } as never);
    await Notification.collection.insertOne({
      businessId: B, clientId: 'c', kind: 'confirmation', dedupeKey: `audit-${Date.now()}`, status: 'failed',
      lastError: 'session down', scheduledFor: new Date(), createdAt: new Date(), updatedAt: new Date(),
    } as never);

    const app = express();
    app.use('/businesses', recordActivity);
    app.use('/businesses', createAuditRouter());
    app.patch('/businesses/:businessId', requireAuth, requireTenant(), (_req, res) => {
      res.json({ ok: true });
    });
    server = app.listen(0);
    url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    await Promise.all([
      Business.deleteMany({ _id: B }),
      Booking.deleteMany({ businessId: B }),
      Notification.deleteMany({ businessId: B }),
      ActivityLog.deleteMany({ businessId: B }),
    ]);
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await mongoose.disconnect();
  });

  it('only lets the business owner read it', async () => {
    expect((await get(`/audit?from=${today}&to=${today}`, null)).status).toBe(401);
    const other = signToken({ userId: 'x', role: 'owner', businessIds: ['6a0000000000000000a0d999'] });
    expect([403, 404]).toContain((await get(`/audit?from=${today}&to=${today}`, other)).status);
  });

  it('records who changed settings and puts it in the timeline with the summary', async () => {
    await fetch(`${url}/businesses/${B}`, { method: 'PATCH', headers: { Authorization: `Bearer ${token}` } });
    await new Promise((r) => setTimeout(r, 300));

    const report = (await (await get(`/audit?from=${today}&to=${today}`)).json()) as AuditReport;
    expect(report.summary).toMatchObject({ bookings: 1, completed: 1, revenueMinor: 500000, messagesFailed: 1 });
    const titles = report.events.map((e: { title: string }) => e.title);
    expect(titles).toContain('Appointment booked on WhatsApp');
    expect(titles).toContain('Booking confirmation: failed');
    expect(titles).toContain('Changed business settings');

    const filtered = (await (await get(`/audit?from=${today}&to=${today}&category=message`)).json()) as AuditReport;
    expect(filtered.events.every((e: { category: string }) => e.category === 'message')).toBe(true);
  });

  it('refuses a backwards range', async () => {
    expect((await get(`/audit?from=2026-12-02&to=2026-12-01`)).status).toBe(400);
  });

  it('downloads the report as a PDF', async () => {
    const res = await get(`/audit/report.pdf?from=${today}&to=${today}`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('application/pdf');
    expect(res.headers.get('content-disposition')).toContain('audit-report-');
    const bytes = Buffer.from(await res.arrayBuffer());
    expect(bytes.subarray(0, 5).toString()).toBe('%PDF-');
  });
});
