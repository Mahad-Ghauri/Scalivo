import type { ClientSession } from 'mongoose';
import { Booking } from '../models/Booking.js';
import { CapacityOccupancy } from '../models/CapacityOccupancy.js';
import {
  chooseResources,
  resourceIdsForBooking,
  loadResourceCapacity,
  minuteSlots,
  type ResourceRequirement,
} from './capacity.js';
import { ConfigurationConflict } from './configuration.js';

/** Changing requirements allocates existing appointments in the same fenced transaction. */
export async function allocateExistingResources(
  businessId: string,
  serviceId: string,
  requirements: ResourceRequirement[],
  bufferMinutes: number,
  session: ClientSession,
): Promise<void> {
  const bookings = await Booking.find({
    businessId,
    serviceId,
    status: { $ne: 'cancelled' },
    $expr: {
      $gt: [
        {
          $add: [
            '$startsAt',
            {
              $multiply: [
                { $add: ['$durationMinutes', { $ifNull: ['$bufferMinutes', bufferMinutes] }] },
                60000,
              ],
            },
          ],
        },
        new Date(),
      ],
    },
  })
    .sort({ startsAt: 1 })
    .limit(51)
    .session(session)
    .maxTimeMS(5000);
  if (!bookings.length) return;
  if (bookings.length > 50)
    throw new ConfigurationConflict(
      'More than 50 appointments need resource allocation. Contact support before changing these requirements.',
    );
  const ids = bookings.map((booking) => String(booking._id));
  await CapacityOccupancy.deleteMany(
    { businessId, bookingId: { $in: ids }, capacityKey: /^resource:/ },
    { session },
  );
  const start = bookings[0]!.startsAt;
  const end = new Date(
    Math.max(
      ...bookings.map(
        (booking) =>
          booking.startsAt.getTime() +
          (booking.durationMinutes + (booking.bufferMinutes ?? bufferMinutes)) * 60000,
      ),
    ),
  );
  const capacity = await loadResourceCapacity(
    null,
    businessId,
    requirements,
    { start, end },
    undefined,
    undefined,
    session,
  );
  const rows: { businessId: string; bookingId: string; capacityKey: string; slotStart: Date }[] =
    [];
  const updates = [];
  for (const booking of bookings) {
    const buffer = booking.bufferMinutes ?? bufferMinutes;
    const span = booking.durationMinutes + buffer;
    const resourceIds = chooseResources(requirements, capacity, booking.startsAt, span);
    if (!resourceIds)
      throw new ConfigurationConflict(
        'Existing appointments cannot all fit these resources. Add capacity or move the conflicting appointments first. Nothing was changed.',
      );
    for (const id of resourceIds)
      for (const slotStart of minuteSlots(booking.startsAt, span)) {
        rows.push({
          businessId,
          bookingId: String(booking._id),
          capacityKey: `resource:${id}`,
          slotStart,
        });
        capacity.taken.get(id)!.add(slotStart.getTime());
      }
    if (rows.length > 100000)
      throw new ConfigurationConflict(
        'Resource allocation is too large. Contact support before changing these requirements.',
      );
    updates.push({
      updateOne: {
        filter: { _id: booking._id, businessId },
        update: {
          $set: { resourceIds: resourceIdsForBooking(resourceIds), bufferMinutes: buffer },
          $inc: { revision: 1 },
        },
      },
    });
  }
  if (rows.length) await CapacityOccupancy.insertMany(rows, { session, ordered: true });
  await Booking.bulkWrite(updates, { session, ordered: true });
}
