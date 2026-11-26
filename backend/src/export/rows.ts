import { BOOKING_STATUS } from '@scalivo/shared';
import { Booking } from '../models/Booking.js';
import { Client } from '../models/Client.js';
import { Service } from '../models/Service.js';
import { Staff } from '../models/Staff.js';

/**
 * One appointment, resolved to names — what both the CSV and the iCal feed
 * print. This is the rollback story (Phase 5 gate): the day Scalivo stops
 * working, the owner still has who is coming, when, for what, and their number.
 */
export interface ExportRow {
  id: string;
  startsAt: Date;
  endsAt: Date;
  status: string;
  serviceName: string;
  staffId: string;
  staffName: string;
  clientName: string | null;
  clientPhone: string | null;
  priceMinor: number;
  source: string;
  clientConfirmed: boolean;
  followUpDueAt: Date | null;
  updatedAt: Date | null;
}

/** Hard cap: a year of a busy salon is well under this, and it bounds memory. */
export const EXPORT_MAX_ROWS = 20_000;

export async function exportRows(input: {
  businessId: string;
  from: Date;
  to: Date;
  staffId?: string | undefined;
  includeCancelled: boolean;
}): Promise<ExportRow[]> {
  const bookings = await Booking.find({
    businessId: input.businessId,
    startsAt: { $gte: input.from, $lt: input.to },
    ...(input.staffId ? { staffId: input.staffId } : {}),
    ...(input.includeCancelled ? {} : { status: { $ne: BOOKING_STATUS.CANCELLED } }),
  })
    .sort({ startsAt: 1 })
    .limit(EXPORT_MAX_ROWS)
    .lean()
    .maxTimeMS(15_000);

  const unique = (ids: (string | null | undefined)[]) => [
    ...new Set(ids.filter((v): v is string => !!v && /^[a-f\d]{24}$/i.test(v))),
  ];
  const [clients, services, staff] = await Promise.all([
    Client.find({ _id: { $in: unique(bookings.map((b) => b.clientId)) } })
      .select('displayName phone')
      .lean(),
    Service.find({
      businessId: input.businessId,
      _id: { $in: unique(bookings.map((b) => b.serviceId)) },
    })
      .select('name')
      .lean(),
    Staff.find({
      businessId: input.businessId,
      _id: { $in: unique(bookings.map((b) => b.staffId)) },
    })
      .select('name')
      .lean(),
  ]);
  const client = new Map(clients.map((c) => [String(c._id), c]));
  const service = new Map(services.map((s) => [String(s._id), s.name]));
  const member = new Map(staff.map((s) => [String(s._id), s.name]));

  return bookings.map((b) => {
    const c = client.get(b.clientId);
    return {
      id: String(b._id),
      startsAt: b.startsAt,
      endsAt: new Date(b.startsAt.getTime() + b.durationMinutes * 60_000),
      status: b.status,
      serviceName: service.get(b.serviceId) ?? 'Service',
      staffId: b.staffId,
      staffName: member.get(b.staffId) ?? 'Staff',
      clientName: b.appointmentHolderName ?? c?.displayName ?? null,
      clientPhone: c?.phone ?? null,
      priceMinor: b.priceMinor,
      source: b.source,
      clientConfirmed: b.clientConfirmedAt != null,
      followUpDueAt:
        b.followUp && b.followUp.status !== 'cancelled' ? (b.followUp.dueAt ?? null) : null,
      updatedAt: (b as { updatedAt?: Date }).updatedAt ?? null,
    };
  });
}
