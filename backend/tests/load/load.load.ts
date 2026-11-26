import crypto from 'node:crypto';
import type { AddressInfo } from 'node:net';
import express from 'express';
import mongoose from 'mongoose';
import { Redis } from 'ioredis';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  BOOKING_STATUS,
  SESSION_STATUS,
  type MessagingProvider,
  type SendResult,
} from '@scalivo/shared';
import { signToken } from '../../src/auth/jwt.js';
import { createBookingRouter } from '../../src/bookings/routes.js';
import { createCalendarRouter } from '../../src/calendar/routes.js';
import { OpenWAProvider } from '../../src/messaging/OpenWAProvider.js';
import { createWebhookRouter } from '../../src/messaging/webhook.js';
import { enqueueInbound, startInboundWorker } from '../../src/messaging/inbound-queue.js';
import { handleInboundMessage } from '../../src/whatsapp/router.js';
import { Booking } from '../../src/models/Booking.js';
import { Business } from '../../src/models/Business.js';
import { Client } from '../../src/models/Client.js';
import { ClientProfile } from '../../src/models/ClientProfile.js';
import { FlowRun } from '../../src/models/FlowRun.js';
import { Notification } from '../../src/models/Notification.js';
import { Service } from '../../src/models/Service.js';
import { SlotOccupancy } from '../../src/models/SlotOccupancy.js';
import { CapacityOccupancy } from '../../src/models/CapacityOccupancy.js';
import { Staff } from '../../src/models/Staff.js';
import { wallClockToUtc, toBusinessLocal } from '../../src/lib/time.js';
import { infraReady } from '../infra.js';

/**
 * Phase 4.1 load test. Real routers, real Mongo transactions, real Redis holds
 * and queue — only WhatsApp is faked. Each scenario asserts its invariant
 * (exactly-once, no double booking) and prints latency, so a regression in
 * either correctness or speed shows up here.
 *
 *   npx vitest run --config vitest.load.config.ts
 */

const TZ = 'Asia/Karachi';
const SESSION = 'load-test-session';
const SECRET = process.env.OPENWA_WEBHOOK_SECRET!;

class CountingProvider implements MessagingProvider {
  readonly name = 'load';
  sent = 0;
  async sendText(): Promise<SendResult> {
    this.sent += 1;
    return { providerMessageId: `load-${crypto.randomUUID()}`, acceptedAt: new Date() };
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
    return { sessionId: SESSION, status: SESSION_STATUS.READY };
  }
  async registerWebhook() {}
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

/* ─────────────────────────── measurement helpers ─────────────────────────── */

interface Stats {
  n: number;
  ok: number;
  p50: number;
  p95: number;
  p99: number;
  max: number;
  rps: number;
}

function stats(samples: number[], ok: number, wallMs: number): Stats {
  const s = [...samples].sort((a, b) => a - b);
  const at = (q: number) => Math.round(s[Math.min(s.length - 1, Math.floor(q * s.length))] ?? 0);
  return {
    n: s.length,
    ok,
    p50: at(0.5),
    p95: at(0.95),
    p99: at(0.99),
    max: Math.round(s[s.length - 1] ?? 0),
    rps: Math.round((s.length / wallMs) * 1000),
  };
}

/** Run `tasks` with at most `concurrency` in flight; time each one. */
async function pool<T>(
  tasks: (() => Promise<T>)[],
  concurrency: number,
): Promise<{ results: T[]; ms: number[]; wallMs: number }> {
  const results: T[] = new Array(tasks.length);
  const ms: number[] = new Array(tasks.length);
  let next = 0;
  const started = performance.now();
  await Promise.all(
    Array.from({ length: Math.min(concurrency, tasks.length) }, async () => {
      while (next < tasks.length) {
        const i = next++;
        const t0 = performance.now();
        results[i] = await tasks[i]!();
        ms[i] = performance.now() - t0;
      }
    }),
  );
  return { results, ms, wallMs: performance.now() - started };
}

const report: Record<string, Stats | Record<string, number | string>> = {};

/* ─────────────────────────────────── suite ────────────────────────────────── */

const ready = await infraReady({ replicaSet: true, redis: true });

describe.skipIf(!ready)('load', () => {
  let redis: Redis;
  let provider: CountingProvider;
  let server: ReturnType<express.Express['listen']>;
  let base: string;
  let token: string;
  let businessId: string;
  let serviceId: string;
  let longServiceId: string;
  let staffIds: string[] = [];
  let clientIds: string[] = [];
  let day: string;
  const madeClients: string[] = [];

  const api = async (method: string, path: string, body?: unknown) => {
    const res = await fetch(`${base}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(30_000),
    });
    return {
      status: res.status,
      json: (await res.json().catch(() => null)) as Record<string, unknown> | null,
    };
  };

  /** Hold then book, as the owner app does. */
  const book = async (svc: string, staffId: string, clientId: string, startsAt: Date) => {
    const hold = await api('POST', `/businesses/${businessId}/holds`, {
      serviceId: svc,
      staffId,
      startsAt: startsAt.toISOString(),
      source: 'owner',
    });
    if (hold.status !== 201) return hold.status;
    const res = await api('POST', `/businesses/${businessId}/bookings`, {
      serviceId: svc,
      staffId,
      clientId,
      startsAt: startsAt.toISOString(),
      holdToken: (hold.json as { token: string }).token,
      source: 'owner',
    });
    return res.status;
  };

  beforeAll(async () => {
    redis = new Redis(process.env.REDIS_URL!, { db: 12 });
    await redis.flushdb();
    provider = new CountingProvider();
    await Promise.all([SlotOccupancy.syncIndexes(), Booking.syncIndexes()]);

    const business = await Business.findOneAndUpdate(
      { slug: 'load-test' },
      {
        slug: 'load-test',
        name: 'Load Test Salon',
        category: 'salon',
        timezone: TZ,
        slotIncrementMinutes: 15,
        minNoticeMinutes: 0,
        bookingHorizonDays: 60,
        'whatsapp.sessionId': SESSION,
        'reminders.enabled': false,
      },
      { upsert: true, new: true, setDefaultsOnInsert: true },
    );
    businessId = String(business._id);
    await cleanup();

    const [svc, long] = await Service.insertMany([
      { businessId, name: 'Cut', durationMinutes: 30, priceMinor: 100_000, displayOrder: 1 },
      { businessId, name: 'Colour', durationMinutes: 45, priceMinor: 300_000, displayOrder: 2 },
    ]);
    serviceId = String(svc!._id);
    longServiceId = String(long!._id);
    const hours = [0, 1, 2, 3, 4, 5, 6].map((dayOfWeek) => ({
      dayOfWeek,
      opensAt: '08:00',
      closesAt: '20:00',
      breaks: [],
    }));
    staffIds = (
      await Staff.insertMany(
        Array.from({ length: 10 }, (_, i) => ({
          businessId,
          name: `Stylist ${i + 1}`,
          serviceIds: [serviceId, longServiceId],
          workingHours: hours,
        })),
      )
    ).map((s) => String(s._id));
    // A week out: always in the future, always inside the horizon.
    day = toBusinessLocal(new Date(Date.now() + 7 * 86_400_000), TZ).toISODate()!;

    const clients = await Client.insertMany(
      Array.from({ length: 300 }, (_, i) => ({
        phone: `92399${String(i).padStart(7, '0')}`,
        displayName: `Load ${i}`,
      })),
    );
    clientIds = clients.map((c) => String(c._id));
    madeClients.push(...clientIds);
    await ClientProfile.insertMany(clientIds.map((clientId) => ({ businessId, clientId })));

    token = signToken({ userId: 'load-owner', role: 'owner', businessIds: [businessId] });
    const app = express();
    app.use('/businesses', createBookingRouter(redis, provider));
    app.use('/businesses', createCalendarRouter(redis, provider));
    app.use(
      '/webhooks',
      createWebhookRouter({
        provider: new OpenWAProvider('http://localhost:2785', 'owa_k1_test', SECRET),
        accept: (events) => enqueueInbound(redis, events),
      }),
    );
    server = app.listen(0);
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  async function cleanup() {
    const lidClients = await Client.find({ lids: /^1779\d+@lid$/ })
      .select('_id')
      .lean();
    await Promise.all([
      Booking.deleteMany({ businessId }),
      SlotOccupancy.deleteMany({ businessId }),
      CapacityOccupancy.deleteMany({ businessId }),
      Notification.deleteMany({ businessId }),
      FlowRun.deleteMany({ businessId }),
      ClientProfile.deleteMany({ businessId }),
      Service.deleteMany({ businessId }),
      Staff.deleteMany({ businessId }),
      Client.deleteMany({ _id: { $in: [...madeClients, ...lidClients.map((c) => c._id)] } }),
      Client.deleteMany({ phone: /^92399\d{7}$/ }),
    ]);
  }

  afterAll(async () => {
    console.table(report);
    await cleanup();
    await Business.deleteOne({ _id: businessId });
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await Promise.all([mongoose.disconnect(), redis.quit()]);
  });

  /** For one staff member, no two live bookings overlap — the invariant itself. */
  async function assertNoDoubleBooking() {
    const rows = await Booking.find({ businessId, status: { $ne: BOOKING_STATUS.CANCELLED } })
      .select('staffId startsAt durationMinutes')
      .lean();
    const byStaff = new Map<string, { s: number; e: number }[]>();
    for (const b of rows) {
      const list = byStaff.get(b.staffId) ?? [];
      list.push({ s: b.startsAt.getTime(), e: b.startsAt.getTime() + b.durationMinutes * 60_000 });
      byStaff.set(b.staffId, list);
    }
    for (const [staff, list] of byStaff) {
      list.sort((a, b) => a.s - b.s);
      for (let i = 1; i < list.length; i++) {
        expect(list[i]!.s, `double booking for ${staff}`).toBeGreaterThanOrEqual(list[i - 1]!.e);
      }
    }
    return rows.length;
  }

  it('100 owners racing for one slot: exactly one booking', async () => {
    const at = wallClockToUtc(`${day}T10:00`, TZ);
    const { results, ms, wallMs } = await pool(
      clientIds.slice(0, 100).map((c) => () => book(serviceId, staffIds[0]!, c, at)),
      100,
    );
    const won = results.filter((s) => s === 201).length;
    report['race: same slot ×100'] = stats(ms, won, wallMs);
    expect(won).toBe(1);
    expect(results.filter((s) => s !== 201 && s !== 409)).toEqual([]);
    expect(await Booking.countDocuments({ businessId, staffId: staffIds[0] })).toBe(1);
  });

  it('overlapping durations racing (45 min @10:30 vs 30 min @11:00): never both', async () => {
    const a = wallClockToUtc(`${day}T10:30`, TZ);
    const b = wallClockToUtc(`${day}T11:00`, TZ);
    const tasks = clientIds
      .slice(100, 160)
      .map((c, i) =>
        i % 2
          ? () => book(longServiceId, staffIds[1]!, c, a)
          : () => book(serviceId, staffIds[1]!, c, b),
      );
    const { results, ms, wallMs } = await pool(tasks, 60);
    const won = results.filter((s) => s === 201).length;
    report['race: overlapping ×60'] = stats(ms, won, wallMs);
    expect(won).toBe(1);
    await assertNoDoubleBooking();
  });

  it('300 bookings across 10 staff at concurrency 30: all land, none overlap', async () => {
    await Booking.deleteMany({ businessId });
    await SlotOccupancy.deleteMany({ businessId });
    // 10 staff × 24 half-hour slots (08:00–20:00) on a fresh day, plus 60
    // deliberate collisions on already-requested slots.
    const freshDay = toBusinessLocal(new Date(Date.now() + 9 * 86_400_000), TZ).toISODate()!;
    const slots: { staff: string; at: Date }[] = [];
    for (const staff of staffIds) {
      for (let h = 0; h < 24; h++) {
        const hh = String(8 + Math.floor(h / 2)).padStart(2, '0');
        slots.push({ staff, at: wallClockToUtc(`${freshDay}T${hh}:${h % 2 ? '30' : '00'}`, TZ) });
      }
    }
    const requests = [...slots, ...slots.slice(0, 60)];
    const { results, ms, wallMs } = await pool(
      requests.map(
        (r, i) => () => book(serviceId, r.staff, clientIds[i % clientIds.length]!, r.at),
      ),
      30,
    );
    const won = results.filter((s) => s === 201).length;
    report['book: 300 at c=30'] = stats(ms, won, wallMs);
    expect(won).toBe(slots.length); // every distinct slot booked once, collisions refused
    expect(results.filter((s) => s !== 201 && s !== 409)).toEqual([]);
    expect(await assertNoDoubleBooking()).toBe(slots.length);
    // The grid matches the bookings: two 15-minute cells per 30-minute booking.
    expect(await SlotOccupancy.countDocuments({ businessId })).toBe(slots.length * 2);
  });

  it('realistic concurrency: 5 owners/web customers booking at once', async () => {
    await Booking.deleteMany({ businessId });
    await SlotOccupancy.deleteMany({ businessId });
    const d = toBusinessLocal(new Date(Date.now() + 11 * 86_400_000), TZ).toISODate()!;
    const reqs = staffIds.flatMap((staff) =>
      Array.from({ length: 10 }, (_, h) => ({
        staff,
        at: wallClockToUtc(`${d}T${String(8 + h).padStart(2, '0')}:00`, TZ),
      })),
    );
    const { results, ms, wallMs } = await pool(
      reqs.map((r, i) => () => book(serviceId, r.staff, clientIds[i]!, r.at)),
      5,
    );
    report['book: 100 at c=5'] = stats(ms, results.filter((x) => x === 201).length, wallMs);
    expect(results.every((x) => x === 201)).toBe(true);
  });

  it('calendar and availability reads under load', async () => {
    const freshDay = toBusinessLocal(new Date(Date.now() + 9 * 86_400_000), TZ).toISODate()!;
    const cal = await pool(
      Array.from(
        { length: 300 },
        () => () =>
          api('GET', `/businesses/${businessId}/calendar?from=${freshDay}&to=${freshDay}`).then(
            (r) => r.status,
          ),
      ),
      50,
    );
    report['read: calendar day (240 appts) c=50'] = stats(
      cal.ms,
      cal.results.filter((s) => s === 200).length,
      cal.wallMs,
    );
    const avail = await pool(
      Array.from(
        { length: 300 },
        (_, i) => () =>
          api(
            'GET',
            `/businesses/${businessId}/availability?serviceId=${serviceId}&date=${freshDay}&staffId=${staffIds[i % 10]}`,
          ).then((r) => r.status),
      ),
      50,
    );
    report['read: availability c=50'] = stats(
      avail.ms,
      avail.results.filter((s) => s === 200).length,
      avail.wallMs,
    );
    const calLow = await pool(
      Array.from(
        { length: 100 },
        () => () =>
          api('GET', `/businesses/${businessId}/calendar?from=${freshDay}&to=${freshDay}`).then(
            (r) => r.status,
          ),
      ),
      5,
    );
    report['read: calendar day c=5'] = stats(
      calLow.ms,
      calLow.results.filter((s) => s === 200).length,
      calLow.wallMs,
    );
    expect(cal.results.every((s) => s === 200)).toBe(true);
    expect(avail.results.every((s) => s === 200)).toBe(true);
  });

  it('webhook burst: 400 messages delivered twice, each handled exactly once', async () => {
    const N = 400;
    const delivery = (i: number) => {
      const lid = `1779${String(i).padStart(9, '0')}@lid`;
      const raw = Buffer.from(
        JSON.stringify({
          event: 'message.received',
          timestamp: new Date().toISOString(),
          sessionId: SESSION,
          idempotencyKey: `message.received_${SESSION}_${i}`,
          deliveryId: `dlv_${crypto.randomUUID()}`,
          data: {
            id: `false_${lid}_LOAD${i}`,
            from: lid,
            to: '923000000000@c.us',
            chatId: lid,
            body: 'hi',
            type: 'text',
            timestamp: Math.floor(Date.now() / 1000),
            fromMe: false,
            isGroup: false,
            contact: { pushName: `Load ${i}` },
          },
        }),
      );
      const sig = 'sha256=' + crypto.createHmac('sha256', SECRET).update(raw).digest('hex');
      return { raw, sig };
    };
    const send = ({ raw, sig }: { raw: Buffer; sig: string }) =>
      fetch(`${base}/webhooks/whatsapp`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-openwa-signature': sig },
        body: raw,
        signal: AbortSignal.timeout(30_000),
      }).then((r) => r.status);

    const deliveries = Array.from({ length: N }, (_, i) => delivery(i));
    // Every message twice — OpenWA's at-least-once retry — shuffled together.
    const all = [...deliveries, ...deliveries].sort(() => Math.random() - 0.5);
    const ingest = await pool(
      all.map((d) => () => send(d)),
      50,
    );
    report['webhook: ingest 800 c=50'] = stats(
      ingest.ms,
      ingest.results.filter((s) => s === 200).length,
      ingest.wallMs,
    );
    expect(ingest.results.every((s) => s === 200)).toBe(true);

    const handled = async () =>
      Client.countDocuments({
        lids: { $in: deliveries.map((_, i) => `1779${String(i).padStart(9, '0')}@lid`) },
      });

    const before = provider.sent;
    const stop = startInboundWorker(redis, async (event) => {
      if (event.kind === 'message') await handleInboundMessage({ redis, provider }, event.payload);
    });
    const t0 = performance.now();
    const deadline = t0 + 120_000;
    let done = 0;
    while (performance.now() < deadline) {
      done = await handled();
      const pending =
        (await redis.llen('webhook:pending')) + (await redis.llen('webhook:processing'));
      if (pending === 0 && done === N) break;
      await new Promise((r) => setTimeout(r, 250));
    }
    stop();
    const drainMs = performance.now() - t0;
    report['webhook: drain'] = {
      handled: done,
      of: N,
      seconds: Math.round(drainMs / 100) / 10,
      perSecond: Math.round((done / drainMs) * 10_000) / 10,
    };

    expect(done).toBe(N); // every unique message processed…
    expect(provider.sent - before).toBe(N * 2); // …and replied to once: greeting + menu, never twice
    expect(await redis.llen('webhook:failed')).toBe(0);
  });
});
