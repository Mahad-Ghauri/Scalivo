import { CapacityOccupancy } from '../src/models/CapacityOccupancy.js';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { checkIntervalAvailability } from '../src/bookings/availability.js';
import { Staff } from '../src/models/Staff.js';
import { Service } from '../src/models/Service.js';
import { Business } from '../src/models/Business.js';
import { SlotOccupancy } from '../src/models/SlotOccupancy.js';
import { BlockedTime } from '../src/models/BlockedTime.js';
import { infraReady } from './infra.js';

const infraUp = await infraReady();

describe.skipIf(!infraUp)('Availability Engine (checkIntervalAvailability)', () => {
  let businessId: string;
  let serviceId: string;
  let staffId1: string;
  let staffId2: string;
  let dateStr: string;
  let now: Date;
  let testStartUtc: Date;

  beforeAll(async () => {
    // Clear out any old test data
    await Business.deleteMany({ name: 'Availability Check Test Salon' });

    const business = await Business.create({
      name: 'Availability Check Test Salon',
      slug: 'availability-check-test-salon',
      category: 'salon',
      timezone: 'UTC', // simple testing
      slotIncrementMinutes: 15,
      minNoticeMinutes: 60,
      bookingHorizonDays: 30,
    });
    businessId = String(business._id);

    now = new Date('2026-09-01T00:00:00Z');
    dateStr = '2026-09-05';
    testStartUtc = new Date(`${dateStr}T10:00:00Z`);

    const service = await Service.create({
      businessId,
      name: 'Haircut',
      durationMinutes: 30,
      bufferMinutes: 0,
      priceMinor: 5000,
      active: true,
    });
    serviceId = String(service._id);

    const workingHours = [0, 1, 2, 3, 4, 5, 6].map((dayOfWeek) => ({
      dayOfWeek,
      opensAt: '09:00',
      closesAt: '17:00',
      breaks: [],
    }));

    const staff1 = await Staff.create({
      businessId,
      name: 'Alice',
      serviceIds: [serviceId],
      workingHours,
      active: true,
    });
    staffId1 = String(staff1._id);

    const staff2 = await Staff.create({
      businessId,
      name: 'Bob',
      serviceIds: [serviceId],
      workingHours,
      active: true,
    });
    staffId2 = String(staff2._id);
  });

  afterAll(async () => {
    await Business.deleteMany({ _id: businessId });
    await Staff.deleteMany({ businessId });
    await Service.deleteMany({ businessId });
    await SlotOccupancy.deleteMany({ businessId });
    await CapacityOccupancy.deleteMany({ businessId });
    await BlockedTime.deleteMany({ businessId });
  });

  const cleanup = async () => {
    await SlotOccupancy.deleteMany({ businessId });
    await CapacityOccupancy.deleteMany({ businessId });
    await BlockedTime.deleteMany({ businessId });
  };

  test('a fully open interval returns available', async () => {
    await cleanup();
    const result = await checkIntervalAvailability(
      businessId,
      staffId1,
      serviceId,
      testStartUtc,
      now,
    );
    expect(result.available).toBe(true);
    expect(result.reason).toBe('available');
  });

  test('an interval fully inside an existing booking returns unavailable', async () => {
    await cleanup();
    await SlotOccupancy.insertMany([
      { businessId, staffId: staffId1, slotStart: testStartUtc, bookingId: 'b1' },
      {
        businessId,
        staffId: staffId1,
        slotStart: new Date(testStartUtc.getTime() + 15 * 60000),
        bookingId: 'b1',
      },
    ]);

    const result = await checkIntervalAvailability(
      businessId,
      staffId1,
      serviceId,
      testStartUtc,
      now,
    );
    expect(result.available).toBe(false);
    expect(result.reason).toBe('slot_taken');
  });

  test('an interval partially overlapping an existing booking returns unavailable', async () => {
    await cleanup();
    await SlotOccupancy.insertMany([
      {
        businessId,
        staffId: staffId1,
        slotStart: new Date(testStartUtc.getTime() + 15 * 60000),
        bookingId: 'b1',
      },
    ]);

    const result = await checkIntervalAvailability(
      businessId,
      staffId1,
      serviceId,
      testStartUtc,
      now,
    );
    expect(result.available).toBe(false);
    expect(result.reason).toBe('slot_taken');
  });

  test('an interval adjacent to (touching but not overlapping) an existing booking returns available', async () => {
    await cleanup();
    // Claim 10:30 and 10:45. Booking at 10:00 (30m) ends at 10:30.
    await SlotOccupancy.insertMany([
      {
        businessId,
        staffId: staffId1,
        slotStart: new Date(testStartUtc.getTime() + 30 * 60000),
        bookingId: 'b1',
      },
    ]);

    const result = await checkIntervalAvailability(
      businessId,
      staffId1,
      serviceId,
      testStartUtc,
      now,
    );
    expect(result.available).toBe(true);
    expect(result.reason).toBe('available');
  });

  test('a block (time-off) makes the interval unavailable', async () => {
    await cleanup();
    await BlockedTime.create({
      businessId,
      staffId: staffId1,
      startsAt: new Date(testStartUtc.getTime() + 15 * 60000),
      endsAt: new Date(testStartUtc.getTime() + 60 * 60000),
    });

    const result = await checkIntervalAvailability(
      businessId,
      staffId1,
      serviceId,
      testStartUtc,
      now,
    );
    expect(result.available).toBe(false);
    expect(result.reason).toBe('blocked');
  });

  test('an interval outside operating hours returns unavailable, with the correct reason', async () => {
    await cleanup();
    const earlyTime = new Date(`${dateStr}T08:00:00Z`);
    const result = await checkIntervalAvailability(businessId, staffId1, serviceId, earlyTime, now);
    expect(result.available).toBe(false);
    expect(result.reason).toBe('outside_hours');
  });

  test('tenant isolation: a request cannot check availability for a business the staff does not belong to', async () => {
    await cleanup();
    // Create a REAL second business, not just a fake ID, to prove cross-tenant leakage is prevented
    const businessB = await Business.create({
      name: 'Business B',
      slug: 'business-b',
      category: 'salon',
      timezone: 'UTC',
      slotIncrementMinutes: 15,
      minNoticeMinutes: 60,
      bookingHorizonDays: 30,
    });

    // Check Alice (who belongs to Business A) using Business B's ID
    const result = await checkIntervalAvailability(
      String(businessB._id),
      staffId1,
      serviceId,
      testStartUtc,
      now,
    );

    // The very first step in checkIntervalAvailability is loadContext(businessId, serviceId).
    // Because the Service belongs to Business A, it is not found under Business B.
    // This deterministically returns 'invalid_slot' before the staff checks even run.
    expect(result.available).toBe(false);
    expect(result.reason).toBe('invalid_slot');

    await Business.deleteOne({ _id: businessB._id });
  });

  test('conflicts are correctly scoped per-staff, not accidentally business-wide', async () => {
    await cleanup();
    await SlotOccupancy.insertMany([
      { businessId, staffId: staffId1, slotStart: testStartUtc, bookingId: 'b1' },
      {
        businessId,
        staffId: staffId1,
        slotStart: new Date(testStartUtc.getTime() + 15 * 60000),
        bookingId: 'b1',
      },
    ]);

    const result = await checkIntervalAvailability(
      businessId,
      staffId2,
      serviceId,
      testStartUtc,
      now,
    );
    expect(result.available).toBe(true);
    expect(result.reason).toBe('available');
  });

  test('cancelled bookings free the slot, no_show keeps the slot occupied', async () => {
    await cleanup();
    // Simulate NO_SHOW: occupancy rows still exist
    await SlotOccupancy.insertMany([
      { businessId, staffId: staffId1, slotStart: testStartUtc, bookingId: 'b_noshow' },
    ]);
    let result = await checkIntervalAvailability(
      businessId,
      staffId1,
      serviceId,
      testStartUtc,
      now,
    );
    expect(result.available).toBe(false);
    expect(result.reason).toBe('slot_taken');

    // Simulate CANCELLED: occupancy rows are deleted
    await SlotOccupancy.deleteMany({ bookingId: 'b_noshow' });
    result = await checkIntervalAvailability(businessId, staffId1, serviceId, testStartUtc, now);
    expect(result.available).toBe(true);
  });
});
