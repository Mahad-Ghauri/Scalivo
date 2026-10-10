import { createHash, randomUUID } from 'node:crypto';
import mongoose from 'mongoose';
import type { Redis } from 'ioredis';
import type { Booking as BookingContract } from '@scalivo/shared';
import { Business } from '../models/Business.js';
import { Service } from '../models/Service.js';
import { Staff } from '../models/Staff.js';
import { Booking } from '../models/Booking.js';
import { BlockedTime } from '../models/BlockedTime.js';
import { SlotOccupancy } from '../models/SlotOccupancy.js';
import { addMinutes, alignToGrid, businessDayBounds, toBusinessLocal } from '../lib/time.js';
import { isDuplicateKey } from '../lib/mongo.js';
import { logger } from '../lib/logger.js';
import { recordBooking } from '../crm/profile.js';
import {
  contextFor,
  slotsFor,
  windowCheck,
  withinRoster,
  type BookingContext,
} from './availability.js';
import {
  CapacityConflict,
  chooseResources,
  resourceConflicts,
  fenceBooking,
  loadResourceCapacity,
  resolveHolder,
} from './capacity.js';
import { acquireHold, holdKeys, releaseHold, type HoldHandle } from './holds.js';
import { toBooking, writeReservation } from './create.js';

export type SequenceStep = { serviceId: string; staffId: string };
type PlannedStep = SequenceStep & {
  startsAt: Date;
  ctx: BookingContext;
  resourceIds: string[];
  conflictingResourceIds: string[];
  slots: Date[];
};
export type SequenceResult =
  | { ok: true; bookings: BookingContract[] }
  | {
      ok: false;
      reason: 'invalid_slot' | 'outside_hours' | 'too_soon' | 'beyond_horizon' | 'slot_taken';
    };

type SequenceRequest = {
  businessId: string;
  steps: SequenceStep[];
  source: 'web' | 'owner' | 'whatsapp';
  now: Date;
};

async function loadSteps(request: SequenceRequest) {
  if (request.steps.length < 2 || request.steps.length > 5) return null;
  const serviceIds = [...new Set(request.steps.map((step) => step.serviceId))];
  const staffIds = [...new Set(request.steps.map((step) => step.staffId))];
  const [business, services, staff] = await Promise.all([
    Business.findById(request.businessId).lean().maxTimeMS(5000),
    Service.find({ businessId: request.businessId, _id: { $in: serviceIds }, active: true })
      .lean()
      .maxTimeMS(5000),
    Staff.find({ businessId: request.businessId, _id: { $in: staffIds }, active: true })
      .lean()
      .maxTimeMS(5000),
  ]);
  if (!business || services.length !== serviceIds.length || staff.length !== staffIds.length)
    return null;
  const serviceMap = new Map(services.map((service) => [String(service._id), service]));
  const staffMap = new Map(staff.map((member) => [String(member._id), member]));
  const steps = request.steps.map((step) => ({
    ...step,
    ctx: contextFor(business, serviceMap.get(step.serviceId)!),
    member: staffMap.get(step.staffId)!,
  }));
  if (
    steps.some(
      (step) =>
        !step.member.serviceIds.includes(step.serviceId) ||
        (request.source !== 'owner' && step.ctx.depositMinor !== null),
    )
  )
    return null;
  const span = steps.reduce(
    (minutes, step) =>
      minutes +
      Math.ceil(step.ctx.spanMinutes / step.ctx.incrementMinutes) * step.ctx.incrementMinutes,
    0,
  );
  return span > 1440 ? null : { steps, staffIds, span };
}
type Definitions = NonNullable<Awaited<ReturnType<typeof loadSteps>>>;

async function loadWindow(
  redis: Redis,
  request: SequenceRequest,
  definitions: Definitions,
  interval: { start: Date; end: Date },
) {
  const [capacity, blocks, occupied] = await Promise.all([
    loadResourceCapacity(
      redis,
      request.businessId,
      definitions.steps.flatMap((step) => step.ctx.resourceRequirements ?? []),
      interval,
    ),
    BlockedTime.find({
      businessId: request.businessId,
      resourceId: null,
      staffId: { $in: [null, ...definitions.staffIds] },
      startsAt: { $lt: interval.end },
      endsAt: { $gt: interval.start },
    })
      .select('staffId startsAt endsAt')
      .lean()
      .limit(1001)
      .maxTimeMS(5000),
    SlotOccupancy.find({
      businessId: request.businessId,
      staffId: { $in: definitions.staffIds },
      slotStart: { $gte: interval.start, $lt: interval.end },
    })
      .select('staffId slotStart')
      .lean()
      .limit(15000)
      .maxTimeMS(5000),
  ]);
  if (blocks.length === 1001 || occupied.length === 15000) return null;
  const taken = new Set(occupied.map((row) => `${row.staffId}:${row.slotStart.getTime()}`));
  const increment = definitions.steps[0]!.ctx.incrementMinutes;
  const points: Date[] = [];
  for (
    let point = alignToGrid(interval.start, increment);
    point < interval.end;
    point = addMinutes(point, increment)
  )
    points.push(point);
  const keys = definitions.staffIds.flatMap((id) => holdKeys(request.businessId, id, points));
  const held = keys.length ? await redis.mget(...keys) : [];
  const heldKeys = new Set(keys.filter((_, index) => held[index] !== null));
  return { capacity, blocks, taken, heldKeys };
}
type Window = NonNullable<Awaited<ReturnType<typeof loadWindow>>>;

function planAt(
  request: SequenceRequest,
  definitions: Definitions,
  window: Window,
  initialStart: Date,
  respectRoster = request.source !== 'owner',
): { ok: true; steps: PlannedStep[] } | Exclude<SequenceResult, { ok: true }> {
  let startsAt = initialStart;
  const planned: PlannedStep[] = [];
  for (const step of definitions.steps) {
    const { ctx } = step;
    if (
      !Number.isFinite(startsAt.getTime()) ||
      alignToGrid(startsAt, ctx.incrementMinutes).getTime() !== startsAt.getTime()
    )
      return { ok: false, reason: 'invalid_slot' };
    const check = windowCheck(startsAt, ctx, request.now);
    if (check === 'beyond_horizon' || (check === 'too_soon' && request.source !== 'owner'))
      return { ok: false, reason: check };
    const end = addMinutes(startsAt, ctx.durationMinutes);
    if (respectRoster && !withinRoster(step.member.workingHours, { start: startsAt, end }, ctx))
      return { ok: false, reason: 'outside_hours' };
    if (
      window.blocks.some(
        (block) =>
          (!block.staffId || block.staffId === step.staffId) &&
          block.startsAt < end &&
          block.endsAt > startsAt,
      )
    )
      return { ok: false, reason: 'outside_hours' };
    const slots = slotsFor(startsAt, ctx);
    if (
      slots.some((point) => window.taken.has(`${step.staffId}:${point.getTime()}`)) ||
      holdKeys(request.businessId, step.staffId, slots).some((key) => window.heldKeys.has(key))
    )
      return { ok: false, reason: 'slot_taken' };
    const resourceIds = chooseResources(
      ctx.resourceRequirements ?? [],
      window.capacity,
      startsAt,
      ctx.spanMinutes,
    );
    if (!resourceIds) return { ok: false, reason: 'slot_taken' };
    planned.push({
      serviceId: step.serviceId,
      staffId: step.staffId,
      ctx,
      startsAt,
      resourceIds,
      conflictingResourceIds: resourceConflicts(window.capacity, resourceIds),
      slots,
    });
    startsAt = addMinutes(
      startsAt,
      Math.ceil(ctx.spanMinutes / ctx.incrementMinutes) * ctx.incrementMinutes,
    );
  }
  return { ok: true, steps: planned };
}

/** Load one bounded snapshot for the whole day; candidate checks make no database calls. */
async function offersForDay(
  redis: Redis,
  input: SequenceRequest & { date: string },
  definitions: Definitions,
) {
  const request = input;
  const ctx = definitions.steps[0]!.ctx;
  const day = businessDayBounds(request.date, ctx.timezone);
  if (
    !Number.isFinite(day.start.getTime()) ||
    day.end < input.now ||
    day.start.getTime() > input.now.getTime() + ctx.bookingHorizonDays * 86400000
  )
    return [];
  const window = await loadWindow(redis, input, definitions, {
    start: day.start,
    end: addMinutes(day.end, definitions.span),
  });
  if (!window) return [];
  const offers: {
    staffId: string;
    startsAt: Date;
    appointments: {
      serviceId: string;
      staffId: string;
      startsAt: string;
      durationMinutes: number;
    }[];
  }[] = [];
  for (
    let start = alignToGrid(day.start, ctx.incrementMinutes);
    start < day.end;
    start = addMinutes(start, ctx.incrementMinutes)
  ) {
    if (start < input.now) continue;
    const plan = planAt(input, definitions, window, start, true);
    if (plan.ok)
      offers.push({
        staffId: plan.steps[0]!.staffId,
        startsAt: start,
        appointments: plan.steps.map((step) => ({
          serviceId: step.serviceId,
          staffId: step.staffId,
          startsAt: step.startsAt.toISOString(),
          durationMinutes: step.ctx.durationMinutes,
        })),
      });
  }
  return offers;
}

export async function getSequenceAvailability(
  redis: Redis,
  request: Omit<SequenceRequest, 'now'> & { date: string; now?: Date },
) {
  const input = { ...request, now: request.now ?? new Date() };
  const definitions = await loadSteps(input);
  return definitions ? offersForDay(redis, input, definitions) : [];
}

/** Reuse definitions across the bounded date search; never offer a day for only the first treatment. */
export async function daysWithSequenceAvailability(
  redis: Redis,
  request: Omit<SequenceRequest, 'now'> & { now?: Date },
) {
  const input = { ...request, now: request.now ?? new Date() };
  const definitions = await loadSteps(input);
  if (!definitions) return [];
  const days: string[] = [];
  const deadline = Date.now() + 10000;
  for (
    let offset = 0;
    offset < Math.min(14, definitions.steps[0]!.ctx.bookingHorizonDays + 1) &&
    days.length < 3 &&
    Date.now() < deadline;
    offset++
  ) {
    const date = toBusinessLocal(
      new Date(input.now.getTime() + offset * 86400000),
      definitions.steps[0]!.ctx.timezone,
    ).toISODate();
    if (date && (await offersForDay(redis, { ...input, date }, definitions)).length)
      days.push(date);
  }
  return days;
}

async function planSequence(
  redis: Redis,
  request: SequenceRequest & { startsAt: Date },
): Promise<{ ok: true; steps: PlannedStep[] } | Exclude<SequenceResult, { ok: true }>> {
  const definitions = await loadSteps(request);
  if (!definitions || !Number.isFinite(request.startsAt.getTime()))
    return { ok: false, reason: 'invalid_slot' };
  const window = await loadWindow(redis, request, definitions, {
    start: request.startsAt,
    end: addMinutes(request.startsAt, definitions.span),
  });
  return window
    ? planAt(request, definitions, window, request.startsAt)
    : { ok: false, reason: 'slot_taken' };
}

export async function createSequence(
  redis: Redis,
  request: {
    businessId: string;
    clientId: string;
    appointmentHolderId?: string;
    steps: SequenceStep[];
    startsAt: Date;
    source: 'web' | 'owner' | 'whatsapp';
    now?: Date;
    requestId?: string;
  },
): Promise<SequenceResult> {
  if (request.requestId) {
    const replay = await Booking.find({
      businessId: request.businessId,
      clientId: request.clientId,
      sequenceId: request.requestId,
    })
      .sort({ startsAt: 1 })
      .limit(6)
      .maxTimeMS(5000);
    if (replay.length)
      return replay.length === request.steps.length &&
        replay.length <= 5 &&
        replay.every(
          (booking, index) =>
            booking.serviceId === request.steps[index]!.serviceId &&
            booking.staffId === request.steps[index]!.staffId &&
            (booking.appointmentHolderId ?? booking.clientId) ===
              (request.appointmentHolderId ?? request.clientId),
        ) &&
        replay[0]!.startsAt.getTime() === request.startsAt.getTime()
        ? { ok: true, bookings: replay.map(toBooking) }
        : { ok: false, reason: 'invalid_slot' };
  }
  const now = request.now ?? new Date();
  const plan = await planSequence(redis, { ...request, now });
  if (!plan.ok) return plan;
  const holder = await resolveHolder(
    request.businessId,
    request.clientId,
    request.appointmentHolderId,
  );
  if (!holder) return { ok: false, reason: 'invalid_slot' };
  const handles: HoldHandle[] = [];
  const ids = plan.steps.map(() => new mongoose.Types.ObjectId());
  const sequenceId = request.requestId ?? randomUUID();
  try {
    for (const step of plan.steps) {
      const handle = await acquireHold(redis, request.businessId, step.staffId, step.slots, 60, {
        resourceIds: step.resourceIds,
        conflictingResourceIds: step.conflictingResourceIds,
        serviceId: step.serviceId,
        startsAt: step.startsAt.getTime(),
        configRevision: step.ctx.configRevision ?? 0,
        spanMinutes: step.ctx.spanMinutes,
      });
      if (!handle) return { ok: false, reason: 'slot_taken' };
      handles.push(handle);
    }
    const session = await mongoose.startSession();
    try {
      await session.withTransaction(
        async () => {
          await fenceBooking(request.businessId, plan.steps[0]!.ctx.configRevision ?? 0, session);
          for (const [index, step] of plan.steps.entries())
            await writeReservation(session, {
              request: {
                businessId: request.businessId,
                clientId: request.clientId,
                serviceId: step.serviceId,
                staffId: step.staffId,
                startsAt: step.startsAt,
                source: request.source,
                holdToken: handles[index]!.token,
                sequenceId,
              },
              ctx: step.ctx,
              holder,
              resourceIds: step.resourceIds,
              conflictingResourceIds: step.conflictingResourceIds,
              slots: step.slots,
              now,
              bookingId: ids[index]!,
              requestKey: createHash('sha256').update(handles[index]!.token).digest('hex'),
            });
        },
        { maxCommitTimeMS: 5000 },
      );
    } catch (error) {
      if (isDuplicateKey(error) || error instanceof CapacityConflict)
        return { ok: false, reason: 'slot_taken' };
      throw error;
    } finally {
      await session.endSession();
    }
    const bookings = await Booking.find({ _id: { $in: ids }, businessId: request.businessId })
      .sort({ startsAt: 1 })
      .limit(5)
      .maxTimeMS(5000);
    await recordBooking(request.businessId, request.clientId, now).catch((err) =>
      logger.error({ err, businessId: request.businessId }, 'could not update sequence profile'),
    );
    return { ok: true, bookings: bookings.map(toBooking) };
  } finally {
    for (const handle of handles)
      await releaseHold(redis, handle).catch((err) =>
        logger.error({ err, businessId: request.businessId }, 'could not release sequence hold'),
      );
  }
}
