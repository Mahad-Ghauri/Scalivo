import type { ClientSession } from 'mongoose';
import type { Redis } from 'ioredis';
import { Resource } from '../models/Resource.js';
import { CapacityOccupancy } from '../models/CapacityOccupancy.js';
import { BlockedTime } from '../models/BlockedTime.js';
import { Business } from '../models/Business.js';
import { Booking } from '../models/Booking.js';
import { AppointmentHolder } from '../models/AppointmentHolder.js';
import { Client } from '../models/Client.js';
import { holdKeys } from './holds.js';

export type ResourceRequirement = { anyOfResourceIds: string[] };
type Asset = {
  id: string;
  kind: string;
  fixedRoomId: string | null;
  active?: boolean;
  resourceId?: string;
};
export interface ResourceCapacity {
  assets: Map<string, Asset>;
  taken: Map<string, Set<number>>;
  blocks: { resourceId: string | null; startsAt: Date; endsAt: Date }[];
}

/** Unit one keeps the original key, so existing reservations remain valid. */
export function resourceUnitIds(id: string, quantity = 1): string[] {
  if (!Number.isInteger(quantity) || quantity < 1 || quantity > 20)
    throw new Error('invalid resource quantity');
  return Array.from({ length: quantity }, (_, index) => (index === 0 ? id : `${id}:${index + 1}`));
}

export function resourceIdsForBooking(unitIds: string[]): string[] {
  return [...new Set(unitIds.map((id) => id.split(':')[0]!))];
}

/** Exclusive rooms conflict with contained units; shared units conflict with the room. */
export function resourceConflicts(capacity: ResourceCapacity, selected: string[]): string[] {
  const conflicts = new Set<string>();
  for (const id of selected) {
    const asset = capacity.assets.get(id)!;
    if (asset.kind === 'room') {
      for (const child of capacity.assets.values())
        if (child.active !== false && child.fixedRoomId === (asset.resourceId ?? id))
          conflicts.add(child.id);
    } else if (asset.fixedRoomId) conflicts.add(asset.fixedRoomId);
  }
  return [...conflicts].filter((id) => !selected.includes(id));
}

export function minuteSlots(start: Date, minutes: number): Date[] {
  if (
    !Number.isInteger(minutes) ||
    minutes < 1 ||
    minutes > 2880 ||
    start.getTime() % 60_000 !== 0
  ) {
    throw new Error('invalid capacity interval');
  }
  return Array.from({ length: minutes }, (_, i) => new Date(start.getTime() + i * 60_000));
}

/** Batch-load once per availability window, rather than querying each candidate. */
export async function loadResourceCapacity(
  redis: Redis | null,
  businessId: string,
  requirements: ResourceRequirement[],
  interval: { start: Date; end: Date },
  ignoreBookingId?: string,
  ignoreHoldToken?: string,
  session?: ClientSession,
): Promise<ResourceCapacity> {
  const ids = [...new Set(requirements.flatMap((group) => group.anyOfResourceIds))];
  const result: ResourceCapacity = { assets: new Map(), taken: new Map(), blocks: [] };
  if (!ids.length) return result;
  if (requirements.length > 20 || ids.length > 80)
    throw new Error('resource requirements exceed limit');
  // Keep retired resource types so legacy mixed groups still fail closed.
  const primary = await Resource.find({ businessId, _id: { $in: ids } })
    .session(session ?? null)
    .lean()
    .maxTimeMS(5000);
  const parentIds = [
    ...new Set(
      primary.flatMap((asset) => (asset.active && asset.fixedRoomId ? [asset.fixedRoomId] : [])),
    ),
  ];
  const parents = parentIds.length
    ? await Resource.find({ businessId, _id: { $in: parentIds }, kind: 'room', active: true })
        .session(session ?? null)
        .lean()
        .maxTimeMS(5000)
    : [];
  const roomIds = [
    ...new Set(
      [...primary, ...parents]
        .filter((asset) => asset.kind === 'room')
        .map((asset) => String(asset._id)),
    ),
  ];
  const children = roomIds.length
    ? await Resource.find({ businessId, fixedRoomId: { $in: roomIds }, active: true })
        .session(session ?? null)
        .limit(201)
        .lean()
        .maxTimeMS(5000)
    : [];
  if (children.length > 200) throw new Error('resource capacity exceeds limit');
  for (const asset of [...primary, ...parents, ...children]) {
    const resourceId = String(asset._id);
    for (const id of resourceUnitIds(resourceId, asset.quantity ?? 1)) {
      result.assets.set(id, {
        id,
        resourceId,
        kind: asset.kind,
        fixedRoomId: asset.fixedRoomId ?? null,
        active: asset.active,
      });
      result.taken.set(id, new Set());
    }
  }
  if (result.assets.size > 200) throw new Error('resource capacity exceeds limit');
  const allIds = [...result.assets.values()]
    .filter((asset) => asset.active !== false)
    .map((asset) => asset.id);
  if (!allIds.length) return result;
  const keys = allIds.map((id) => `resource:${id}`);
  const rows = await CapacityOccupancy.find({
    businessId,
    capacityKey: { $in: keys },
    slotStart: { $gte: interval.start, $lt: interval.end },
    ...(ignoreBookingId ? { bookingId: { $ne: ignoreBookingId } } : {}),
  })
    .select('capacityKey slotStart')
    .session(session ?? null)
    .lean()
    .limit(140000)
    .maxTimeMS(5000);
  const blocks = await BlockedTime.find({
    businessId,
    resourceId: { $in: resourceIdsForBooking(allIds) },
    startsAt: { $lt: interval.end },
    endsAt: { $gt: interval.start },
  })
    .select('resourceId startsAt endsAt')
    .session(session ?? null)
    .lean()
    .limit(1000)
    .maxTimeMS(5000);
  // A truncated ledger must never be interpreted as available capacity.
  if (rows.length === 140000 || blocks.length === 1000)
    throw new Error('capacity window exceeds limit');
  for (const row of rows)
    result.taken.get(row.capacityKey.slice('resource:'.length))?.add(row.slotStart.getTime());
  result.blocks = blocks.map((block) => ({
    resourceId: block.resourceId ?? null,
    startsAt: block.startsAt,
    endsAt: block.endsAt,
  }));
  if (!redis) return result;
  const minutes = Math.ceil((interval.end.getTime() - interval.start.getTime()) / 60000);
  if (minutes < 1 || minutes > 5760) throw new Error('capacity window exceeds limit');
  const points = Array.from(
    { length: minutes },
    (_, i) => new Date(interval.start.getTime() + i * 60000),
  );
  // Pipeline bounded batches so a room/equipment list never makes a network round trip per asset.
  for (let offset = 0; offset < allIds.length; offset += 8) {
    const batch = allIds.slice(offset, offset + 8);
    const pipeline = redis.pipeline();
    for (const id of batch) pipeline.mget(...holdKeys(businessId, `resource:${id}`, points));
    const responses = await pipeline.exec();
    if (!responses || responses.length !== batch.length)
      throw new Error('capacity holds unavailable');
    for (const [index, id] of batch.entries()) {
      const response = responses[index]!;
      const values: unknown = response[1];
      if (response[0] || !Array.isArray(values) || values.length !== points.length)
        throw new Error('capacity holds unavailable');
      for (let i = 0; i < points.length; i++) {
        const value: unknown = values[i];
        if (value !== null && typeof value !== 'string') throw new Error('invalid capacity hold');
        if (value !== null && value !== ignoreHoldToken)
          result.taken.get(id)!.add(points[i]!.getTime());
      }
    }
  }
  return result;
}

/** A service reserves one unit per requirement; room sharing needs a bed/chair. */
export function chooseResources(
  requirements: ResourceRequirement[],
  capacity: ResourceCapacity,
  startsAt: Date,
  spanMinutes: number,
  allowedIds?: ReadonlySet<string>,
): string[] | null {
  if (!requirements.length) return [];
  if (
    requirements.length > 4 ||
    requirements.some(
      (group) =>
        !group.anyOfResourceIds.length ||
        group.anyOfResourceIds.length > 4 ||
        // Legacy mixed groups must not allow a room to substitute for equipment.
        new Set(
          group.anyOfResourceIds.flatMap((id) => {
            const asset = capacity.assets.get(id);
            return asset ? [asset.kind] : [];
          }),
        ).size > 1,
    )
  )
    return null;
  const points = minuteSlots(startsAt, spanMinutes);
  const end = new Date(startsAt.getTime() + spanMinutes * 60000);
  const freeCache = new Map<string, boolean>();
  const free = (id: string) => {
    const cached = freeCache.get(id);
    if (cached !== undefined) return cached;
    const value =
      capacity.assets.has(id) &&
      capacity.assets.get(id)!.active !== false &&
      points.every((point) => !capacity.taken.get(id)?.has(point.getTime())) &&
      !capacity.blocks.some(
        (block) =>
          block.resourceId === (capacity.assets.get(id)!.resourceId ?? id) &&
          block.startsAt < end &&
          block.endsAt > startsAt,
      );
    freeCache.set(id, value);
    return value;
  };
  const candidates = requirements.map((group) =>
    [...capacity.assets.values()]
      .filter(
        (asset) =>
          group.anyOfResourceIds.includes(asset.resourceId ?? asset.id) &&
          (!allowedIds || allowedIds.has(asset.id)) &&
          free(asset.id),
      )
      .map((asset) => asset.id),
  );
  if (candidates.some((group) => !group.length)) return null;
  let attempts = 0;
  const visit = (index: number, selected: string[]): string[] | null => {
    if (++attempts > 4096) return null;
    if (index === requirements.length) {
      const assets = selected.map((id) => capacity.assets.get(id)!);
      const rooms = new Set(
        assets.filter((asset) => asset.kind === 'room').map((asset) => asset.id),
      );
      for (const asset of assets) if (asset.fixedRoomId) rooms.add(asset.fixedRoomId);
      // Full-treatment occupancy means a treatment takes place in one room.
      if (rooms.size > 1 || [...rooms].some((id) => !free(id))) return null;
      const station = assets.some((asset) => asset.kind === 'bed' || asset.kind === 'chair');
      if (station && assets.some((asset) => asset.kind === 'room')) return null;
      const allocation = [...new Set([...selected, ...(station ? [] : rooms)])];
      if (resourceConflicts(capacity, allocation).some((id) => !free(id))) return null;
      return allocation;
    }
    for (const id of candidates[index]!) {
      if (selected.includes(id) || !free(id)) continue;
      const allocation = visit(index + 1, [...selected, id]);
      if (allocation) return allocation;
    }
    return null;
  };
  return visit(0, []);
}

export class CapacityConflict extends Error {}

/** Shared write fence closes configuration-vs-booking and legacy-holder races. */
export async function fenceBooking(
  businessId: string,
  configRevision: number,
  session: ClientSession,
): Promise<void> {
  const result = await Business.updateOne(
    {
      _id: businessId,
      ...(configRevision === 0
        ? { $or: [{ bookingConfigRevision: 0 }, { bookingConfigRevision: { $exists: false } }] }
        : { bookingConfigRevision: configRevision }),
    },
    { $inc: { bookingFence: 1 } },
    { session, maxTimeMS: 5000 },
  );
  if (!result.matchedCount) throw new CapacityConflict('configuration changed');
}

export async function resolveHolder(businessId: string, clientId: string, holderId?: string) {
  if (holderId) {
    const holder = await AppointmentHolder.findOne({
      _id: holderId,
      businessId,
      clientId,
      active: true,
    })
      .lean()
      .maxTimeMS(5000);
    return holder ? { id: String(holder._id), name: holder.name } : null;
  }
  const client = await Client.findById(clientId).select('displayName').lean().maxTimeMS(5000);
  return client ? { id: clientId, name: client.displayName ?? null } : null;
}

export async function claimCapacity(
  input: {
    businessId: string;
    bookingId: string;
    clientId: string;
    holderId: string;
    resourceIds: string[];
    conflictingResourceIds?: string[];
    startsAt: Date;
    durationMinutes: number;
    spanMinutes: number;
  },
  session: ClientSession,
): Promise<void> {
  // Legacy bookings predate holder claims. The business fence serializes this
  // read with new writes, so their appointments remain protected without a live backfill.
  const overlaps = await Booking.exists({
    businessId: input.businessId,
    _id: { $ne: input.bookingId },
    status: { $ne: 'cancelled' },
    ...(input.holderId === input.clientId
      ? {
          clientId: input.clientId,
          $or: [{ appointmentHolderId: null }, { appointmentHolderId: input.clientId }],
        }
      : { appointmentHolderId: input.holderId }),
    startsAt: { $lt: new Date(input.startsAt.getTime() + input.durationMinutes * 60000) },
    $expr: {
      $gt: [{ $add: ['$startsAt', { $multiply: ['$durationMinutes', 60000] }] }, input.startsAt],
    },
  })
    .session(session)
    .maxTimeMS(5000);
  if (overlaps) throw new CapacityConflict('appointment holder overlap');
  if (
    input.conflictingResourceIds?.length &&
    (await CapacityOccupancy.exists({
      businessId: input.businessId,
      capacityKey: { $in: input.conflictingResourceIds.map((id) => `resource:${id}`) },
      slotStart: {
        $gte: input.startsAt,
        $lt: new Date(input.startsAt.getTime() + input.spanMinutes * 60000),
      },
    })
      .session(session)
      .maxTimeMS(5000))
  )
    throw new CapacityConflict('room or station overlap');
  const rows = minuteSlots(input.startsAt, input.durationMinutes).map((slotStart) => ({
    businessId: input.businessId,
    bookingId: input.bookingId,
    capacityKey: `holder:${input.holderId}`,
    slotStart,
  }));
  for (const resourceId of input.resourceIds) {
    for (const slotStart of minuteSlots(input.startsAt, input.spanMinutes))
      rows.push({
        businessId: input.businessId,
        bookingId: input.bookingId,
        capacityKey: `resource:${resourceId}`,
        slotStart,
      });
  }
  await CapacityOccupancy.insertMany(rows, { session, ordered: true });
}
