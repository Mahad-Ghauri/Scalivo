import { DateTime } from 'luxon';
import {
  BOOKING_STATUS,
  type AnalyticsReport,
  type Granularity,
  type RevenuePoint,
  type TopClient,
  type TopService,
} from '@scalivo/shared';
import { Booking } from '../models/Booking.js';
import { Client } from '../models/Client.js';
import { ClientProfile } from '../models/ClientProfile.js';
import { Service } from '../models/Service.js';
import { businessDayBounds } from '../lib/time.js';

/**
 * The owner's numbers — SPEC §7.
 *
 * Two decisions run through everything below, and both are the difference
 * between a dashboard that is right and one that merely looks busy:
 *
 * 1. **Revenue is completed appointments.** A booking is an intention; a
 *    completed booking is money. Counting bookings would report a record week
 *    every time somebody books a record week and then cancels it, and the owner
 *    discovers the difference from their bank rather than from this page.
 *
 * 2. **Every bucket boundary is business-LOCAL.** The grouping happens inside
 *    MongoDB with an explicit `timezone`, not by slicing UTC instants: a
 *    Karachi day starts at 19:00 the previous day in UTC, so a UTC bucket moves
 *    a salon's first five hours into yesterday. That misattribution is small
 *    enough to be invisible and large enough to make a Monday look dead.
 *
 * The aggregations are separate passes on purpose. One clever pipeline with
 * `$facet` would read the collection once and be unreadable; four small ones
 * over an indexed range are fast at the scale this runs at and each says what it
 * means. Revisit when a business has a hundred thousand appointments.
 */

/** Longest range the page will serve. A year of months is the widest useful view. */
export const MAX_ANALYTICS_DAYS = 366;

const TOP_LIST_SIZE = 5;

/** Mongo's `$dateToString` format, and Luxon's, for the same bucket. */
const BUCKET = {
  day: { mongo: '%Y-%m-%d', luxon: 'yyyy-MM-dd', step: { days: 1 } },
  // ISO week-year and week number in both — %G/%V and kkkk/WW agree, including
  // the awkward turn of the year where week 1 starts in December.
  week: { mongo: '%G-W%V', luxon: "kkkk-'W'WW", step: { weeks: 1 } },
  month: { mongo: '%Y-%m', luxon: 'yyyy-MM', step: { months: 1 } },
} as const satisfies Record<Granularity, { mongo: string; luxon: string; step: object }>;

export interface ReportRequest {
  businessId: string;
  timezone: string;
  /** Business-local ISO dates, both inclusive. */
  from: string;
  to: string;
  granularity: Granularity;
  now?: Date;
}

export async function buildReport(request: ReportRequest): Promise<AnalyticsReport> {
  const { businessId, timezone, from, to, granularity } = request;
  const now = request.now ?? new Date();

  const start = businessDayBounds(from, timezone).start;
  // The `to` day is inclusive, so the range ends where the day after it begins.
  const end = businessDayBounds(to, timezone).end;

  const inRange = { businessId, startsAt: { $gte: start, $lt: end } };
  const completedInRange = { ...inRange, status: BOOKING_STATUS.COMPLETED };

  const [byStatus, series, topServices, topClients, forecast, depositComparison] = await Promise.all([
    volumeByStatus(inRange),
    revenueSeries(completedInRange, timezone, granularity, from, to),
    servicesByRevenue(businessId, completedInRange),
    clientsBySpend(businessId),
    bookedAhead(businessId, now),
    noShowsByDeposit(inRange),
  ]);

  const completed = byStatus.get(BOOKING_STATUS.COMPLETED);
  const noShow = byStatus.get(BOOKING_STATUS.NO_SHOW);
  const cancelled = byStatus.get(BOOKING_STATUS.CANCELLED);
  const pending = byStatus.get(BOOKING_STATUS.PENDING);
  const confirmed = byStatus.get(BOOKING_STATUS.CONFIRMED);

  const completedCount = completed?.count ?? 0;
  const noShowCount = noShow?.count ?? 0;
  const reachedTheirHour = completedCount + noShowCount;

  return {
    range: { from, to, granularity },
    revenueMinor: completed?.revenueMinor ?? 0,
    series,
    volume: {
      total: [...byStatus.values()].reduce((sum, row) => sum + row.count, 0),
      completed: completedCount,
      noShow: noShowCount,
      cancelled: cancelled?.count ?? 0,
      // Unpaid holds are counted here so the breakdown still sums to the total;
      // they are not in the forecast, which only counts appointments secured.
      upcoming:
        (pending?.count ?? 0) +
        (confirmed?.count ?? 0) +
        (byStatus.get(BOOKING_STATUS.AWAITING_DEPOSIT)?.count ?? 0),
    },
    // Unknown, not zero. A business whose first week is still ahead of it has
    // no no-show rate, and printing 0% would read as a record worth keeping.
    noShowRate: reachedTheirHour === 0 ? null : noShowCount / reachedTheirHour,
    topServices,
    topClients,
    forecast,
    depositComparison,
  };
}

/**
 * SPEC §12.3 — the research question deposits exist to answer: do customers
 * who paid up front turn up more often?
 *
 * Split on whether a deposit was REQUIRED (depositMinor set at booking time),
 * over the appointments that reached their hour. An unpaid deposit never
 * reaches its hour — it expires and is cancelled — so every "with deposit" row
 * here is one where money actually changed hands. Owner-entered bookings are
 * never asked for one and sit on the "without" side, which is worth knowing
 * when reading it: walk-ins rarely no-show at all.
 */
async function noShowsByDeposit(match: object): Promise<AnalyticsReport['depositComparison']> {
  const rows = await Booking.aggregate<{ _id: boolean; reached: number; noShow: number }>([
    {
      $match: {
        ...match,
        status: { $in: [BOOKING_STATUS.COMPLETED, BOOKING_STATUS.NO_SHOW] },
      },
    },
    {
      $group: {
        _id: { $gt: [{ $ifNull: ['$depositMinor', 0] }, 0] },
        reached: { $sum: 1 },
        noShow: { $sum: { $cond: [{ $eq: ['$status', BOOKING_STATUS.NO_SHOW] }, 1, 0] } },
      },
    },
  ]);

  const side = (withDeposit: boolean) => {
    const row = rows.find((r) => r._id === withDeposit);
    const reached = row?.reached ?? 0;
    const noShow = row?.noShow ?? 0;
    return { reached, noShow, rate: reached === 0 ? null : noShow / reached };
  };
  return { withDeposit: side(true), withoutDeposit: side(false) };
}

type StatusRow = { count: number; revenueMinor: number };

async function volumeByStatus(match: object): Promise<Map<string, StatusRow>> {
  const rows = await Booking.aggregate<{ _id: string; count: number; revenueMinor: number }>([
    { $match: match },
    { $group: { _id: '$status', count: { $sum: 1 }, revenueMinor: { $sum: '$priceMinor' } } },
  ]);

  return new Map(rows.map((row) => [row._id, { count: row.count, revenueMinor: row.revenueMinor }]));
}

/**
 * Revenue per bucket, with the empty buckets filled in.
 *
 * The gaps matter. A chart drawn only from the buckets that have data draws a
 * quiet Tuesday and a busy Wednesday as adjacent points of equal width, which
 * is a line that says the opposite of what happened. So the labels are
 * generated over the whole range and the aggregation fills what it can.
 */
async function revenueSeries(
  match: object,
  timezone: string,
  granularity: Granularity,
  from: string,
  to: string,
): Promise<RevenuePoint[]> {
  const bucket = BUCKET[granularity];

  const rows = await Booking.aggregate<{ _id: string; revenueMinor: number; completed: number }>([
    { $match: match },
    {
      $group: {
        // The timezone is what makes this a business-local bucket rather than a
        // UTC one wearing a local label.
        _id: { $dateToString: { format: bucket.mongo, date: '$startsAt', timezone } },
        revenueMinor: { $sum: '$priceMinor' },
        completed: { $sum: 1 },
      },
    },
  ]);

  const found = new Map(rows.map((row) => [row._id, row]));

  const periods: string[] = [];
  const last = DateTime.fromISO(to, { zone: timezone }).endOf('day');
  let cursor = DateTime.fromISO(from, { zone: timezone }).startOf('day');

  while (cursor <= last) {
    const label = cursor.toFormat(bucket.luxon);
    // A range that starts mid-week or mid-month produces the same label twice
    // at the seam; the bucket is the unit, so it appears once.
    if (periods[periods.length - 1] !== label) periods.push(label);
    cursor = cursor.plus(bucket.step);
  }

  return periods.map((period) => ({
    period,
    revenueMinor: found.get(period)?.revenueMinor ?? 0,
    completed: found.get(period)?.completed ?? 0,
  }));
}

async function servicesByRevenue(businessId: string, match: object): Promise<TopService[]> {
  const rows = await Booking.aggregate<{ _id: string; revenueMinor: number; completed: number }>([
    { $match: match },
    { $group: { _id: '$serviceId', revenueMinor: { $sum: '$priceMinor' }, completed: { $sum: 1 } } },
    { $sort: { revenueMinor: -1 } },
    { $limit: TOP_LIST_SIZE },
  ]);

  if (rows.length === 0) return [];

  // Names resolved in one read rather than a $lookup: serviceId is a string
  // here and _id is an ObjectId there, so the join would need a conversion
  // stage that is slower and harder to read than this.
  const services = await Service.find({
    businessId,
    _id: { $in: rows.map((row) => row._id) },
  }).select('name');

  const names = new Map(services.map((service) => [String(service._id), service.name]));

  return rows.map((row) => ({
    serviceId: row._id,
    // A deleted service still earned its money, and dropping the row would make
    // the top list quietly disagree with the revenue total above it.
    name: names.get(row._id) ?? 'Removed service',
    revenueMinor: row.revenueMinor,
    completed: row.completed,
  }));
}

/**
 * Top clients by what they have spent here, ever — SPEC §7.1.
 *
 * Read from the CRM profile rather than aggregated over the range, and
 * deliberately so: "who are my best customers" is not a question about
 * September. The profile is a cache of the bookings, kept by the same
 * transaction path that writes them.
 */
async function clientsBySpend(businessId: string): Promise<TopClient[]> {
  const profiles = await ClientProfile.find({ businessId, lifetimeSpendMinor: { $gt: 0 } })
    .sort({ lifetimeSpendMinor: -1 })
    .limit(TOP_LIST_SIZE);

  if (profiles.length === 0) return [];

  const clients = await Client.find({ _id: { $in: profiles.map((p) => p.clientId) } }).select(
    'displayName',
  );
  const names = new Map(clients.map((client) => [String(client._id), client.displayName]));

  return profiles.map((profile) => ({
    clientId: profile.clientId,
    // Walk-ins and unresolved contacts genuinely have no name (FINDING #1), and
    // they are still customers with a spend worth seeing.
    name: names.get(profile.clientId) ?? 'Unnamed customer',
    lifetimeSpendMinor: profile.lifetimeSpendMinor,
    totalVisits: profile.totalVisits,
  }));
}

/** What is already on the books: appointments that exist and have not happened. */
async function bookedAhead(
  businessId: string,
  now: Date,
): Promise<{ revenueMinor: number; bookings: number }> {
  const rows = await Booking.aggregate<{ _id: null; revenueMinor: number; bookings: number }>([
    {
      $match: {
        businessId,
        startsAt: { $gte: now },
        status: { $in: [BOOKING_STATUS.PENDING, BOOKING_STATUS.CONFIRMED] },
      },
    },
    { $group: { _id: null, revenueMinor: { $sum: '$priceMinor' }, bookings: { $sum: 1 } } },
  ]);

  return { revenueMinor: rows[0]?.revenueMinor ?? 0, bookings: rows[0]?.bookings ?? 0 };
}
