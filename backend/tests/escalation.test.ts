import mongoose from 'mongoose';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { BOOKING_STATUS, DELIVERY_STATUS, NOTIFICATION_KIND, reminderState } from '@scalivo/shared';

const pushes: { businessId: string; title: string; route?: string | undefined }[] = [];
vi.mock('../src/push/fcm.js', async (orig) => ({
  ...(await orig<typeof import('../src/push/fcm.js')>()),
  pushToOwners: vi.fn(async (businessId: string, m: { title: string; route?: string }) => {
    pushes.push({ businessId, title: m.title, route: m.route });
    return 1;
  }),
}));

const { escalateBusiness, UNDELIVERED_AFTER_MINUTES } =
  await import('../src/notifications/escalation.js');
const { Booking } = await import('../src/models/Booking.js');
const { Business } = await import('../src/models/Business.js');
const { Client } = await import('../src/models/Client.js');
const { Notification } = await import('../src/models/Notification.js');
const { Service } = await import('../src/models/Service.js');
const { infraReady } = await import('./infra.js');

const infraUp = await infraReady({ replicaSet: true });
const TZ = 'Asia/Karachi';
const MIN = 60_000;

describe.skipIf(!infraUp)('owner escalation for reminders', () => {
  let businessId: string;
  let clientId: string;
  let serviceId: string;
  const now = new Date('2030-03-10T08:00:00Z');
  const settings = { enabled: true, escalate: true, escalateMinutesBefore: 180 };

  afterAll(async () => {
    // Clients are global, not per-business: leave none behind for other suites.
    await Client.deleteMany({ phone: '923009875501' });
    await Booking.deleteMany({ businessId });
    await Notification.deleteMany({ businessId });
    await mongoose.disconnect();
  });

  beforeEach(async () => {
    pushes.length = 0;
    const business = await Business.findOneAndUpdate(
      { slug: 'escalation-test' },
      { slug: 'escalation-test', name: 'Escalation Salon', category: 'salon', timezone: TZ },
      { upsert: true, new: true, setDefaultsOnInsert: true },
    );
    businessId = String(business._id);
    await Promise.all([
      Booking.deleteMany({ businessId }),
      Notification.deleteMany({ businessId }),
      Service.deleteMany({ businessId }),
      Client.deleteMany({ phone: '923009875501' }),
    ]);
    serviceId = String(
      (await Service.create({ businessId, name: 'Facial', durationMinutes: 30, priceMinor: 1 }))
        ._id,
    );
    clientId = String((await Client.create({ phone: '923009875501', displayName: 'Sara' }))._id);
  });

  /** A booking `inMinutes` from now with one reminder in the given delivery state. */
  async function remindedBooking(
    inMinutes: number,
    reminder: { status: string; acceptedMinutesAgo?: number; delivered?: boolean },
  ) {
    const booking = await Booking.create({
      businessId,
      clientId,
      serviceId,
      staffId: 'staff-1',
      startsAt: new Date(now.getTime() + inMinutes * MIN),
      durationMinutes: 30,
      priceMinor: 1,
      source: 'whatsapp',
      status: BOOKING_STATUS.CONFIRMED,
      remindedAt: new Date(now.getTime() - 60 * MIN),
    });
    await Notification.create({
      businessId,
      clientId,
      bookingId: String(booking._id),
      kind: NOTIFICATION_KIND.REMINDER,
      dedupeKey: `${String(booking._id)}:reminder:1440`,
      text: 'Reminder',
      status: reminder.status,
      scheduledFor: new Date(now.getTime() - 60 * MIN),
      acceptedAt: new Date(now.getTime() - (reminder.acceptedMinutesAgo ?? 60) * MIN),
      deliveredAt: reminder.delivered ? new Date(now.getTime() - 59 * MIN) : null,
    });
    return booking;
  }

  const run = (at = now) => escalateBusiness(businessId, TZ, settings, at);

  it('alerts once when a delivered reminder gets no reply inside the cut-off', async () => {
    const booking = await remindedBooking(120, {
      status: DELIVERY_STATUS.DELIVERED,
      delivered: true,
    });
    await run();
    await run();
    await run(new Date(now.getTime() + 5 * MIN));

    expect(pushes).toHaveLength(1);
    expect(pushes[0]!.title).toBe("Sara hasn't confirmed");
    expect(pushes[0]!.route).toBe('/appointments');
    expect((await Booking.findById(booking._id))!.unconfirmedAlertAt).toBeInstanceOf(Date);
  });

  it('stays quiet before the cut-off and after the customer confirmed', async () => {
    await remindedBooking(600, { status: DELIVERY_STATUS.DELIVERED, delivered: true });
    const confirmed = await remindedBooking(60, { status: DELIVERY_STATUS.READ, delivered: true });
    await Booking.updateOne({ _id: confirmed._id }, { clientConfirmedAt: now });
    await run();
    expect(pushes).toHaveLength(0);
  });

  it('alerts undelivered (not unconfirmed) when an accepted reminder never acks', async () => {
    const booking = await remindedBooking(120, {
      status: DELIVERY_STATUS.ACCEPTED,
      acceptedMinutesAgo: UNDELIVERED_AFTER_MINUTES + 1,
    });
    await run();
    await run();
    expect(pushes.map((p) => p.title)).toEqual(["Reminder didn't reach Sara"]);
    const after = (await Booking.findById(booking._id))!;
    expect(after.unconfirmedAlertAt).toBeNull();
    expect(reminderState(after)).toBe('undelivered');
  });

  it('gives a just-accepted reminder time to ack before calling it lost', async () => {
    await remindedBooking(600, { status: DELIVERY_STATUS.ACCEPTED, acceptedMinutesAgo: 5 });
    await run();
    expect(pushes).toHaveLength(0);
  });

  it('alerts undelivered at once for a FAILED reminder', async () => {
    await remindedBooking(600, { status: DELIVERY_STATUS.FAILED });
    await run();
    expect(pushes.map((p) => p.title)).toEqual(["Reminder didn't reach Sara"]);
  });

  it('ignores cancelled bookings and businesses that turned it off', async () => {
    const b = await remindedBooking(60, { status: DELIVERY_STATUS.DELIVERED, delivered: true });
    await escalateBusiness(businessId, TZ, { ...settings, escalate: false }, now);
    expect(pushes).toHaveLength(0);
    await Booking.updateOne({ _id: b._id }, { status: BOOKING_STATUS.CANCELLED });
    await run();
    expect(pushes).toHaveLength(0);
  });

  it('derives the calendar badge', () => {
    expect(reminderState({})).toBeNull();
    expect(reminderState({ remindedAt: now })).toBe('awaiting');
    expect(reminderState({ remindedAt: now, clientConfirmedAt: now })).toBe('confirmed');
    expect(reminderState({ remindedAt: now, undeliveredAlertAt: now })).toBe('undelivered');
  });
});
