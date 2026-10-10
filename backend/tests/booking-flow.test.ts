import mongoose from 'mongoose';
import express from 'express';
import type { AddressInfo } from 'node:net';
import type { MessagingProvider } from '@scalivo/shared';
import { ClientProfile } from '../src/models/ClientProfile.js';
import { BookingAudit } from '../src/models/BookingAudit.js';
import { Notification } from '../src/models/Notification.js';
import { Review } from '../src/models/Review.js';
import { createResourceRouter } from '../src/catalog/resources.js';
import { createCatalogRouter } from '../src/catalog/routes.js';
import { createBookingRouter } from '../src/bookings/routes.js';
import { signToken } from '../src/auth/jwt.js';
import { confirmBooking } from '../src/notifications/confirm.js';
import { expireApprovalRequests } from '../src/bookings/approval.js';
import { correctBookingOutcome } from '../src/bookings/correction.js';
import { setBookingOutcome } from '../src/bookings/outcome.js';
import { createSequence, getSequenceAvailability } from '../src/bookings/sequence.js';
import { allocateExistingResources } from '../src/bookings/allocate-existing.js';
import { rescheduleReservation } from '../src/calendar/reschedule.js';
import {
  beginVerification,
  finishVerification,
  verifiedPhone,
  verifyInboundChallenge,
} from '../src/public/verification.js';
import { Redis } from 'ioredis';
import { createHmac, randomUUID } from 'node:crypto';
import { beforeAll, beforeEach, afterEach, afterAll, describe, expect, it } from 'vitest';
import { Business } from '../src/models/Business.js';
import { Service } from '../src/models/Service.js';
import { Staff } from '../src/models/Staff.js';
import { Client } from '../src/models/Client.js';
import { AppointmentHolder } from '../src/models/AppointmentHolder.js';
import { Resource } from '../src/models/Resource.js';
import { Booking } from '../src/models/Booking.js';
import { CapacityOccupancy } from '../src/models/CapacityOccupancy.js';
import { SlotOccupancy } from '../src/models/SlotOccupancy.js';
import { BlockedTime } from '../src/models/BlockedTime.js';
import { holdSlot, createBooking, cancelBooking } from '../src/bookings/create.js';
import { acquireHold, releaseHold } from '../src/bookings/holds.js';
import { createPublicRouter } from '../src/public/routes.js';
import { createCalendarRouter } from '../src/calendar/routes.js';
import { createHolderRouter } from '../src/crm/holders.js';
import { getAvailability } from '../src/bookings/availability.js';
import {
  claimCapacity,
  fenceBooking,
  loadResourceCapacity,
  resourceConflicts,
} from '../src/bookings/capacity.js';
import { configureBooking } from '../src/bookings/configuration.js';
import { wallClockToUtc } from '../src/lib/time.js';
import { meTokenFor } from '../src/me/token.js';
import { assertOk, infraReady } from './infra.js';

const up = await infraReady({ replicaSet: true, redis: true });
describe.skipIf(!up)('shared booking capacity and identity', () => {
  let redis: Redis;
  let server: ReturnType<express.Express['listen']>;
  let base: string;
  let code = '';
  const provider = {
    sendText: async (_session: string, _to: string, text: string) => {
      code = text.match(/\b\d{6}\b/)?.[0] ?? '';
      return { providerMessageId: randomUUID(), acceptedAt: new Date() };
    },
  } as unknown as MessagingProvider;
  const request = (
    path: string,
    method = 'GET',
    body?: unknown,
    auth = signToken({ userId: 'test-owner', role: 'owner', businessIds: [businessId] }),
  ) =>
    fetch(`${base}/businesses/${businessId}${path}`, {
      method,
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${auth}` },
      ...(body ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(10000),
    });
  let businessId: string,
    serviceId: string,
    staffA: string,
    staffB: string,
    clientId: string,
    otherClient: string,
    room: string;
  const day = new Date(Date.now() + 3 * 86400000).toISOString().slice(0, 10);
  const at = (time: string) => wallClockToUtc(`${day}T${time}`, 'Asia/Karachi');
  beforeAll(async () => {
    redis = new Redis(process.env.REDIS_URL!, { db: 14, commandTimeout: 5000 });
    await CapacityOccupancy.syncIndexes();
    await SlotOccupancy.syncIndexes();
    await Resource.syncIndexes();
    await Booking.syncIndexes();
    const app = express();
    app.use('/businesses', createResourceRouter());
    app.use('/businesses', createCatalogRouter());
    app.use('/businesses', createBookingRouter(redis, provider));
    app.use('/businesses', createCalendarRouter(redis, provider));
    app.use('/businesses', createHolderRouter());
    app.use('/public', createPublicRouter(redis, provider));
    app.use(
      (
        _error: unknown,
        _req: express.Request,
        res: express.Response,
        _next: express.NextFunction,
      ) => res.status(500).json({ error: 'Internal error' }),
    );
    server = app.listen(0);
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(async () => {
    server.close();
    await redis.quit();
    await mongoose.disconnect();
  });
  beforeEach(async () => {
    await redis.flushdb();
    const business = await Business.create({
      slug: `booking-flow-${randomUUID()}`,
      name: 'Test salon',
      category: 'salon',
      timezone: 'Asia/Karachi',
    });
    businessId = String(business._id);
    const asset = await Resource.create({ businessId, name: 'Treatment room', kind: 'room' });
    room = String(asset._id);
    const service = await Service.create({
      businessId,
      name: 'Facial',
      durationMinutes: 30,
      bufferMinutes: 15,
      priceMinor: 150000,
      resourceRequirements: [{ anyOfResourceIds: [room] }],
    });
    serviceId = String(service._id);
    const hours = Array.from({ length: 7 }, (_, dayOfWeek) => ({
      dayOfWeek,
      opensAt: '09:00',
      closesAt: '18:00',
      breaks: [],
    }));
    const staff = await Staff.insertMany(
      ['A', 'B'].map((name) => ({
        businessId,
        name,
        serviceIds: [serviceId],
        workingHours: hours,
      })),
    );
    staffA = String(staff[0]!._id);
    staffB = String(staff[1]!._id);
    const clients = await Client.insertMany(
      ['Self', 'Other'].map((displayName) => ({ displayName })),
    );
    clientId = String(clients[0]!._id);
    otherClient = String(clients[1]!._id);
  });
  afterEach(async () => {
    await Promise.all([
      Booking.deleteMany({ businessId }),
      CapacityOccupancy.deleteMany({ businessId }),
      SlotOccupancy.deleteMany({ businessId }),
      AppointmentHolder.deleteMany({ businessId }),
      Service.deleteMany({ businessId }),
      Staff.deleteMany({ businessId }),
      BlockedTime.deleteMany({ businessId }),
      ClientProfile.deleteMany({ businessId }),
      BookingAudit.deleteMany({ businessId }),
      Review.deleteMany({ businessId }),
      Notification.deleteMany({ businessId }),
      Resource.deleteMany({ businessId: { $in: [businessId, `foreign-${businessId}`] } }),
      Business.deleteOne({ _id: businessId }),
      Client.deleteMany({ _id: { $in: [clientId, otherClient] } }),
    ]);
  });
  async function book(staffId: string, time: string, contact = clientId, holderId?: string) {
    const held = await holdSlot(redis, {
      businessId,
      serviceId,
      staffId,
      startsAt: at(time),
      source: 'web',
    });
    if (!held.ok) return held;
    return createBooking(redis, {
      businessId,
      serviceId,
      staffId,
      startsAt: at(time),
      clientId: contact,
      source: 'web',
      holdToken: held.hold.token,
      ...(holderId ? { appointmentHolderId: holderId } : {}),
    });
  }
  async function stationInventory(pens = 2) {
    const bed = await Resource.create({
      businessId,
      name: 'Facial beds',
      kind: 'bed',
      quantity: 2,
      fixedRoomId: room,
    });
    const pen = await Resource.create({
      businessId,
      name: 'Hydrafacial pens',
      kind: 'equipment',
      quantity: pens,
      fixedRoomId: room,
    });
    await Service.updateOne(
      { _id: serviceId },
      {
        resourceRequirements: [
          { anyOfResourceIds: [String(bed._id)] },
          { anyOfResourceIds: [String(pen._id)] },
        ],
      },
    );
    return { bed: String(bed._id), pen: String(pen._id) };
  }
  it('offers 09:00 after the first booking when two interchangeable rooms and pens are configured by quantity', async () => {
    await Resource.updateOne({ _id: room }, { quantity: 2 });
    const pen = await Resource.create({
      businessId,
      name: 'Hydrafacial pens',
      kind: 'equipment',
      quantity: 2,
    });
    await Service.updateOne(
      { _id: serviceId },
      {
        resourceRequirements: [
          { anyOfResourceIds: [room] },
          { anyOfResourceIds: [String(pen._id)] },
        ],
      },
    );
    const first = await book(staffA, '09:00');
    assertOk(first, 'first appointment');
    const offers = await getAvailability(redis, {
      businessId,
      serviceId,
      staffId: staffB,
      date: day,
    });
    expect(offers.some((slot) => slot.startsAt.getTime() === at('09:00').getTime())).toBe(true);
    const second = await book(staffB, '09:00', otherClient);
    assertOk(second, 'second appointment');
    expect(second.booking.resourceIds).toEqual([room, String(pen._id)]);
    expect(
      await CapacityOccupancy.countDocuments({ businessId, capacityKey: `resource:${room}:2` }),
    ).toBe(45);
    expect(
      await CapacityOccupancy.countDocuments({ businessId, capacityKey: `resource:${pen._id}:2` }),
    ).toBe(45);
    expect((await book(staffB, '09:00', otherClient)).ok).toBe(false);
  });
  it('shares two beds and two fixed pens within one room without claiming the whole room', async () => {
    const { bed, pen } = await stationInventory();
    assertOk(await book(staffA, '09:00'), 'first shared treatment');
    const offers = await getAvailability(redis, {
      businessId,
      serviceId,
      staffId: staffB,
      date: day,
    });
    expect(offers.some((slot) => slot.startsAt.getTime() === at('09:00').getTime())).toBe(true);
    assertOk(await book(staffB, '09:00', otherClient), 'second shared treatment');
    expect(
      await CapacityOccupancy.countDocuments({ businessId, capacityKey: `resource:${room}` }),
    ).toBe(0);
    for (const id of [bed, pen]) {
      expect(
        await CapacityOccupancy.countDocuments({ businessId, capacityKey: `resource:${id}` }),
      ).toBe(45);
      expect(
        await CapacityOccupancy.countDocuments({ businessId, capacityKey: `resource:${id}:2` }),
      ).toBe(45);
    }
  });
  it('keeps a second bed unavailable when the shared equipment quantity is exhausted', async () => {
    await stationInventory(1);
    assertOk(await book(staffA, '09:00'), 'first treatment');
    const offers = await getAvailability(redis, {
      businessId,
      serviceId,
      staffId: staffB,
      date: day,
    });
    expect(offers.some((slot) => slot.startsAt.getTime() === at('09:00').getTime())).toBe(false);
    expect((await book(staffB, '09:00', otherClient)).ok).toBe(false);
  });
  it.each([true, false])(
    'whole-room and station bookings exclude each other, including soft holds (whole room first: %s)',
    async (wholeFirst) => {
      const { bed } = await stationInventory();
      const sharedService = serviceId;
      const exclusive = await Service.create({
        businessId,
        name: 'Private treatment',
        durationMinutes: 30,
        bufferMinutes: 15,
        priceMinor: 10000,
        resourceRequirements: [{ anyOfResourceIds: [room] }],
      });
      await Staff.updateMany({ businessId }, { $addToSet: { serviceIds: String(exclusive._id) } });
      const firstId = wholeFirst ? String(exclusive._id) : sharedService;
      const secondId = wholeFirst ? sharedService : String(exclusive._id);
      const held = await holdSlot(redis, {
        businessId,
        serviceId: firstId,
        staffId: staffA,
        startsAt: at('09:00'),
        source: 'web',
      });
      assertOk(held, 'first hold');
      expect(
        (
          await holdSlot(redis, {
            businessId,
            serviceId: secondId,
            staffId: staffB,
            startsAt: at('09:00'),
            source: 'web',
          })
        ).ok,
      ).toBe(false);
      const made = await createBooking(redis, {
        businessId,
        serviceId: firstId,
        staffId: staffA,
        clientId,
        startsAt: at('09:00'),
        source: 'web',
        holdToken: held.hold.token,
      });
      assertOk(made, 'first booking');
      await redis.flushdb(); // isolated DB 14: committed capacity must work without Redis.
      expect(
        (
          await holdSlot(redis, {
            businessId,
            serviceId: secondId,
            staffId: staffB,
            startsAt: at('09:00'),
            source: 'web',
          })
        ).ok,
      ).toBe(false);
      expect(
        await CapacityOccupancy.countDocuments({
          businessId,
          capacityKey: `resource:${wholeFirst ? room : bed}`,
        }),
      ).toBe(45);
      expect(await cancelBooking(made.booking.id, businessId)).toBe(true);
      expect(
        (
          await holdSlot(redis, {
            businessId,
            serviceId: secondId,
            staffId: staffB,
            startsAt: at('09:00'),
            source: 'web',
          })
        ).ok,
      ).toBe(true);
    },
  );
  it('serializes a whole-room versus shared-station booking race without double booking', async () => {
    await stationInventory();
    const exclusive = await Service.create({
      businessId,
      name: 'Private treatment',
      durationMinutes: 30,
      priceMinor: 10000,
      resourceRequirements: [{ anyOfResourceIds: [room] }],
    });
    await Staff.updateMany({ businessId }, { $addToSet: { serviceIds: String(exclusive._id) } });
    const requests = [
      {
        businessId,
        serviceId,
        staffId: staffA,
        clientId,
        startsAt: at('09:00'),
        source: 'web' as const,
      },
      {
        businessId,
        serviceId: String(exclusive._id),
        staffId: staffB,
        clientId: otherClient,
        startsAt: at('09:00'),
        source: 'web' as const,
      },
    ];
    const results = await Promise.all(
      requests.map(async (input) => {
        const held = await holdSlot(redis, input);
        return held.ok ? createBooking(redis, { ...input, holdToken: held.hold.token }) : held;
      }),
    );
    expect(results.filter((result) => result.ok)).toHaveLength(1);
    expect(await Booking.countDocuments({ businessId })).toBe(1);
  });
  it('room downtime affects shared stations while equipment downtime exhausts every unit in its pool', async () => {
    const { pen } = await stationInventory();
    const made = await book(staffA, '09:00');
    assertOk(made, 'shared booking');
    const block = await request('/blocked-time', 'POST', {
      resourceId: room,
      startsAt: at('09:00').toISOString(),
      endsAt: at('10:00').toISOString(),
    });
    expect(block.status).toBe(201);
    const response = (await block.json()) as { affectedBookings: { id: string }[] };
    expect(response.affectedBookings.map((booking) => booking.id)).toContain(made.booking.id);
    expect((await book(staffB, '09:00', otherClient)).ok).toBe(false);
    await BlockedTime.deleteMany({ businessId });
    await BlockedTime.create({
      businessId,
      resourceId: pen,
      startsAt: at('09:00'),
      endsAt: at('10:00'),
    });
    expect((await book(staffB, '09:00', otherClient)).ok).toBe(false);
    expect(await Booking.countDocuments({ businessId })).toBe(1);
  });
  it.each([true, false])(
    'transactional room guards reject stale allocations independently of holds (whole room first: %s)',
    async (wholeFirst) => {
      const { bed, pen } = await stationInventory();
      if (wholeFirst)
        await Service.updateOne(
          { _id: serviceId },
          { resourceRequirements: [{ anyOfResourceIds: [room] }] },
        );
      const first = await book(staffA, '09:00');
      assertOk(first, 'first reservation');
      await redis.flushdb();
      const selected = wholeFirst ? [bed, pen] : [room];
      const capacity = await loadResourceCapacity(
        null,
        businessId,
        [{ anyOfResourceIds: selected }],
        { start: at('09:00'), end: at('09:45') },
      );
      const session = await mongoose.startSession();
      try {
        await expect(
          session.withTransaction(
            async () => {
              await fenceBooking(
                businessId,
                (await Business.findById(businessId))!.bookingConfigRevision,
                session,
              );
              await claimCapacity(
                {
                  businessId,
                  bookingId: String(new mongoose.Types.ObjectId()),
                  clientId: otherClient,
                  holderId: otherClient,
                  resourceIds: selected,
                  conflictingResourceIds: resourceConflicts(capacity, selected),
                  startsAt: at('09:00'),
                  durationMinutes: 30,
                  spanMinutes: 45,
                },
                session,
              );
            },
            { maxCommitTimeMS: 5000 },
          ),
        ).rejects.toThrow('room or station overlap');
      } finally {
        await session.endSession();
      }
      expect(await Booking.countDocuments({ businessId })).toBe(1);
      expect(
        await CapacityOccupancy.countDocuments({
          businessId,
          capacityKey: `holder:${otherClient}`,
        }),
      ).toBe(0);
    },
  );
  it('increasing quantity adds availability and reducing occupied units rolls back safely', async () => {
    const { pen } = await stationInventory(1);
    assertOk(await book(staffA, '09:00'), 'first treatment');
    expect((await request(`/resources/${pen}`, 'PATCH', { quantity: 2 })).status).toBe(200);
    const second = await book(staffB, '09:00', otherClient);
    assertOk(second, 'second treatment after increase');
    const revision = (await Business.findById(businessId))!.bookingConfigRevision;
    expect((await request(`/resources/${pen}`, 'PATCH', { quantity: 1 })).status).toBe(409);
    expect((await Resource.findById(pen))!.quantity).toBe(2);
    expect((await Business.findById(businessId))!.bookingConfigRevision).toBe(revision);
    await cancelBooking(second.booking.id, businessId);
    expect((await request(`/resources/${pen}`, 'PATCH', { quantity: 1 })).status).toBe(200);
  });
  it('rescheduling a quantity-unit appointment releases only its own unit and preserves the parallel booking', async () => {
    await stationInventory();
    const first = await book(staffA, '09:00');
    const second = await book(staffB, '09:00', otherClient);
    assertOk(first, 'first');
    assertOk(second, 'second');
    const claims = await CapacityOccupancy.find({ businessId, bookingId: first.booking.id })
      .sort({ _id: 1 })
      .lean();
    expect(
      (
        await rescheduleReservation(redis, {
          businessId,
          bookingId: second.booking.id,
          startsAt: at('10:00'),
        })
      ).ok,
    ).toBe(true);
    expect(
      await CapacityOccupancy.find({ businessId, bookingId: first.booking.id })
        .sort({ _id: 1 })
        .lean(),
    ).toEqual(claims);
    expect(
      (await getAvailability(redis, { businessId, serviceId, staffId: staffB, date: day })).some(
        (slot) => slot.startsAt.getTime() === at('09:00').getTime(),
      ),
    ).toBe(true);
  });
  it('requires a single owned room for stations and rejects incompatible or redundant workspace requirements', async () => {
    expect(
      (await request('/resources', 'POST', { name: 'Beds', kind: 'bed', quantity: 2 })).status,
    ).toBe(409);
    const pooledRoom = await Resource.create({
      businessId,
      name: 'Interchangeable rooms',
      kind: 'room',
      quantity: 2,
    });
    expect(
      (
        await request('/resources', 'POST', {
          name: 'Beds',
          kind: 'bed',
          quantity: 2,
          fixedRoomId: String(pooledRoom._id),
        })
      ).status,
    ).toBe(409);
    const { bed } = await stationInventory();
    expect((await request(`/resources/${room}`, 'PATCH', { quantity: 2 })).status).toBe(409);
    expect(
      (
        await request(`/services/${serviceId}`, 'PATCH', {
          resourceRequirements: [{ anyOfResourceIds: [room] }, { anyOfResourceIds: [bed] }],
        })
      ).status,
    ).toBe(409);
    const otherRoom = await Resource.create({ businessId, name: 'Other room', kind: 'room' });
    const machine = await Resource.create({
      businessId,
      name: 'Fixed machine',
      kind: 'equipment',
      fixedRoomId: String(otherRoom._id),
    });
    expect(
      (
        await request(`/services/${serviceId}`, 'PATCH', {
          resourceRequirements: [
            { anyOfResourceIds: [bed] },
            { anyOfResourceIds: [String(machine._id)] },
          ],
        })
      ).status,
    ).toBe(409);
  });
  it('checks maximum room inventory over a full day without exceeding command argument limits', async () => {
    const start = new Date('2030-01-15T00:00:00Z');
    const slots = Array.from({ length: 96 }, (_, i) => new Date(start.getTime() + i * 900000));
    const children = Array.from({ length: 199 }, (_, i) => `boundary-station-${i}`);
    const allocation = {
      resourceIds: [room],
      conflictingResourceIds: children,
      serviceId,
      startsAt: start.getTime(),
      configRevision: 0,
      spanMinutes: 1440,
    };
    const childHold = await acquireHold(redis, businessId, staffB, [start], 60, {
      ...allocation,
      resourceIds: [children[198]!],
      conflictingResourceIds: [room],
      spanMinutes: 1,
    });
    expect(childHold).not.toBeNull();
    expect(await acquireHold(redis, businessId, staffA, slots, 60, allocation)).toBeNull();
    await releaseHold(redis, childHold!);
    const roomHold = await acquireHold(redis, businessId, staffA, slots, 60, allocation);
    expect(roomHold).not.toBeNull();
    expect(await redis.get(`hold:${businessId}:resource:${room}:${start.getTime()}`)).toBe(
      roomHold!.token,
    );
    expect(
      await redis.get(`hold:${businessId}:resource:${children[198]}:${start.getTime()}`),
    ).toBeNull();
    await releaseHold(redis, roomHold!);
  });

  it('caps inventory physical units and treats legacy missing quantities as one', async () => {
    await Resource.collection.updateOne(
      { _id: new mongoose.Types.ObjectId(room) },
      { $unset: { quantity: '' } },
    );
    assertOk(await book(staffA, '09:00'), 'legacy single room');
    expect((await book(staffB, '09:00', otherClient)).ok).toBe(false);
    await Resource.insertMany(
      Array.from({ length: 9 }, (_, index) => ({
        businessId,
        name: `Pool ${index}`,
        kind: 'equipment',
        quantity: 20,
      })),
    );
    expect(
      (await request('/resources', 'POST', { name: 'Over limit', kind: 'equipment', quantity: 20 }))
        .status,
    ).toBe(409);
    expect(await Resource.countDocuments({ businessId, name: 'Over limit' })).toBe(0);
  });
  it('allows only one concurrent appointment in a shared room across different staff', async () => {
    const result = await Promise.all([book(staffA, '15:00'), book(staffB, '15:00', otherClient)]);
    expect(result.filter((booking) => booking.ok)).toHaveLength(1);
    expect(await Booking.countDocuments({ businessId })).toBe(1);
    expect(
      await CapacityOccupancy.countDocuments({ businessId, capacityKey: `resource:${room}` }),
    ).toBe(45);
  });
  it('rejects mixed room/equipment alternatives at both service write boundaries without changing configuration', async () => {
    const pen = await Resource.create({ businessId, name: 'Hydrafacial pen', kind: 'equipment' });
    const requirements = [{ anyOfResourceIds: [room, String(pen._id)] }];
    const revision = (await Business.findById(businessId))!.bookingConfigRevision;
    const updated = await request(`/services/${serviceId}`, 'PATCH', {
      resourceRequirements: requirements,
    });
    expect(updated.status).toBe(409);
    expect(await updated.json()).toMatchObject({
      error: expect.stringContaining('separate requirements'),
    });
    const created = await request('/services', 'POST', {
      name: 'Invalid facial',
      durationMinutes: 30,
      priceMinor: 150000,
      resourceRequirements: requirements,
    });
    expect(created.status).toBe(409);
    expect((await Service.findById(serviceId))!.resourceRequirements).toMatchObject([
      { anyOfResourceIds: [room] },
    ]);
    expect(await Service.countDocuments({ businessId })).toBe(1);
    expect((await Business.findById(businessId))!.bookingConfigRevision).toBe(revision);
  });
  it('fails closed for a legacy mixed requirement without touching existing appointments', async () => {
    const pen = await Resource.create({ businessId, name: 'Hydrafacial pen', kind: 'equipment' });
    const existing = await book(staffA, '15:00');
    assertOk(existing, 'existing booking');
    const claims = await CapacityOccupancy.countDocuments({ businessId });
    await Service.updateOne(
      { _id: serviceId },
      {
        resourceRequirements: [{ anyOfResourceIds: [room, String(pen._id)] }],
      },
    );
    expect(
      await getAvailability(redis, { businessId, serviceId, staffId: staffB, date: day }),
    ).toEqual([]);
    expect((await book(staffB, '16:00', otherClient)).ok).toBe(false);
    expect(await Booking.countDocuments({ businessId })).toBe(1);
    expect(await CapacityOccupancy.countDocuments({ businessId })).toBe(claims);
    expect((await Booking.findById(existing.booking.id))!.status).toBe(existing.booking.status);
    await Resource.updateOne({ _id: pen._id }, { active: false });
    expect(
      await getAvailability(redis, { businessId, serviceId, staffId: staffB, date: day }),
    ).toEqual([]);
  });
  it('keeps same-type retired alternatives unavailable without hiding their active replacement', async () => {
    const retiredRoom = await Resource.create({
      businessId,
      name: 'Retired room',
      kind: 'room',
      active: false,
    });
    await Service.updateOne(
      { _id: serviceId },
      { resourceRequirements: [{ anyOfResourceIds: [String(retiredRoom._id), room] }] },
    );
    const created = await book(staffA, '15:00');
    assertOk(created, 'booking with active alternative');
    expect(created.booking.resourceIds).toEqual([room]);
    expect(
      await CapacityOccupancy.countDocuments({
        businessId,
        capacityKey: `resource:${retiredRoom._id}`,
      }),
    ).toBe(0);
  });
  it('reserves both a room AND pen and rejects a second simultaneous customer using different staff', async () => {
    const pen = await Resource.create({ businessId, name: 'Hydrafacial pen', kind: 'equipment' });
    expect(
      (
        await request(`/services/${serviceId}`, 'PATCH', {
          resourceRequirements: [
            { anyOfResourceIds: [room] },
            { anyOfResourceIds: [String(pen._id)] },
          ],
        })
      ).status,
    ).toBe(200);
    const results = await Promise.all([book(staffA, '09:00'), book(staffB, '09:00', otherClient)]);
    expect(results.filter((result) => result.ok)).toHaveLength(1);
    const bookings = await Booking.find({ businessId }).lean();
    expect(bookings).toHaveLength(1);
    expect(new Set(bookings[0]!.resourceIds)).toEqual(new Set([room, String(pen._id)]));
    for (const id of [room, String(pen._id)]) {
      expect(
        await CapacityOccupancy.countDocuments({ businessId, capacityKey: `resource:${id}` }),
      ).toBe(45);
    }
  });
  it('allows parallel treatments with separate room and equipment alternatives, but not when only one machine is free', async () => {
    const secondRoom = await Resource.create({ businessId, name: 'Second room', kind: 'room' });
    const pens = await Resource.insertMany(
      ['Pen A', 'Pen B'].map((name) => ({ businessId, name, kind: 'equipment' })),
    );
    expect(
      (
        await request(`/services/${serviceId}`, 'PATCH', {
          resourceRequirements: [
            { anyOfResourceIds: [room, String(secondRoom._id)] },
            { anyOfResourceIds: pens.map((pen) => String(pen._id)) },
          ],
        })
      ).status,
    ).toBe(200);
    const results = [await book(staffA, '15:00'), await book(staffB, '15:00', otherClient)];
    expect(results.every((result) => result.ok)).toBe(true);
    const bookings = await Booking.find({ businessId }).lean();
    expect(new Set(bookings.flatMap((booking) => booking.resourceIds)).size).toBe(4);
    await BlockedTime.create({
      businessId,
      resourceId: String(pens[1]!._id),
      startsAt: at('16:00'),
      endsAt: at('17:00'),
    });
    const blockedResults = await Promise.all([
      book(staffA, '16:00'),
      book(staffB, '16:00', otherClient),
    ]);
    expect(blockedResults.filter((result) => result.ok)).toHaveLength(1);
    expect(await Booking.countDocuments({ businessId })).toBe(3);
  });
  it('hides holds and cleanup across staff, and releases all resource claims on cancel', async () => {
    const held = await holdSlot(redis, {
      businessId,
      serviceId,
      staffId: staffA,
      startsAt: at('15:00'),
      source: 'web',
    });
    assertOk(held, 'hold');
    let offers = await getAvailability(redis, {
      businessId,
      serviceId,
      staffId: staffB,
      date: day,
    });
    expect(offers.some((slot) => slot.startsAt.getTime() === at('15:30').getTime())).toBe(false);
    const created = await createBooking(redis, {
      businessId,
      serviceId,
      staffId: staffA,
      startsAt: at('15:00'),
      clientId,
      source: 'web',
      holdToken: held.hold.token,
    });
    assertOk(created, 'booking');
    await cancelBooking(created.booking.id, businessId);
    expect(await CapacityOccupancy.countDocuments({ businessId })).toBe(0);
    offers = await getAvailability(redis, { businessId, serviceId, staffId: staffB, date: day });
    expect(offers.some((slot) => slot.startsAt.getTime() === at('15:00').getTime())).toBe(true);
  });
  it('protects the actual person while allowing two family members on the same contact', async () => {
    await Service.updateOne({ _id: serviceId }, { resourceRequirements: [] });
    const family = await AppointmentHolder.insertMany(
      ['Child A', 'Child B'].map((name) => ({ businessId, clientId, name })),
    );
    expect((await book(staffA, '15:00', clientId, String(family[0]!._id))).ok).toBe(true);
    expect((await book(staffB, '15:00', clientId, String(family[0]!._id))).ok).toBe(false);
    expect((await book(staffB, '15:00', clientId, String(family[1]!._id))).ok).toBe(true);
  });
  it('rejects a holder belonging to another contact or business', async () => {
    const holder = await AppointmentHolder.create({
      businessId,
      clientId: otherClient,
      name: 'Other child',
    });
    expect(await book(staffA, '15:00', clientId, String(holder._id))).toMatchObject({
      ok: false,
      reason: 'invalid_slot',
    });
    expect(await Booking.countDocuments({ businessId })).toBe(0);
  });
  it('protects legacy self appointments without needing an unsafe live backfill', async () => {
    await Service.updateOne({ _id: serviceId }, { resourceRequirements: [] });
    await Booking.create({
      businessId,
      staffId: staffA,
      serviceId,
      clientId,
      startsAt: at('15:00'),
      durationMinutes: 30,
      priceMinor: 150000,
      source: 'owner',
      status: 'confirmed',
    });
    expect((await book(staffB, '15:15')).ok).toBe(false);
    expect(await CapacityOccupancy.countDocuments({ businessId })).toBe(0);
  });
  it('binds the held allocation to the service and configuration revision', async () => {
    const held = await holdSlot(redis, {
      businessId,
      serviceId,
      staffId: staffA,
      startsAt: at('15:00'),
      source: 'web',
    });
    assertOk(held, 'hold');
    await configureBooking(businessId, async (session) => {
      await Resource.updateOne({ _id: room }, { active: false }, { session });
    });
    expect(
      await createBooking(redis, {
        businessId,
        serviceId,
        staffId: staffA,
        startsAt: at('15:00'),
        clientId,
        source: 'web',
        holdToken: held.hold.token,
      }),
    ).toMatchObject({ ok: false, reason: 'hold_expired' });
  });
  it('reserves fixed equipment with its room and rejects incompatible room alternatives', async () => {
    const roomB = await Resource.create({ businessId, name: 'Room B', kind: 'room' });
    const machine = await Resource.create({
      businessId,
      name: 'Laser',
      kind: 'equipment',
      fixedRoomId: String(roomB._id),
    });
    await Service.updateOne(
      { _id: serviceId },
      {
        resourceRequirements: [
          { anyOfResourceIds: [room] },
          { anyOfResourceIds: [String(machine._id)] },
        ],
      },
    );
    expect((await book(staffA, '15:00')).ok).toBe(false);
    await Service.updateOne(
      { _id: serviceId },
      {
        resourceRequirements: [
          { anyOfResourceIds: [room, String(roomB._id)] },
          { anyOfResourceIds: [String(machine._id)] },
        ],
      },
    );
    const created = await book(staffA, '15:00');
    assertOk(created, 'compatible booking');
    expect(created.booking.resourceIds).toEqual(
      expect.arrayContaining([String(roomB._id), String(machine._id)]),
    );
  });
  it('refuses all staff when both alternative machines are blocked despite a free room', async () => {
    const pens = await Resource.insertMany(
      ['Pen A', 'Pen B'].map((name) => ({ businessId, name, kind: 'equipment' })),
    );
    await Service.updateOne(
      { _id: serviceId },
      {
        resourceRequirements: [
          { anyOfResourceIds: [room] },
          { anyOfResourceIds: pens.map((pen) => String(pen._id)) },
        ],
      },
    );
    await BlockedTime.insertMany(
      pens.map((pen) => ({
        businessId,
        resourceId: String(pen._id),
        startsAt: at('15:00'),
        endsAt: at('16:00'),
      })),
    );
    for (const staffId of [staffA, staffB]) {
      const offers = await getAvailability(redis, { businessId, serviceId, staffId, date: day });
      expect(offers.some((slot) => slot.startsAt.getTime() === at('15:00').getTime())).toBe(false);
      expect((await book(staffId, '15:00')).ok).toBe(false);
    }
    expect(await Booking.countDocuments({ businessId })).toBe(0);
    expect(await CapacityOccupancy.countDocuments({ businessId })).toBe(0);
  });
  it.each([
    ['invalid date', 'not-a-date', 'not-a-date'],
    ['reversed range', '2026-10-14T16:00', '2026-10-14T15:00'],
    ['empty range', '2026-10-14T15:00', '2026-10-14T15:00'],
    ['over one year', '2026-10-14T15:00', '2027-10-16T15:00'],
  ])('rejects downtime with %s without persisting a block', async (_label, startsAt, endsAt) => {
    expect(
      (await request('/blocked-time', 'POST', { resourceId: room, startsAt, endsAt })).status,
    ).toBe(400);
    expect(await BlockedTime.countDocuments({ businessId })).toBe(0);
  });
  it('refuses retiring an appointment recipient until their active appointment is cancelled', async () => {
    const holder = await AppointmentHolder.create({ businessId, clientId, name: 'Sam' });
    const made = await book(staffA, '15:00', clientId, String(holder._id));
    assertOk(made, 'recipient booking');
    const path = `/clients/${clientId}/holders/${holder._id}`;
    expect((await request(path, 'PATCH', { name: 'Sam', active: false })).status).toBe(409);
    expect((await AppointmentHolder.findById(holder._id))!.active).toBe(true);
    expect(await cancelBooking(made.booking.id, businessId)).toBe(true);
    expect((await request(path, 'PATCH', { name: 'Sam', active: false })).status).toBe(200);
    expect((await AppointmentHolder.findById(holder._id))!.active).toBe(false);
    expect((await Booking.findById(made.booking.id))!.appointmentHolderId).toBe(String(holder._id));
  });
  it('ignores stale owner acceptance after a customer cancels an approval request', async () => {
    await Service.updateOne({ _id: serviceId }, { requiresOwnerApproval: true });
    const made = await book(staffA, '15:00');
    assertOk(made, 'approval request');
    expect(made.booking.status).toBe('awaiting_approval');
    expect(await cancelBooking(made.booking.id, businessId, 'customer')).toBe(true);
    expect(
      await confirmBooking({ redis, provider }, businessId, made.booking.id, {
        ownerApproval: true,
      }),
    ).toMatchObject({ ok: false, reason: 'already_terminal' });
    expect((await Booking.findById(made.booking.id))!.status).toBe('cancelled');
    expect(await CapacityOccupancy.countDocuments({ businessId })).toBe(0);
    expect(await SlotOccupancy.countDocuments({ businessId })).toBe(0);
  });
  it.each(['unqualified professional', 'deposit service'] as const)(
    'refuses a customer sequence with an %s without reserving any treatment',
    async (scenario) => {
      const second = await Service.create({
        businessId,
        name: 'Second treatment',
        durationMinutes: 15,
        priceMinor: 50000,
        ...(scenario === 'deposit service'
          ? { depositRequired: true, depositAmountMinor: 10000 }
          : {}),
      });
      if (scenario === 'deposit service')
        await Staff.updateOne({ _id: staffB }, { $addToSet: { serviceIds: String(second._id) } });
      const steps = [
        { serviceId, staffId: staffA },
        { serviceId: String(second._id), staffId: staffB },
      ];
      expect(
        await getSequenceAvailability(redis, { businessId, date: day, source: 'web', steps }),
      ).toEqual([]);
      expect(
        (
          await createSequence(redis, {
            businessId,
            clientId,
            startsAt: at('15:00'),
            source: 'web',
            steps,
          })
        ).ok,
      ).toBe(false);
      expect(await Booking.countDocuments({ businessId })).toBe(0);
      expect(await CapacityOccupancy.countDocuments({ businessId })).toBe(0);
      expect(await SlotOccupancy.countDocuments({ businessId })).toBe(0);
    },
  );
  it('cancels only the selected appointment in a saved consecutive sequence', async () => {
    const made = await createSequence(redis, {
      businessId,
      clientId,
      startsAt: at('15:00'),
      source: 'web',
      steps: [
        { serviceId, staffId: staffA },
        { serviceId, staffId: staffB },
      ],
    });
    assertOk(made, 'sequence');
    const [first, second] = made.bookings;
    const preserved = await CapacityOccupancy.find({ businessId, bookingId: second!.id })
      .sort({ _id: 1 })
      .lean();
    expect(await cancelBooking(first!.id, businessId, 'customer')).toBe(true);
    expect((await Booking.findById(first!.id))!.status).toBe('cancelled');
    expect((await Booking.findById(second!.id))!.status).toBe(second!.status);
    expect(
      await CapacityOccupancy.find({ businessId, bookingId: second!.id }).sort({ _id: 1 }).lean(),
    ).toEqual(preserved);
    expect(await CapacityOccupancy.countDocuments({ businessId, bookingId: first!.id })).toBe(0);
    expect(await Booking.countDocuments({ businessId })).toBe(2);
  });
  it('ignores forged client price and duration and reserves the server-defined treatment and cleanup', async () => {
    await ClientProfile.create({ businessId, clientId });
    const held = await holdSlot(redis, {
      businessId,
      serviceId,
      staffId: staffA,
      startsAt: at('15:00'),
      source: 'web',
    });
    assertOk(held, 'hold');
    const response = await request('/bookings', 'POST', {
      serviceId,
      staffId: staffA,
      clientId,
      startsAt: at('15:00').toISOString(),
      source: 'web',
      holdToken: held.hold.token,
      priceMinor: 1,
      durationMinutes: 1,
      bufferMinutes: 0,
    });
    expect(response.status).toBe(201);
    const saved = await Booking.findOne({ businessId });
    expect(saved).toMatchObject({ priceMinor: 150000, durationMinutes: 30 });
    expect(
      await CapacityOccupancy.countDocuments({ businessId, capacityKey: `resource:${room}` }),
    ).toBe(45);
  });
  it('resource downtime hides only affected treatments, without making a business-wide block', async () => {
    await BlockedTime.create({
      businessId,
      resourceId: room,
      startsAt: at('14:00'),
      endsAt: at('17:00'),
    });
    expect((await book(staffA, '15:00')).ok).toBe(false);
    await Service.updateOne({ _id: serviceId }, { resourceRequirements: [] });
    expect((await book(staffA, '15:00')).ok).toBe(true);
  });
  it('moves an overlapping appointment without colliding with its own holder and resource claims', async () => {
    const made = await book(staffA, '15:00');
    assertOk(made, 'booking');
    const moved = await rescheduleReservation(redis, {
      businessId,
      bookingId: made.booking.id,
      clientId,
      startsAt: at('15:15'),
    });
    assertOk(moved, 'move');
    expect(moved.booking.id).toBe(made.booking.id);
    expect(await Booking.countDocuments({ businessId })).toBe(1);
    expect(
      await CapacityOccupancy.countDocuments({ businessId, capacityKey: `resource:${room}` }),
    ).toBe(45);
    expect(await CapacityOccupancy.exists({ businessId, slotStart: at('15:00') })).toBeNull();
  });
  it('a rejected move restores every original staff, holder and resource claim', async () => {
    const made = await book(staffA, '15:00');
    assertOk(made, 'booking');
    const other = await book(staffB, '16:00', otherClient);
    assertOk(other, 'other booking');
    expect(
      (
        await rescheduleReservation(redis, {
          businessId,
          bookingId: made.booking.id,
          startsAt: at('16:00'),
        })
      ).ok,
    ).toBe(false);
    expect((await Booking.findById(made.booking.id))!.startsAt).toEqual(at('15:00'));
    expect(await CapacityOccupancy.countDocuments({ businessId, bookingId: made.booking.id })).toBe(
      75,
    );
  });
  it('backfills active legacy appointments when resource requirements are attached', async () => {
    const legacy = await Booking.create({
      businessId,
      staffId: staffA,
      serviceId,
      clientId,
      startsAt: at('15:00'),
      durationMinutes: 30,
      priceMinor: 150000,
      source: 'owner',
      status: 'confirmed',
    });
    await configureBooking(businessId, (session) =>
      allocateExistingResources(businessId, serviceId, [{ anyOfResourceIds: [room] }], 15, session),
    );
    expect((await Booking.findById(legacy._id))!.resourceIds).toEqual([room]);
    expect(
      await CapacityOccupancy.countDocuments({ businessId, bookingId: String(legacy._id) }),
    ).toBe(45);
    expect((await book(staffB, '15:30', otherClient)).ok).toBe(false);
  });
  it('rolls back configuration and migration when existing parallel bookings cannot fit', async () => {
    await Booking.insertMany(
      [staffA, staffB].map((staffId) => ({
        businessId,
        staffId,
        serviceId,
        clientId,
        startsAt: at('15:00'),
        durationMinutes: 30,
        priceMinor: 150000,
        source: 'owner',
        status: 'confirmed',
      })),
    );
    await expect(
      configureBooking(businessId, (session) =>
        allocateExistingResources(
          businessId,
          serviceId,
          [{ anyOfResourceIds: [room] }],
          15,
          session,
        ),
      ),
    ).rejects.toThrow();
    expect(await CapacityOccupancy.countDocuments({ businessId })).toBe(0);
    expect((await Business.findById(businessId))!.bookingConfigRevision).toBe(0);
    expect(await Booking.countDocuments({ businessId, resourceIds: room })).toBe(0);
  });
  it('requires owner approval, then accepts once without duplicate confirmation', async () => {
    await Service.updateOne({ _id: serviceId }, { requiresOwnerApproval: true });
    const made = await book(staffA, '15:00');
    assertOk(made, 'request');
    expect(made.booking.status).toBe('awaiting_approval');
    const pending = await confirmBooking({ redis, provider }, businessId, made.booking.id);
    expect(pending).toMatchObject({ ok: true, awaitingApproval: true });
    const accepted = await confirmBooking({ redis, provider }, businessId, made.booking.id, {
      ownerApproval: true,
    });
    expect(accepted).toMatchObject({ ok: true, changed: true });
    expect((await Booking.findById(made.booking.id))!.status).toBe('confirmed');
    expect(
      await confirmBooking({ redis, provider }, businessId, made.booking.id, {
        ownerApproval: true,
      }),
    ).toMatchObject({ ok: true, changed: false });
  });
  it('expired approval requests release all capacity and cannot be accepted or resurrected', async () => {
    await Service.updateOne({ _id: serviceId }, { requiresOwnerApproval: true });
    const made = await book(staffA, '15:00');
    assertOk(made, 'request');
    await Booking.updateOne(
      { _id: made.booking.id },
      { approvalExpiresAt: new Date(Date.now() - 1) },
    );
    await confirmBooking({ redis, provider }, businessId, made.booking.id, { ownerApproval: true });
    expect((await Booking.findById(made.booking.id))!.status).toBe('awaiting_approval');
    await expireApprovalRequests({ redis, provider });
    expect((await Booking.findById(made.booking.id))!.status).toBe('cancelled');
    expect(await CapacityOccupancy.countDocuments({ businessId })).toBe(0);
    expect(await SlotOccupancy.countDocuments({ businessId })).toBe(0);
    expect(
      await confirmBooking({ redis, provider }, businessId, made.booking.id, {
        ownerApproval: true,
      }),
    ).toMatchObject({ ok: false });
  });
  it('corrections preserve the audit trail, recompute CRM and withdraw ineligible public reviews', async () => {
    const past = new Date(Date.now() - 2 * 3600000);
    const booking = await Booking.create({
      businessId,
      staffId: staffA,
      serviceId,
      clientId,
      startsAt: past,
      durationMinutes: 30,
      priceMinor: 150000,
      source: 'owner',
      status: 'confirmed',
    });
    expect((await setBookingOutcome(String(booking._id), businessId, 'completed')).ok).toBe(true);
    await Review.create({
      businessId,
      bookingId: String(booking._id),
      clientId,
      authorName: 'Test customer',
      rating: 5,
      published: true,
    });
    expect(
      await correctBookingOutcome({
        businessId,
        bookingId: String(booking._id),
        actorId: 'test-owner',
        outcome: 'no_show',
        reason: 'Recorded against the wrong appointment',
        revision: 1,
      }),
    ).toBe(true);
    expect(await ClientProfile.findOne({ businessId, clientId })).toMatchObject({
      totalVisits: 0,
      noShows: 1,
      lifetimeSpendMinor: 0,
    });
    expect(
      await BookingAudit.findOne({ businessId, bookingId: String(booking._id) }),
    ).toMatchObject({ before: 'completed', after: 'no_show', revision: 2 });
    expect((await Review.findOne({ bookingId: String(booking._id) }))!.published).toBe(false);
    expect(
      await correctBookingOutcome({
        businessId,
        bookingId: String(booking._id),
        actorId: 'test-owner',
        outcome: 'cancelled',
        reason: 'Stale screen correction',
        revision: 1,
      }),
    ).toBe(false);
  });
  it.each(['', 'not-a-phone', '0', '9'.repeat(30)])(
    'refuses invalid verification numbers: %s',
    async (phone) => {
      expect(await beginVerification(redis, provider, businessId, phone)).toMatchObject({
        ok: false,
      });
    },
  );
  it.each(['', '123456', 'https://example.test', 'Bad\u0000Name', 'x'.repeat(81)])(
    'rejects unusable public customer and family-recipient names: %s',
    async (name) => {
      const business = await Business.findByIdAndUpdate(
        businessId,
        { published: true },
        { new: true },
      );
      const clientsBefore = await Client.countDocuments();
      const response = await fetch(`${base}/public/businesses/${business!.slug}/bookings`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name,
          phone: '03001234561',
          verificationProof: 'x'.repeat(32),
          serviceId,
          staffId: staffA,
          startsAt: at('15:00').toISOString(),
          holdToken: randomUUID(),
        }),
        signal: AbortSignal.timeout(10000),
      });
      expect(response.status).toBe(400);
      await ClientProfile.create({ businessId, clientId });
      expect((await request(`/clients/${clientId}/holders`, 'POST', { name })).status).toBe(400);
      expect(await AppointmentHolder.countDocuments({ businessId })).toBe(0);
      expect(await Booking.countDocuments({ businessId })).toBe(0);
      expect(await Client.countDocuments()).toBe(clientsBefore);
    },
  );
  it('verification proofs are bound to number and business, expire, and codes are not stored in plaintext', async () => {
    await Business.updateOne({ _id: businessId }, { 'whatsapp.sessionId': 'fake' });
    const challenge = await beginVerification(redis, provider, businessId, '03312137110');
    assertOk(challenge, 'challenge');
    const raw = await redis.get(`verification:challenge:${challenge.challengeId}`);
    expect(raw).not.toContain(code);
    expect(
      await finishVerification(redis, 'other-business', challenge.challengeId, code),
    ).toBeNull();
    const proof = await finishVerification(redis, businessId, challenge.challengeId, code);
    expect(await verifiedPhone(redis, businessId, proof!)).toBe('923312137110');
    expect(await verifiedPhone(redis, 'other-business', proof!)).toBeNull();
    await redis.del(`verification:proof:${proof}`);
    expect(await verifiedPhone(redis, businessId, proof!)).toBeNull();
  });
  it('caps invalid code attempts and refuses a correct code after the challenge is exhausted', async () => {
    await Business.updateOne({ _id: businessId }, { 'whatsapp.sessionId': 'fake' });
    const challenge = await beginVerification(redis, provider, businessId, '03312137110');
    assertOk(challenge, 'challenge');
    const actual = code;
    for (let attempt = 0; attempt < 6; attempt++)
      expect(
        await finishVerification(redis, businessId, challenge.challengeId, '000000'),
      ).toBeNull();
    expect(await finishVerification(redis, businessId, challenge.challengeId, actual)).toBeNull();
  });
  it('allows correction of one wrong verification code, rejects expired challenges, and caps hourly resends', async () => {
    await Business.updateOne({ _id: businessId }, { 'whatsapp.sessionId': 'fake' });
    const challenge = await beginVerification(redis, provider, businessId, '03312137110');
    assertOk(challenge, 'challenge');
    const actual = code;
    expect(await finishVerification(redis, businessId, challenge.challengeId, '000000')).toBeNull();
    expect(
      await finishVerification(redis, businessId, challenge.challengeId, actual),
    ).not.toBeNull();
    await redis.del(`verification:challenge:${challenge.challengeId}`);
    expect(await finishVerification(redis, businessId, challenge.challengeId, actual)).toBeNull();
    // Controlled expiry of the test cooldown exercises the hourly ceiling without changing clocks.
    const contactKey = createHmac('sha256', process.env.JWT_SECRET!)
      .update(`${businessId}:923312137110`)
      .digest('hex');
    for (let attempt = 1; attempt <= 5; attempt++) {
      await redis.del(`verification:cooldown:${contactKey}`);
      const next = await beginVerification(redis, provider, businessId, '03312137110');
      expect(next.ok).toBe(attempt < 5);
      if (attempt === 5) expect(next).toMatchObject({ reason: 'rate_limited' });
    }
  });
  it('requires fresh verification for every private-link mutation and protects cross-contact targets', async () => {
    await Business.updateOne({ _id: businessId }, { 'whatsapp.sessionId': 'fake' });
    await Client.updateOne({ _id: clientId }, { phone: '923001234561' });
    const own = await book(staffA, '15:00');
    const other = await book(staffB, '16:00', otherClient);
    assertOk(own, 'own booking');
    assertOk(other, 'other booking');
    const token = await meTokenFor(businessId, clientId);
    expect(token).not.toBeNull();
    const call = (path: string, method = 'GET', body?: object) =>
      fetch(`${base}/public/me/${token}${path}`, {
        method,
        headers: { 'Content-Type': 'application/json' },
        ...(body ? { body: JSON.stringify(body) } : {}),
        signal: AbortSignal.timeout(10000),
      });
    const view = await call('');
    expect(view.status).toBe(200);
    expect(view.headers.get('cache-control')).toContain('no-store');
    expect(view.headers.get('referrer-policy')).toBe('no-referrer');
    for (const [path, body] of [
      ['/holders', { name: 'Family member' }],
      ['/revoke', {}],
      [`/bookings/${own.booking.id}/cancel`, {}],
      [`/bookings/${own.booking.id}/reschedule`, { startsAt: at('17:00').toISOString() }],
      [
        '/bookings',
        {
          serviceId,
          staffId: staffA,
          startsAt: at('17:00').toISOString(),
          holdToken: randomUUID(),
        },
      ],
    ] as const)
      expect((await call(path, 'POST', body)).status).toBe(401);
    expect(await Booking.countDocuments({ businessId })).toBe(2);
    const challenge = await beginVerification(redis, provider, businessId, '03001234561');
    assertOk(challenge, 'challenge');
    const verificationProof = await finishVerification(
      redis,
      businessId,
      challenge.challengeId,
      code,
    );
    const foreignHolder = await AppointmentHolder.create({
      businessId,
      clientId: otherClient,
      name: 'Other family member',
    });
    expect(
      (await call(`/holders/${foreignHolder._id}`, 'PATCH', { name: 'Changed', verificationProof }))
        .status,
    ).toBe(404);
    expect(
      (await call(`/bookings/${other.booking.id}/cancel`, 'POST', { verificationProof })).status,
    ).toBe(404);
    expect(
      (
        await call(`/bookings/${other.booking.id}/reschedule`, 'POST', {
          startsAt: at('17:00').toISOString(),
          verificationProof,
        })
      ).status,
    ).toBe(404);
    expect((await AppointmentHolder.findById(foreignHolder._id))!.name).toBe('Other family member');
    expect((await Booking.findById(other.booking.id))!.startsAt).toEqual(at('16:00'));
    expect(
      (await call(`/bookings/${own.booking.id}/cancel`, 'POST', { verificationProof })).status,
    ).toBe(204);
    expect((await Booking.findById(own.booking.id))!.status).toBe('cancelled');
    expect(
      await CapacityOccupancy.countDocuments({ businessId, capacityKey: `resource:${room}` }),
    ).toBe(45);
    await redis.del(`verification:proof:${verificationProof}`);
    expect(
      (await call('/holders', 'POST', { name: 'Expired proof', verificationProof })).status,
    ).toBe(401);
  });
  it('rotates private links independently for owner and verified customer and rejects expired links', async () => {
    await Business.updateOne({ _id: businessId }, { 'whatsapp.sessionId': 'fake' });
    await Client.updateOne({ _id: clientId }, { phone: '923001234561' });
    assertOk(await book(staffA, '15:00'), 'own booking');
    assertOk(await book(staffB, '16:00', otherClient), 'other booking');
    const token = await meTokenFor(businessId, clientId);
    const otherToken = await meTokenFor(businessId, otherClient);
    const get = (value: string | null) =>
      fetch(`${base}/public/me/${value}`, { signal: AbortSignal.timeout(10000) });
    expect((await request(`/clients/${clientId}/revoke-link`, 'POST', {})).status).toBe(204);
    expect((await get(token)).status).toBe(404);
    expect((await get(otherToken)).status).toBe(200);
    const replacement = await meTokenFor(businessId, clientId);
    const challenge = await beginVerification(redis, provider, businessId, '03001234561');
    assertOk(challenge, 'challenge');
    const verificationProof = await finishVerification(
      redis,
      businessId,
      challenge.challengeId,
      code,
    );
    const changed = await fetch(`${base}/public/me/${replacement}/revoke`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ verificationProof }),
      signal: AbortSignal.timeout(10000),
    });
    expect(changed.status).toBe(200);
    const next = (await changed.json()) as { customerToken: string };
    expect((await get(replacement)).status).toBe(404);
    expect((await get(next.customerToken)).status).toBe(200);
    await ClientProfile.updateOne(
      { businessId, clientId },
      { meTokenExpiresAt: new Date(Date.now() - 1) },
    );
    expect((await get(next.customerToken)).status).toBe(404);
    expect((await get('malformed')).status).toBe(404);
  });
  it('requires the actual inbound identity for WhatsApp fallback and bounds resend', async () => {
    await Business.updateOne({ _id: businessId }, { 'whatsapp.sessionId': 'fake' });
    const challenge = await beginVerification(redis, provider, businessId, '03312137110');
    assertOk(challenge, 'challenge');
    await verifyInboundChallenge(
      redis,
      businessId,
      '03102027781',
      `VERIFY ${challenge.challengeId}`,
    );
    expect(await finishVerification(redis, businessId, challenge.challengeId)).toBeNull();
    await verifyInboundChallenge(
      redis,
      businessId,
      '03312137110',
      `VERIFY ${challenge.challengeId}`,
    );
    expect(await finishVerification(redis, businessId, challenge.challengeId)).not.toBeNull();
    expect(await beginVerification(redis, provider, businessId, '03312137110')).toMatchObject({
      ok: false,
      reason: 'rate_limited',
    });
  });
  it.each(['resources', 'resource-blocks'])(
    'requires authentication and owner tenancy for %s',
    async (path) => {
      expect((await request(`/${path}`, 'GET', undefined, '')).status).toBe(401);
      const other = signToken({ userId: 'other-owner', role: 'owner', businessIds: [] });
      expect((await request(`/${path}`, 'GET', undefined, other)).status).toBe(404);
      const staff = signToken({ userId: 'staff', role: 'staff', businessIds: [businessId] });
      expect((await request(`/${path}`, 'GET', undefined, staff)).status).toBe(404);
    },
  );
  it.each([
    { name: '', kind: 'room' },
    { name: 'x'.repeat(81), kind: 'room' },
    { name: 'Unit', kind: 'unknown' },
    { name: 'Unit', kind: 'equipment', fixedRoomId: 'wrong' },
    { name: 'Unit', kind: 'equipment', quantity: 0 },
    { name: 'Unit', kind: 'equipment', quantity: 21 },
    { name: 'Unit', kind: 'equipment', quantity: 1.5 },
    { name: 'Unit', kind: 'equipment', quantity: '2' },
    { name: 'Unit', kind: 'equipment', quantity: null },
  ])('bounds resource input at the owner API', async (body) => {
    expect((await request('/resources', 'POST', body)).status).toBe(400);
  });
  it('blocks retirement of resources used by an active service', async () => {
    expect((await request(`/resources/${room}`, 'PATCH', { active: false })).status).toBe(409);
    expect((await Resource.findById(room))!.active).toBe(true);
  });
  it('rejects a cross-business resource and incompatible fixed-room requirements', async () => {
    const foreign = await Resource.create({
      businessId: `foreign-${businessId}`,
      name: 'Foreign room',
      kind: 'room',
    });
    expect(
      (
        await request(`/services/${serviceId}`, 'PATCH', {
          resourceRequirements: [{ anyOfResourceIds: [String(foreign._id)] }],
        })
      ).status,
    ).toBe(409);
    const machine = await Resource.create({
      businessId,
      name: 'Fixed unit',
      kind: 'equipment',
      fixedRoomId: room,
    });
    const secondRoom = await Resource.create({ businessId, name: 'Second room', kind: 'room' });
    expect(
      (
        await request(`/services/${serviceId}`, 'PATCH', {
          resourceRequirements: [
            { anyOfResourceIds: [String(secondRoom._id)] },
            { anyOfResourceIds: [String(machine._id)] },
          ],
        })
      ).status,
    ).toBe(409);
  });

  it('replaying the same committed hold returns the same booking without duplicating claims', async () => {
    const held = await holdSlot(redis, {
      businessId,
      serviceId,
      staffId: staffA,
      startsAt: at('15:00'),
      source: 'web',
    });
    assertOk(held, 'hold');
    const request = {
      businessId,
      serviceId,
      staffId: staffA,
      startsAt: at('15:00'),
      clientId,
      source: 'web' as const,
      holdToken: held.hold.token,
    };
    const first = await createBooking(redis, request);
    assertOk(first, 'booking');
    const replay = await createBooking(redis, request);
    assertOk(replay, 'replay');
    expect(replay.booking.id).toBe(first.booking.id);
    expect(await Booking.countDocuments({ businessId })).toBe(1);
    expect(await CapacityOccupancy.countDocuments({ businessId })).toBe(75);
    expect(await createBooking(redis, { ...request, startsAt: at('16:00') })).toMatchObject({
      ok: false,
      reason: 'invalid_slot',
    });
    expect((await createBooking(redis, { ...request, clientId: otherClient })).ok).toBe(false);
  });

  it('offers and reserves consecutive treatments for services stored before resource and approval fields existed', async () => {
    await Service.collection.updateOne(
      { _id: new mongoose.Types.ObjectId(serviceId) },
      {
        $unset: { resourceRequirements: '', requiresOwnerApproval: '', approvalWindowMinutes: '' },
      },
    );
    const steps = [
      { serviceId, staffId: staffA },
      { serviceId, staffId: staffB },
    ];
    const offers = await request('/sequences/availability', 'POST', { date: day, steps });
    expect(offers.status).toBe(200);
    const body = (await offers.json()) as { slots: { startsAt: string }[] };
    expect(body.slots.some((slot) => slot.startsAt === at('15:00').toISOString())).toBe(true);
    const sequence = await createSequence(redis, {
      businessId,
      clientId,
      startsAt: at('15:00'),
      source: 'web',
      steps,
    });
    assertOk(sequence, 'legacy service sequence');
    expect(sequence.bookings).toHaveLength(2);
    expect(
      await CapacityOccupancy.countDocuments({ businessId, capacityKey: `resource:${room}` }),
    ).toBe(0);
    expect(
      (await Booking.find({ businessId }).lean()).every((booking) => !booking.approvalRequired),
    ).toBe(true);
  });

  it('reserves consecutive services with different staff and cleanup gaps in one transaction', async () => {
    const sequence = await createSequence(redis, {
      businessId,
      clientId,
      startsAt: at('15:00'),
      source: 'owner',
      requestId: 's'.repeat(32),
      steps: [
        { serviceId, staffId: staffA },
        { serviceId, staffId: staffB },
      ],
    });
    assertOk(sequence, 'sequence');
    expect(sequence.bookings).toHaveLength(2);
    expect(sequence.bookings[1]!.startsAt).toEqual(at('15:45'));
    expect(
      await CapacityOccupancy.countDocuments({ businessId, capacityKey: `resource:${room}` }),
    ).toBe(90);
    const replay = await createSequence(redis, {
      businessId,
      clientId,
      startsAt: at('15:00'),
      source: 'owner',
      requestId: 's'.repeat(32),
      steps: [
        { serviceId, staffId: staffA },
        { serviceId, staffId: staffB },
      ],
    });
    assertOk(replay, 'sequence replay');
    expect(replay.bookings.map((booking) => booking.id)).toEqual(
      sequence.bookings.map((booking) => booking.id),
    );
    expect(await Booking.countDocuments({ businessId })).toBe(2);
  });
  it('refuses the entire sequence if its last treatment cannot fit', async () => {
    const occupied = await book(staffB, '15:45', otherClient);
    assertOk(occupied, 'occupied');
    expect(
      (
        await createSequence(redis, {
          businessId,
          clientId,
          startsAt: at('15:00'),
          source: 'owner',
          steps: [
            { serviceId, staffId: staffA },
            { serviceId, staffId: staffB },
          ],
        })
      ).ok,
    ).toBe(false);
    expect(await Booking.countDocuments({ businessId, clientId })).toBe(0);
    expect(await SlotOccupancy.countDocuments({ businessId, staffId: staffA })).toBe(0);
  });
  it('rolls back every earlier treatment if a holder conflict occurs in a later sequence leg', async () => {
    await Booking.create({
      businessId,
      staffId: staffB,
      serviceId,
      clientId,
      startsAt: at('15:45'),
      durationMinutes: 30,
      priceMinor: 150000,
      source: 'owner',
      status: 'confirmed',
    });
    expect(
      (
        await createSequence(redis, {
          businessId,
          clientId,
          startsAt: at('15:00'),
          source: 'owner',
          steps: [
            { serviceId, staffId: staffA },
            { serviceId, staffId: staffB },
          ],
        })
      ).ok,
    ).toBe(false);
    expect(await Booking.countDocuments({ businessId, clientId })).toBe(1);
    expect(await CapacityOccupancy.countDocuments({ businessId })).toBe(0);
    expect(await SlotOccupancy.countDocuments({ businessId })).toBe(0);
    expect(await redis.keys(`hold:${businessId}:*`)).toHaveLength(0);
  });

  it('offers overlapping reschedule starts only when ignoring the authorized original booking', async () => {
    const made = await book(staffA, '15:00');
    assertOk(made, 'original');
    const query = { businessId, serviceId, staffId: staffA, date: day };
    expect(
      (await getAvailability(redis, query)).some(
        (slot) => slot.startsAt.getTime() === at('15:15').getTime(),
      ),
    ).toBe(false);
    expect(
      (await getAvailability(redis, { ...query, ignoreBookingId: made.booking.id })).some(
        (slot) => slot.startsAt.getTime() === at('15:15').getTime(),
      ),
    ).toBe(true);
    expect(
      (
        await request(
          `/availability?serviceId=${serviceId}&staffId=${staffA}&date=${day}&bookingId=${new mongoose.Types.ObjectId()}`,
        )
      ).status,
    ).toBe(404);
    const response = await request(
      `/availability?serviceId=${serviceId}&staffId=${staffA}&date=${day}&bookingId=${made.booking.id}`,
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as { slots: { startsAt: string }[] };
    expect(body.slots.some((slot) => slot.startsAt === at('15:15').toISOString())).toBe(true);
    await BlockedTime.create({
      businessId,
      resourceId: room,
      startsAt: at('15:45'),
      endsAt: at('16:00'),
    });
    expect(
      (await getAvailability(redis, { ...query, ignoreBookingId: made.booking.id })).some(
        (slot) => slot.startsAt.getTime() === at('15:15').getTime(),
      ),
    ).toBe(false);
  });
  it('only offers a consecutive visit when every later treatment and cleanup span is available', async () => {
    const steps = [
      { serviceId, staffId: staffA },
      { serviceId, staffId: staffB },
    ];
    let offers = await getSequenceAvailability(redis, {
      businessId,
      steps,
      date: day,
      source: 'web',
    });
    const offer = offers.find((slot) => slot.startsAt.getTime() === at('15:00').getTime());
    expect(offer?.appointments[1]?.startsAt).toBe(at('15:45').toISOString());
    const occupied = await book(staffB, '15:45', otherClient);
    assertOk(occupied, 'later booking');
    expect(
      (await getAvailability(redis, { businessId, serviceId, staffId: staffA, date: day })).some(
        (slot) => slot.startsAt.getTime() === at('15:00').getTime(),
      ),
    ).toBe(true);
    offers = await getSequenceAvailability(redis, { businessId, steps, date: day, source: 'web' });
    expect(offers.some((slot) => slot.startsAt.getTime() === at('15:00').getTime())).toBe(false);
    expect(offers.some((slot) => slot.startsAt.getTime() === at('16:30').getTime())).toBe(true);
    expect(offers.some((slot) => slot.startsAt.getTime() === at('17:30').getTime())).toBe(false);
  });
  it('reserves exactly one whole visit when consecutive requests compete for the same room', async () => {
    const steps = [
      { serviceId, staffId: staffA },
      { serviceId, staffId: staffB },
    ];
    const results = await Promise.all(
      [clientId, otherClient].map((contact) =>
        createSequence(redis, {
          businessId,
          clientId: contact,
          steps,
          startsAt: at('15:00'),
          source: 'web',
        }),
      ),
    );
    expect(results.filter((result) => result.ok)).toHaveLength(1);
    expect(await Booking.countDocuments({ businessId })).toBe(2);
    expect(
      await CapacityOccupancy.countDocuments({ businessId, capacityKey: `resource:${room}` }),
    ).toBe(90);
  });
  it.each([
    [],
    [{ serviceId: 'bad', staffId: 'bad' }],
    Array.from({ length: 6 }, () => ({ serviceId: 'a'.repeat(24), staffId: 'b'.repeat(24) })),
  ])('rejects malformed or oversized consecutive availability requests', async (steps) => {
    expect((await request('/sequences/availability', 'POST', { date: day, steps })).status).toBe(
      400,
    );
    expect(await Booking.countDocuments({ businessId })).toBe(0);
  });
  it('interprets resource downtime in business time and includes appointments whose cleanup overlaps it', async () => {
    const made = await book(staffA, '15:00');
    assertOk(made, 'cleanup booking');
    const response = await request('/blocked-time', 'POST', {
      resourceId: room,
      startsAt: `${day}T15:40`,
      endsAt: `${day}T16:00`,
      reason: 'Equipment maintenance',
    });
    expect(response.status).toBe(201);
    const body = (await response.json()) as {
      block: { startsAt: string };
      affectedBookings: { id: string }[];
    };
    expect(body.block.startsAt).toBe(at('15:40').toISOString());
    expect(body.affectedBookings.map((booking) => booking.id)).toContain(made.booking.id);
    expect(
      (
        await request('/blocked-time', 'POST', {
          resourceId: room,
          startsAt: '2026-02-30T10:00',
          endsAt: '2026-02-30T11:00',
        })
      ).status,
    ).toBe(400);
  });
  it('protects new owner actions from staff and foreign customers', async () => {
    const staffToken = signToken({
      userId: 'staff-account',
      role: 'staff',
      businessIds: [businessId],
    });
    expect(
      (
        await request(
          '/sequences/availability',
          'POST',
          {
            date: day,
            steps: [
              { serviceId, staffId: staffA },
              { serviceId, staffId: staffB },
            ],
          },
          staffToken,
        )
      ).status,
    ).toBe(404);
    expect(
      (await request(`/clients/${clientId}/holders`, 'POST', { name: 'Family member' })).status,
    ).toBe(404);
    expect(
      (
        await request('/walk-ins', 'POST', {
          serviceId,
          staffId: staffA,
          clientId,
          startsAt: at('15:00').toISOString(),
        })
      ).status,
    ).toBe(400);
    expect(await Booking.countDocuments({ businessId })).toBe(0);
  });
  it('requires fresh proof bound to the actual phone before a public consecutive visit writes anything', async () => {
    const business = await Business.findByIdAndUpdate(
      businessId,
      { published: true, 'whatsapp.sessionId': 'fake-test' },
      { new: true },
    );
    const input = {
      steps: [
        { serviceId, staffId: staffA },
        { serviceId, staffId: staffB },
      ],
      startsAt: at('15:00').toISOString(),
      name: 'Test Person',
      phone: '+923009999999',
      requestId: 'v'.repeat(32),
      verificationProof: 'x'.repeat(32),
    };
    const call = (body: object) =>
      fetch(`${base}/public/businesses/${business!.slug}/sequences`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(10000),
      });
    expect((await call(input)).status).toBe(401);
    const challenge = await beginVerification(redis, provider, businessId, '+923001234567');
    assertOk(challenge, 'public challenge');
    const proof = await finishVerification(redis, businessId, challenge.challengeId, code);
    expect(proof).not.toBeNull();
    expect((await call({ ...input, verificationProof: proof })).status).toBe(401);
    expect(await Booking.countDocuments({ businessId })).toBe(0);
    const accepted = await call({ ...input, phone: '+923001234567', verificationProof: proof });
    expect(accepted.status).toBe(201);
    const saved = (await accepted.json()) as { receipts: { id: string; status: string }[] };
    expect(saved.receipts).toHaveLength(2);
    expect(saved.receipts.every((receipt) => receipt.status === 'confirmed')).toBe(true);
    const replay = await call({ ...input, phone: '+923001234567', verificationProof: proof });
    expect(replay.status).toBe(201);
    expect(await Booking.countDocuments({ businessId })).toBe(2);
    const created = await Booking.findOne({ businessId }).select('clientId');
    if (created) {
      await ClientProfile.deleteMany({ businessId, clientId: created.clientId });
      await Client.deleteOne({ _id: created.clientId });
    }
  });
  it('requires a reason for early completion and enforces the no-show grace period at the owner boundary', async () => {
    const booking = await Booking.create({
      businessId,
      serviceId,
      staffId: staffA,
      clientId,
      startsAt: new Date(Date.now() - 5 * 60000),
      durationMinutes: 30,
      priceMinor: 150000,
      source: 'owner',
      status: 'confirmed',
    });
    expect(
      (await request(`/bookings/${booking._id}/outcome`, 'POST', { outcome: 'completed' })).status,
    ).toBe(400);
    expect(
      (await request(`/bookings/${booking._id}/outcome`, 'POST', { outcome: 'no_show' })).status,
    ).toBe(400);
    expect(
      (
        await request(`/bookings/${booking._id}/outcome`, 'POST', {
          outcome: 'completed',
          earlyCompletionReason: 'x',
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await request(`/bookings/${booking._id}/outcome`, 'POST', {
          outcome: 'completed',
          earlyCompletionReason: 'Treatment finished safely ahead of schedule',
        })
      ).status,
    ).toBe(204);
    expect(await BookingAudit.countDocuments({ businessId, bookingId: String(booking._id) })).toBe(
      1,
    );
    expect((await ClientProfile.findOne({ businessId, clientId }))?.totalVisits).toBe(1);
  });
  it('caps active appointment holders without a permanent dead end after retiring a person', async () => {
    await ClientProfile.create({ businessId, clientId });
    await AppointmentHolder.insertMany(
      Array.from({ length: 20 }, (_, index) => ({
        businessId,
        clientId,
        name: `Family member ${index}`,
        active: true,
      })),
    );
    expect(
      (await request(`/clients/${clientId}/holders`, 'POST', { name: 'Another family member' }))
        .status,
    ).toBe(409);
    const holder = await AppointmentHolder.findOne({ businessId, clientId });
    expect(
      (
        await request(`/clients/${clientId}/holders/${holder!._id}`, 'PATCH', {
          name: holder!.name,
          active: false,
        })
      ).status,
    ).toBe(200);
    expect(
      (await request(`/clients/${clientId}/holders`, 'POST', { name: 'Another family member' }))
        .status,
    ).toBe(201);
    expect(
      (
        await request(`/clients/${clientId}/holders/${holder!._id}`, 'PATCH', {
          name: holder!.name,
          active: true,
        })
      ).status,
    ).toBe(409);
    expect(await AppointmentHolder.countDocuments({ businessId, clientId, active: true })).toBe(20);
  });
});
