import type { Redis } from 'ioredis';
import {
  BOOKING_STATUS,
  DEPOSIT_STATUS,
  GROW_CHANNELS,
  isGrowChannel,
  type FunnelEvent,
  type FunnelReport,
  type FunnelStages,
  type GrowChannel,
} from '@scalivo/shared';
import { Booking } from '../models/Booking.js';
import { FunnelDay } from '../models/FunnelDay.js';
import { businessDayBounds, toBusinessLocal } from '../lib/time.js';
import { logger } from '../lib/logger.js';
import { isDuplicateKey } from '../lib/mongo.js';

/**
 * The Grow funnel (SPEC §10): profile views → booking-form starts → bookings.
 *
 * Views and starts arrive from the profile page as anonymous beacons, so they
 * are the one number here a stranger can inflate. What bounds that:
 *
 *   - one count per visitor, per event, per local day (the dedupe below), so a
 *     reload or a back-and-forth through the booking form is still one visitor;
 *   - the route's per-IP rate limit;
 *   - and the last step never comes from a beacon at all. A booking is counted
 *     from the bookings collection, where it cannot exist without a real
 *     customer, a real slot and a phone number.
 *
 * So an inflated funnel shows a worse conversion rate, never a better one — the
 * failure points the owner towards doing more, not towards trusting a lie.
 */

/** Two local days, so a visitor straddling midnight is still deduped against "today". */
const DEDUPE_TTL_SECONDS = 2 * 24 * 60 * 60;

export type RecordOutcome = 'counted' | 'duplicate';

export async function recordFunnelEvent(
  redis: Redis,
  input: {
    businessId: string;
    timezone: string;
    type: FunnelEvent;
    channel: GrowChannel;
    visitorId: string;
    now?: Date;
  },
): Promise<RecordOutcome> {
  const day = toBusinessLocal(input.now ?? new Date(), input.timezone).toISODate()!;

  try {
    const fresh = await redis.set(
      `funnel:${input.businessId}:${input.type}:${day}:${input.visitorId}`,
      '1',
      'EX',
      DEDUPE_TTL_SECONDS,
      'NX',
    );
    if (fresh === null) return 'duplicate';
  } catch (err) {
    // Fail open. Losing the dedupe for the length of a Redis blip over-counts a
    // little; failing closed would stop counting at all.
    logger.warn({ err }, 'funnel dedupe unavailable');
  }

  const field = input.type === 'view' ? 'views' : 'starts';
  const upsert = () =>
    FunnelDay.updateOne(
      { businessId: input.businessId, day, channel: input.channel },
      { $inc: { [field]: 1 } },
      { upsert: true },
    );

  try {
    await upsert();
  } catch (err) {
    // Two first-of-the-day events racing both try to insert; the loser's row
    // now exists, so its increment lands on the retry.
    if (!isDuplicateKey(err)) throw err;
    await upsert();
  }
  return 'counted';
}

const empty = (): FunnelStages => ({ views: 0, starts: 0, bookings: 0 });

/**
 * A booking that got as far as being made.
 *
 * An unpaid deposit hold is not a booking yet, and one that expired never
 * became one — counting either would credit a channel with a customer who
 * walked away at the payment page. A booking cancelled LATER still counts: the
 * channel did its job, what happened afterwards is not the poster's fault.
 */
const MADE = {
  status: { $ne: BOOKING_STATUS.AWAITING_DEPOSIT },
  depositStatus: { $ne: DEPOSIT_STATUS.EXPIRED },
} as const;

export async function funnelReport(input: {
  businessId: string;
  timezone: string;
  /** Business-local, both inclusive. */
  from: string;
  to: string;
}): Promise<FunnelReport> {
  const { businessId, timezone, from, to } = input;
  const start = businessDayBounds(from, timezone).start;
  const end = businessDayBounds(to, timezone).end;

  const [days, bookings] = await Promise.all([
    FunnelDay.find({ businessId, day: { $gte: from, $lte: to } }).lean(),
    Booking.aggregate<{ _id: { source: string; channel: string | null }; count: number }>([
      {
        $match: {
          businessId,
          source: { $in: ['web', 'whatsapp'] },
          createdAt: { $gte: start, $lt: end },
          ...MADE,
        },
      },
      { $group: { _id: { source: '$source', channel: '$channel' }, count: { $sum: 1 } } },
    ]),
  ]);

  const channels = new Map<GrowChannel, FunnelStages>(GROW_CHANNELS.map((c) => [c, empty()]));
  for (const row of days) {
    if (!isGrowChannel(row.channel)) continue;
    const stages = channels.get(row.channel)!;
    stages.views += row.views ?? 0;
    stages.starts += row.starts ?? 0;
  }

  let whatsappBookings = 0;
  for (const row of bookings) {
    if (row._id.source === 'whatsapp') {
      whatsappBookings += row.count;
      continue;
    }
    // Web bookings made before channels were recorded have none; "direct" is
    // the honest bucket for "we don't know where they came from".
    const channel = isGrowChannel(row._id.channel) ? row._id.channel : 'direct';
    channels.get(channel)!.bookings += row.count;
  }

  const byChannel = [...channels.entries()]
    .map(([channel, stages]) => ({ channel, ...stages }))
    .filter((row) => row.views + row.starts + row.bookings > 0)
    .sort((a, b) => b.views - a.views || b.bookings - a.bookings);

  const totals = byChannel.reduce(
    (sum, row) => ({ views: sum.views + row.views, starts: sum.starts + row.starts, bookings: sum.bookings + row.bookings }),
    empty(),
  );

  return { range: { from, to }, totals, byChannel, whatsappBookings };
}
