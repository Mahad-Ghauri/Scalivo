import mongoose from 'mongoose';
import {
  BOOKING_STATUS,
  FOLLOW_UP_STATUS,
  type FollowUpItem,
  type FollowUpStatus,
} from '@scalivo/shared';
import { Booking } from '../models/Booking.js';
import { Client } from '../models/Client.js';
import { Service } from '../models/Service.js';
import { Staff } from '../models/Staff.js';

/**
 * Setting, clearing and listing follow-ups. Owner-only: the customer is never
 * asked to pre-book one; they are offered a slot when it comes due (job.ts).
 */

export type SetFollowUpResult =
  | { ok: true; followUp: NonNullable<Awaited<ReturnType<typeof readFollowUp>>> }
  | {
      ok: false;
      reason:
        'not_found' | 'invalid_status' | 'invalid_service' | 'invalid_staff' | 'already_closed';
    };

/** States the owner may still edit. Once offered, the customer has seen it. */
const EDITABLE: FollowUpStatus[] = [FOLLOW_UP_STATUS.SCHEDULED, FOLLOW_UP_STATUS.CANCELLED];

export async function setFollowUp(input: {
  businessId: string;
  bookingId: string;
  afterDays: number;
  serviceId?: string | null | undefined;
  staffId?: string | null | undefined;
  note?: string | null | undefined;
  now?: Date;
}): Promise<SetFollowUpResult> {
  if (!mongoose.isValidObjectId(input.bookingId)) return { ok: false, reason: 'not_found' };
  const booking = await Booking.findOne({ _id: input.bookingId, businessId: input.businessId });
  if (!booking) return { ok: false, reason: 'not_found' };

  // A visit that will never happen has nothing to follow.
  if (booking.status === BOOKING_STATUS.CANCELLED || booking.status === BOOKING_STATUS.NO_SHOW) {
    return { ok: false, reason: 'invalid_status' };
  }
  if (booking.followUp && !EDITABLE.includes(booking.followUp.status as FollowUpStatus)) {
    return { ok: false, reason: 'already_closed' };
  }

  const serviceId = input.serviceId ?? booking.serviceId;
  if (!mongoose.isValidObjectId(serviceId)) return { ok: false, reason: 'invalid_service' };
  const service = await Service.findOne({
    _id: serviceId,
    businessId: input.businessId,
    active: true,
  });
  if (!service) return { ok: false, reason: 'invalid_service' };

  // Default to the same professional when they can do the follow-up service.
  let staffId: string | null = input.staffId === undefined ? booking.staffId : input.staffId;
  if (staffId) {
    const qualified = mongoose.isValidObjectId(staffId)
      ? await Staff.exists({
          _id: staffId,
          businessId: input.businessId,
          active: true,
          serviceIds: serviceId,
        })
      : null;
    if (!qualified) {
      if (input.staffId) return { ok: false, reason: 'invalid_staff' };
      staffId = null; // the inherited one can't do it — let anyone take it
    }
  }

  const now = input.now ?? new Date();
  await Booking.updateOne(
    { _id: booking._id },
    {
      $set: {
        followUp: {
          dueAt: new Date(booking.startsAt.getTime() + input.afterDays * 86_400_000),
          serviceId,
          staffId,
          note: input.note?.trim() || null,
          status: FOLLOW_UP_STATUS.SCHEDULED,
          setAt: now,
          offeredAt: null,
          nudgedAt: null,
          closedAt: null,
          lapsedReason: null,
          bookedBookingId: null,
        },
      },
    },
  );
  return { ok: true, followUp: (await readFollowUp(String(booking._id)))! };
}

export async function clearFollowUp(businessId: string, bookingId: string, now = new Date()) {
  if (!mongoose.isValidObjectId(bookingId)) return false;
  const result = await Booking.updateOne(
    {
      _id: bookingId,
      businessId,
      'followUp.status': {
        $in: [
          FOLLOW_UP_STATUS.SCHEDULED,
          FOLLOW_UP_STATUS.OFFERED,
          FOLLOW_UP_STATUS.NUDGED,
          FOLLOW_UP_STATUS.LAPSED,
        ],
      },
    },
    { $set: { 'followUp.status': FOLLOW_UP_STATUS.CANCELLED, 'followUp.closedAt': now } },
  );
  return result.matchedCount === 1;
}

async function readFollowUp(bookingId: string) {
  const b = await Booking.findById(bookingId).select('followUp').lean();
  return b?.followUp ?? null;
}

/** Which follow-ups the owner list shows. "open" = still needs something. */
export const LIST_FILTER = {
  open: [
    FOLLOW_UP_STATUS.SCHEDULED,
    FOLLOW_UP_STATUS.OFFERED,
    FOLLOW_UP_STATUS.NUDGED,
    FOLLOW_UP_STATUS.LAPSED,
  ],
  lapsed: [FOLLOW_UP_STATUS.LAPSED],
  all: Object.values(FOLLOW_UP_STATUS),
} as const;

export async function listFollowUps(
  businessId: string,
  filter: keyof typeof LIST_FILTER,
  limit = 100,
): Promise<FollowUpItem[]> {
  const rows = await Booking.find({
    businessId,
    'followUp.status': { $in: LIST_FILTER[filter] },
  })
    // Lapsed first is what "call these people" needs; then soonest due.
    .sort({ 'followUp.dueAt': 1 })
    .limit(limit)
    .lean()
    .maxTimeMS(5000);

  const ids = (pick: (r: (typeof rows)[number]) => string | null | undefined): string[] => [
    ...new Set(rows.map(pick).filter((v): v is string => !!v && mongoose.isValidObjectId(v))),
  ];

  const [clients, services, staff] = await Promise.all([
    Client.find({ _id: { $in: ids((r) => r.clientId) } })
      .select('displayName phone')
      .lean(),
    Service.find({ businessId, _id: { $in: ids((r) => r.followUp?.serviceId) } })
      .select('name')
      .lean(),
    Staff.find({ businessId, _id: { $in: ids((r) => r.followUp?.staffId) } })
      .select('name')
      .lean(),
  ]);
  const client = new Map(clients.map((c) => [String(c._id), c]));
  const service = new Map(services.map((s) => [String(s._id), s.name]));
  const member = new Map(staff.map((s) => [String(s._id), s.name]));

  const items = rows.map((r): FollowUpItem => {
    const f = r.followUp!;
    const c = client.get(r.clientId);
    return {
      bookingId: String(r._id),
      status: f.status as FollowUpStatus,
      dueAt: f.dueAt,
      note: f.note ?? null,
      lapsedReason: f.lapsedReason ?? null,
      serviceId: f.serviceId,
      serviceName: service.get(f.serviceId) ?? 'Service',
      staffId: f.staffId ?? null,
      staffName: f.staffId ? (member.get(f.staffId) ?? null) : null,
      clientId: r.clientId,
      clientName: r.appointmentHolderName ?? c?.displayName ?? null,
      clientPhone: c?.phone ?? null,
      visitAt: r.startsAt,
      bookedBookingId: f.bookedBookingId ?? null,
    };
  });
  const rank = (s: FollowUpStatus) => (s === FOLLOW_UP_STATUS.LAPSED ? 0 : 1);
  return items.sort((a, b) => rank(a.status) - rank(b.status) || +a.dueAt - +b.dueAt);
}
