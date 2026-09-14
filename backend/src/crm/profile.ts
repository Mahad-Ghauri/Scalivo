import { BOOKING_STATUS, type ClientBusinessLink } from '@scalivo/shared';
import { Booking } from '../models/Booking.js';
import { Client } from '../models/Client.js';
import { ClientProfile } from '../models/ClientProfile.js';
import { logger } from '../lib/logger.js';
import {
  averageGapDays,
  computeTags,
  nextExpectedVisitAt,
  type TaggableProfile,
} from './tags.js';

/**
 * The self-populating half of the CRM: profiles that build themselves out of
 * booking events, with no data entry anywhere.
 *
 * The counters are a cache of what the Booking collection already knows, so the
 * rule every writer here follows is that **a counter only moves when a status
 * actually changed**. The transitions are guarded at the source with a
 * conditional update, so a retried webhook, a double-tapped "Complete" button
 * and a replayed message all move the counter exactly once. Incrementing on the
 * request rather than on the transition is how a customer ends up with eleven
 * visits from one appointment.
 *
 * And because it is only a cache, recompute() can rebuild any profile from the
 * bookings themselves — which is what makes keeping it safe.
 */

/** Create the profile if this is the first time we have seen this pairing. */
export async function ensureProfile(businessId: string, clientId: string) {
  return ClientProfile.findOneAndUpdate(
    { businessId, clientId },
    { $setOnInsert: { businessId, clientId } },
    { upsert: true, new: true, setDefaultsOnInsert: true },
  );
}

/**
 * A booking was made. Not a visit — they have not turned up yet.
 *
 * lastBookingAt matters on its own: it is what stops someone who booked
 * yesterday for next month from being chased as at-risk.
 */
export async function recordBooking(
  businessId: string,
  clientId: string,
  bookedAt: Date,
): Promise<void> {
  await ClientProfile.updateOne(
    { businessId, clientId },
    {
      $setOnInsert: { businessId, clientId },
      $max: { lastBookingAt: bookedAt },
    },
    { upsert: true, setDefaultsOnInsert: true },
  );
}

/**
 * A booking reached a terminal state.
 *
 * Only ever called from the guarded transition in bookings/outcome.ts, which
 * has already established that the status genuinely changed. Calling it
 * directly on an unchanged booking double-counts.
 */
export async function recordOutcome(
  businessId: string,
  clientId: string,
  outcome: 'completed' | 'no_show' | 'cancelled',
  booking: { startsAt: Date; priceMinor: number; serviceId: string; staffId: string },
): Promise<void> {
  if (outcome === 'completed') {
    await ClientProfile.updateOne(
      { businessId, clientId },
      {
        $setOnInsert: { businessId, clientId },
        $inc: {
          totalVisits: 1,
          lifetimeSpendMinor: booking.priceMinor,
          [`serviceCounts.${booking.serviceId}`]: 1,
          [`staffCounts.${booking.staffId}`]: 1,
        },
        // $min/$max rather than $set: outcomes can be recorded out of order —
        // an owner catching up on Monday marks Saturday complete after Sunday —
        // and a plain $set would move firstVisitAt forwards.
        $max: { lastVisitAt: booking.startsAt },
        $min: { firstVisitAt: booking.startsAt },
      },
      { upsert: true, setDefaultsOnInsert: true },
    );
    return;
  }

  // A no-show still occupied the slot and still cost the business the hour, so
  // it is counted rather than forgotten — but it is not a visit and not spend.
  await ClientProfile.updateOne(
    { businessId, clientId },
    {
      $setOnInsert: { businessId, clientId },
      $inc: outcome === 'no_show' ? { noShows: 1 } : { cancellations: 1 },
    },
    { upsert: true, setDefaultsOnInsert: true },
  );
}

/**
 * Rebuild a profile from the bookings themselves.
 *
 * The counters are a cache, and this is the thing that makes that claim true
 * rather than a hope: any drift — a crash between the transition and the
 * increment, a bug in a writer above, a manual fix in the database — is
 * repairable without reasoning about how it happened.
 *
 * Preserves notes and the opt-out, which are inputs rather than derivations and
 * exist nowhere else.
 */
export async function recomputeProfile(businessId: string, clientId: string): Promise<void> {
  const bookings = await Booking.find({ businessId, clientId }).sort({ startsAt: 1 });

  const completed = bookings.filter((b) => b.status === BOOKING_STATUS.COMPLETED);
  const serviceCounts = new Map<string, number>();
  const staffCounts = new Map<string, number>();

  for (const b of completed) {
    serviceCounts.set(b.serviceId, (serviceCounts.get(b.serviceId) ?? 0) + 1);
    staffCounts.set(b.staffId, (staffCounts.get(b.staffId) ?? 0) + 1);
  }

  const createdAts = bookings.map((b) => b.createdAt).filter((d): d is Date => Boolean(d));

  await ClientProfile.updateOne(
    { businessId, clientId },
    {
      $setOnInsert: { businessId, clientId },
      $set: {
        totalVisits: completed.length,
        noShows: bookings.filter((b) => b.status === BOOKING_STATUS.NO_SHOW).length,
        cancellations: bookings.filter((b) => b.status === BOOKING_STATUS.CANCELLED).length,
        lifetimeSpendMinor: completed.reduce((sum, b) => sum + b.priceMinor, 0),
        firstVisitAt: completed[0]?.startsAt ?? null,
        lastVisitAt: completed[completed.length - 1]?.startsAt ?? null,
        lastBookingAt:
          createdAts.length > 0
            ? new Date(Math.max(...createdAts.map((d) => d.getTime())))
            : null,
        serviceCounts,
        staffCounts,
      },
    },
    { upsert: true, setDefaultsOnInsert: true },
  );

  logger.info({ businessId, clientId, visits: completed.length }, 'profile recomputed');
}

/**
 * Narrow a stored profile to just what tagging reads.
 *
 * Mongoose types a `default: null` field as `T | null | undefined` — the
 * undefined covers a document loaded with a projection that excluded it. Every
 * caller here loads the whole document, so the coalescing is a formality, but
 * doing it in one place is what stops `?? null` being sprinkled over every
 * call site and eventually being replaced by a cast that hides a real gap.
 */
export function toTaggable(profile: {
  totalVisits: number;
  lifetimeSpendMinor: number;
  firstVisitAt?: Date | null;
  lastVisitAt?: Date | null;
  lastBookingAt?: Date | null;
}): TaggableProfile {
  return {
    totalVisits: profile.totalVisits,
    lifetimeSpendMinor: profile.lifetimeSpendMinor,
    firstVisitAt: profile.firstVisitAt ?? null,
    lastVisitAt: profile.lastVisitAt ?? null,
    lastBookingAt: profile.lastBookingAt ?? null,
  };
}

/** The id with the highest count, or null. Ties break on whichever Map saw it first. */
function topOf(counts: Map<string, number> | undefined): string | null {
  if (!counts || counts.size === 0) return null;

  let best: string | null = null;
  let bestCount = 0;
  for (const [id, count] of counts) {
    if (count > bestCount) {
      best = id;
      bestCount = count;
    }
  }
  return best;
}

export interface ProfileView extends ClientBusinessLink {
  displayName: string | null;
  phone: string | null;
  noShows: number;
  cancellations: number;
  hasUpcomingBooking: boolean;
}

/**
 * One profile, with the tags computed rather than read.
 *
 * The upcoming-booking check is a real query rather than a cached flag because
 * it changes without anything touching this profile: a booking simply becomes
 * "past" as time moves, and no event fires when it does.
 */
export async function loadProfile(
  businessId: string,
  clientId: string,
  now = new Date(),
): Promise<ProfileView | null> {
  const [profile, client, upcoming] = await Promise.all([
    ClientProfile.findOne({ businessId, clientId }),
    Client.findById(clientId),
    Booking.exists({
      businessId,
      clientId,
      startsAt: { $gte: now },
      status: { $nin: [BOOKING_STATUS.CANCELLED, BOOKING_STATUS.NO_SHOW] },
    }),
  ]);

  if (!profile || !client) return null;

  const hasUpcomingBooking = upcoming !== null;
  const taggable = toTaggable(profile);

  return {
    clientId,
    businessId,
    displayName: client.displayName ?? null,
    phone: client.phone ?? null,
    tags: computeTags(taggable, { hasUpcomingBooking, now }),
    totalVisits: profile.totalVisits,
    lifetimeSpendMinor: profile.lifetimeSpendMinor,
    averageGapDays: averageGapDays(taggable),
    lastVisitAt: taggable.lastVisitAt,
    nextExpectedVisitAt: nextExpectedVisitAt(taggable),
    mostBookedServiceId: topOf(profile.serviceCounts),
    preferredStaffId: topOf(profile.staffCounts),
    notes: profile.notes,
    marketingOptOut: profile.marketingOptOut,
    lastMarketingMessageAt: profile.lastMarketingMessageAt ?? null,
    noShows: profile.noShows,
    cancellations: profile.cancellations,
    hasUpcomingBooking,
  };
}
