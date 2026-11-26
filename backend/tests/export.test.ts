import type { AddressInfo } from 'node:net';
import express from 'express';
import mongoose from 'mongoose';
import { Redis } from 'ioredis';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { BOOKING_STATUS } from '@scalivo/shared';
import { signToken } from '../src/auth/jwt.js';
import { Booking } from '../src/models/Booking.js';
import { Business } from '../src/models/Business.js';
import { Client } from '../src/models/Client.js';
import { Service } from '../src/models/Service.js';
import { Staff } from '../src/models/Staff.js';
import { createCalendarFeedRouter, createExportRouter } from '../src/export/routes.js';
import { csvCell, foldLine, icalText } from '../src/export/format.js';
import { infraReady } from './infra.js';

/**
 * Calendar export — the Phase 5 rollback: a CSV for a date range, and a secret
 * iCal subscription link.
 */

describe('export formatting', () => {
  it('quotes CSV cells and defuses formulas, but keeps phone numbers', () => {
    expect(csvCell('Sana, Khan')).toBe('"Sana, Khan"');
    expect(csvCell('say "hi"')).toBe('"say ""hi"""');
    expect(csvCell('=HYPERLINK("x")')).toBe('"\'=HYPERLINK(""x"")"');
    expect(csvCell('@SUM(A1)')).toBe('"\'@SUM(A1)"');
    expect(csvCell('-2+3')).toBe('"\'-2+3"');
    expect(csvCell('+923001234567')).toBe('"+923001234567"');
    expect(csvCell(null)).toBe('""');
  });

  it('escapes iCal text and folds long lines on UTF-8 boundaries', () => {
    expect(icalText('a,b;c\\d\ne')).toBe('a\\,b\\;c\\\\d\\ne');
    const long = `SUMMARY:${'آ'.repeat(60)}`; // 2 bytes each
    const folded = foldLine(long).split('\r\n');
    expect(folded.length).toBeGreaterThan(1);
    for (const line of folded) expect(Buffer.byteLength(line, 'utf8')).toBeLessThanOrEqual(75);
    expect(folded.map((l, i) => (i ? l.slice(1) : l)).join('')).toBe(long);
  });
});

const ready = await infraReady({ redis: true });

describe.skipIf(!ready)('export routes', () => {
  let redis: Redis;
  let businessId: string;
  let otherBusinessId: string;
  let staffId: string;
  let otherStaffId: string;
  let token: string;
  let base: string;
  let server: ReturnType<express.Express['listen']>;
  const PHONE = '923005550101';

  const call = (path: string, method = 'GET', bearer: string | null = token) =>
    fetch(`${base}${path}`, {
      method,
      headers: bearer ? { Authorization: `Bearer ${bearer}` } : {},
      signal: AbortSignal.timeout(5000),
    });

  beforeAll(async () => {
    redis = new Redis(process.env.REDIS_URL!, { db: 15 });
    const [b, o] = await Business.create([
      {
        name: 'Export Salon',
        slug: `export-${Date.now()}`,
        category: 'salon',
        timezone: 'Asia/Karachi',
      },
      { name: 'Other Salon', slug: `export-other-${Date.now()}`, category: 'salon' },
    ]);
    businessId = String(b!._id);
    otherBusinessId = String(o!._id);
    await Business.syncIndexes();
    token = signToken({ userId: 'export-owner', role: 'owner', businessIds: [businessId] });
    const app = express();
    app.use('/businesses', createExportRouter());
    app.use('/public', createCalendarFeedRouter(redis));
    server = app.listen(0);
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  beforeEach(async () => {
    await redis.flushdb();
    await Promise.all([
      Booking.deleteMany({ businessId: { $in: [businessId, otherBusinessId] } }),
      Service.deleteMany({ businessId }),
      Staff.deleteMany({ businessId: { $in: [businessId, otherBusinessId] } }),
      Client.deleteMany({ phone: PHONE }),
    ]);
    const service = await Service.create({
      businessId,
      name: 'Facial',
      durationMinutes: 45,
      priceMinor: 250_000,
    });
    staffId = String((await Staff.create({ businessId, name: 'Ayesha' }))._id);
    otherStaffId = String(
      (await Staff.create({ businessId: otherBusinessId, name: 'Elsewhere' }))._id,
    );
    const client = await Client.create({ phone: PHONE, displayName: '=cmd|evil' });
    const at = (iso: string) => new Date(iso);
    const base = {
      businessId,
      staffId,
      clientId: String(client._id),
      serviceId: String(service._id),
      durationMinutes: 45,
      priceMinor: 250_000,
      source: 'whatsapp',
    };
    const soon = new Date(Date.now() + 2 * 86_400_000);
    await Booking.create([
      // 2030-03-01 10:00 Karachi = 05:00Z
      {
        ...base,
        startsAt: at('2030-03-01T05:00:00Z'),
        status: BOOKING_STATUS.CONFIRMED,
        clientConfirmedAt: new Date(),
      },
      { ...base, startsAt: at('2030-03-02T05:00:00Z'), status: BOOKING_STATUS.CANCELLED },
      // Outside the range: the next local day after 2030-03-02.
      { ...base, startsAt: at('2030-03-02T19:30:00Z'), status: BOOKING_STATUS.CONFIRMED },
      { ...base, startsAt: soon, status: BOOKING_STATUS.CONFIRMED },
      {
        ...base,
        businessId: otherBusinessId,
        staffId: otherStaffId,
        startsAt: soon,
        status: BOOKING_STATUS.CONFIRMED,
      },
    ]);
  });

  afterAll(async () => {
    await Promise.all([
      Booking.deleteMany({ businessId: { $in: [businessId, otherBusinessId] } }),
      Service.deleteMany({ businessId }),
      Staff.deleteMany({ businessId: { $in: [businessId, otherBusinessId] } }),
      Client.deleteMany({ phone: PHONE }),
      Business.deleteMany({ _id: { $in: [businessId, otherBusinessId] } }),
    ]);
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await Promise.all([mongoose.disconnect(), redis.quit()]);
  });

  const csvPath = (q: string) => `/businesses/${businessId}/export/appointments.csv?${q}`;

  it('exports the local-day range as CSV, owner only', async () => {
    const res = await call(csvPath('from=2030-03-01&to=2030-03-02'));
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/csv');
    expect(res.headers.get('content-disposition')).toMatch(
      /attachment; filename=".*2030-03-01-to-2030-03-02\.csv"/,
    );
    const text = await res.text();
    const lines = text.replace(/^\uFEFF/, '').trim().split('\r\n');
    expect(lines[0]).toContain('"Date","Start","End","Status"');
    expect(lines).toHaveLength(2); // header + the confirmed one; cancelled and 03-03 excluded
    expect(lines[1]).toContain('"2030-03-01","10:00","10:45","confirmed","Facial","Ayesha"');
    expect(lines[1]).toContain('"\'=cmd|evil"'); // formula defused
    expect(lines[1]).toContain('"+923005550101"');
    expect(lines[1]).toContain('"2500.00"');
    expect(lines[1]).toContain('"yes"');

    const withCancelled = await (
      await call(csvPath('from=2030-03-01&to=2030-03-02&includeCancelled=true'))
    ).text();
    expect(withCancelled.trim().split('\r\n')).toHaveLength(3);

    const staff = signToken({ userId: 's', role: 'staff', businessIds: [businessId] });
    const other = signToken({ userId: 'o', role: 'owner', businessIds: [otherBusinessId] });
    expect((await call(csvPath('from=2030-03-01&to=2030-03-02'), 'GET', null)).status).toBe(401);
    expect((await call(csvPath('from=2030-03-01&to=2030-03-02'), 'GET', staff)).status).toBe(404);
    expect((await call(csvPath('from=2030-03-01&to=2030-03-02'), 'GET', other)).status).toBe(404);
  });

  it('refuses bad and oversized ranges', async () => {
    expect((await call(csvPath('from=2030-03-05&to=2030-03-01'))).status).toBe(400);
    expect((await call(csvPath('from=2030-01-01&to=2031-06-01'))).status).toBe(400);
    expect((await call(csvPath('from=nope&to=2030-03-01'))).status).toBe(400);
  });

  it('issues a feed link once, serves iCal from it, and cuts it off on rotate and revoke', async () => {
    const feedPath = `/businesses/${businessId}/calendar-feed`;
    expect(await (await call(feedPath)).json()).toMatchObject({ enabled: false });

    const created = await call(feedPath, 'POST');
    expect(created.status).toBe(201);
    const { url } = (await created.json()) as { url: string };
    const path = new URL(url).pathname;
    expect(path).toMatch(/^\/public\/calendar\/[A-Za-z0-9_-]{32}\.ics$/);
    expect(await (await call(feedPath)).json()).toMatchObject({ enabled: true });

    // Only the hash is stored.
    const stored = await Business.findById(businessId).select('+calendarFeed.tokenHash');
    expect(stored!.calendarFeed!.tokenHash).toMatch(/^[a-f0-9]{64}$/);
    expect(url).not.toContain(stored!.calendarFeed!.tokenHash!);

    const feed = await call(path, 'GET', null);
    expect(feed.status).toBe(200);
    expect(feed.headers.get('content-type')).toContain('text/calendar');
    const ics = await feed.text();
    expect(ics).toMatch(/^BEGIN:VCALENDAR\r\n/);
    expect(ics.match(/BEGIN:VEVENT/g)).toHaveLength(1); // only the upcoming one; other tenant excluded
    expect(ics).toContain('SUMMARY:Facial — =cmd|evil');
    expect(ics).toContain('Phone: +923005550101');
    expect(ics).toContain('STATUS:CONFIRMED');

    // Per-staff feed; a staff id from another business is refused.
    expect((await call(`${path}?staff=${staffId}`, 'GET', null)).status).toBe(200);
    expect((await call(`${path}?staff=${otherStaffId}`, 'GET', null)).status).toBe(404);

    // Rotate: the old link dies at once.
    const rotated = (await (await call(feedPath, 'POST')).json()) as { url: string };
    expect((await call(path, 'GET', null)).status).toBe(404);
    expect((await call(new URL(rotated.url).pathname, 'GET', null)).status).toBe(200);

    // Revoke.
    expect((await call(feedPath, 'DELETE')).status).toBe(204);
    expect((await call(new URL(rotated.url).pathname, 'GET', null)).status).toBe(404);
  });

  it('gives one 404 for malformed and unknown tokens', async () => {
    for (const p of [
      '/public/calendar/short.ics',
      `/public/calendar/${'a'.repeat(32)}.ics`,
      '/public/calendar/x',
    ]) {
      const res = await call(p, 'GET', null);
      expect(res.status).toBe(404);
      expect(await res.text()).toBe('Not found');
    }
  });
});
