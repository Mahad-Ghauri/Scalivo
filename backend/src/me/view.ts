import {
  BOOKING_STATUS,
  DEPOSIT_STATUS,
  ME_PAST_LIMIT,
  type MeAppointment,
  type MePendingReview,
  type MeUsual,
  type MeView,
  loyaltyPoints,
} from '@scalivo/shared';
import { Booking } from '../models/Booking.js';
import { Business } from '../models/Business.js';
import { Client } from '../models/Client.js';
import { ClientProfile } from '../models/ClientProfile.js';
import { Review } from '../models/Review.js';
import { Service } from '../models/Service.js';
import { Staff } from '../models/Staff.js';

/**
 * Everything the customer's own page shows, in one read.
 *
 * One call rather than an endpoint per panel, because the page has no
 * navigation: it is opened from a home-screen icon and shows everything at once,
 * so several round trips would only give it several ways to be half-loaded.
 *
 * The rule throughout: this function is handed a businessId and a clientId that
 * came from a TOKEN (me/token.ts), and every query below is scoped by both. No
 * value from the request reaches a query. That is what makes the surface unable
 * to read across tenants, rather than merely careful not to.
 */

/** Names for the ids a set of bookings mentions, in two queries rather than 2N. */
async function namesFor(bookings: { serviceId: string; staffId: string }[]): Promise<{
  services: Map<string, { name: string; durationMinutes: number; priceMinor: number }>;
  staff: Map<string, string>;
}> {
  const serviceIds = [...new Set(bookings.map((b) => b.serviceId))];
  const staffIds = [...new Set(bookings.map((b) => b.staffId))];

  const [services, staff] = await Promise.all([
    Service.find({ _id: { $in: serviceIds } }).select('name durationMinutes priceMinor'),
    Staff.find({ _id: { $in: staffIds } }).select('name'),
  ]);

  return {
    services: new Map(
      services.map((s) => [
        String(s._id),
        { name: s.name, durationMinutes: s.durationMinutes, priceMinor: s.priceMinor },
      ]),
    ),
    staff: new Map(staff.map((s) => [String(s._id), s.name])),
  };
}

/**
 * A deposit token is exposed only while the money is actually outstanding.
 *
 * Once paid, applied or refunded the payment page has nothing left to do, and a
 * live link to it invites a customer to pay twice.
 */
const owesDeposit = (status: string | null | undefined): boolean =>
  status === DEPOSIT_STATUS.AWAITING;

export async function meView(businessId: string, clientId: string): Promise<MeView | null> {
  const [business, client, profile] = await Promise.all([
    Business.findById(businessId).select('name slug timezone'),
    Client.findById(clientId).select('displayName'),
    ClientProfile.findOne({ businessId, clientId }).select(
      'totalVisits lifetimeSpendMinor firstVisitAt serviceCounts staffCounts',
    ),
  ]);

  // The token resolved, so the profile existed a moment ago. A business that has
  // since been deleted is a 404 rather than a half-rendered page.
  if (!business || !profile) return null;

  const now = new Date();

  /**
   * Upcoming is "has not started yet and was not called off" — cancellations and
   * no-shows are absent, and an appointment in progress has moved to the
   * history. AWAITING_DEPOSIT is deliberately included: that booking is the
   * reason the customer is on this page looking for the payment link.
   */
  const [upcomingDocs, pastDocs] = await Promise.all([
    Booking.find({
      businessId,
      clientId,
      startsAt: { $gte: now },
      status: {
        $in: [BOOKING_STATUS.PENDING, BOOKING_STATUS.AWAITING_DEPOSIT, BOOKING_STATUS.CONFIRMED],
      },
    }).sort({ startsAt: 1 }),
    Booking.find({
      businessId,
      clientId,
      status: { $in: [BOOKING_STATUS.COMPLETED, BOOKING_STATUS.NO_SHOW] },
    })
      .sort({ startsAt: -1 })
      .limit(ME_PAST_LIMIT),
  ]);

  const { services, staff } = await namesFor([...upcomingDocs, ...pastDocs]);

  const toAppointment = (doc: (typeof upcomingDocs)[number]): MeAppointment => ({
    id: String(doc._id),
    serviceName: services.get(doc.serviceId)?.name ?? 'Appointment',
    staffName: staff.get(doc.staffId) ?? 'Our team',
    startsAt: doc.startsAt.toISOString(),
    durationMinutes: doc.durationMinutes,
    priceMinor: doc.priceMinor,
    status: doc.status,
    appointmentHolderName: doc.appointmentHolderName ?? null,
    depositToken: owesDeposit(doc.depositStatus) ? (doc.depositToken ?? null) : null,
  });

  return {
    firstName: firstNameOf(client?.displayName),
    businessName: business.name,
    businessSlug: business.slug,
    timezone: business.timezone,
    upcoming: upcomingDocs.map(toAppointment),
    past: pastDocs.map(toAppointment),
    loyalty: {
      points: loyaltyPoints(profile.lifetimeSpendMinor),
      visits: profile.totalVisits,
      lifetimeSpendMinor: profile.lifetimeSpendMinor,
      memberSince: profile.firstVisitAt?.toISOString() ?? null,
    },
    usual: await usualFor(businessId, profile.serviceCounts, profile.staffCounts),
    pendingReview: await pendingReviewFor(businessId, clientId),
  };
}

/**
 * The greeting only. First name because that is how a business greets somebody,
 * and because the full name is the owner's record of them rather than what they
 * would call themselves.
 */
function firstNameOf(displayName: string | null | undefined): string | null {
  const first = displayName?.trim().split(/\s+/)[0];
  return first && first.length > 0 ? first : null;
}

/**
 * What "book it again" means for this customer.
 *
 * Read from the profile's counters, not by aggregating bookings: the counters
 * exist for exactly this kind of question and are rebuilt by recompute(), so
 * this stays one document read no matter how long somebody has been a customer.
 *
 * The service must still exist and still be bookable — a usual that was retired
 * last month would offer a one-tap booking that every availability query then
 * refuses, which reads as the page being broken rather than the service being
 * gone. A staff preference is dropped the same way, and independently: losing
 * the stylist is not a reason to stop offering the treatment.
 */
async function usualFor(
  businessId: string,
  serviceCounts: Map<string, number>,
  staffCounts: Map<string, number>,
): Promise<MeUsual | null> {
  const ranked = [...serviceCounts.entries()].sort((a, b) => b[1] - a[1]);

  for (const [serviceId] of ranked) {
    const service = await Service.findOne({ _id: serviceId, businessId, active: true }).select(
      'name durationMinutes priceMinor',
    );
    if (!service) continue;

    /**
     * Their person for this service, if they have one.
     *
     * Asked of the roster — `Staff.serviceIds`, which is where the relationship
     * lives — and not of the service, so a customer whose most-seen staff member
     * does something else entirely is offered the service with nobody attached
     * rather than a booking that cannot be made.
     */
    const qualified = new Set(
      (await Staff.find({ businessId, active: true, serviceIds: serviceId }).select('_id')).map(
        (s) => String(s._id),
      ),
    );

    const preferredId = [...staffCounts.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([id]) => id)
      .find((id) => qualified.has(id));

    const preferred = preferredId ? await Staff.findById(preferredId).select('name') : null;

    return {
      serviceId: String(service._id),
      serviceName: service.name,
      durationMinutes: service.durationMinutes,
      priceMinor: service.priceMinor,
      staffId: preferred ? String(preferred._id) : null,
      staffName: preferred?.name ?? null,
    };
  }

  // Never booked anything that still exists. The page offers the business's
  // full service list instead, via the marketplace profile it links to.
  return null;
}

/**
 * The most recent completed visit they have not rated.
 *
 * Only one, and only the latest: a page that opens with four rating cards is
 * asking a customer to do the business's admin. The WhatsApp request is still
 * the primary channel (reviews/request.ts) — this is the same question surviving
 * on a surface they came to anyway, which is the cheapest capture there is.
 *
 * NO_SHOW is excluded by asking for COMPLETED only: there is nothing to rate
 * about a visit that did not happen, and asking would be an accusation.
 */
async function pendingReviewFor(
  businessId: string,
  clientId: string,
): Promise<MePendingReview | null> {
  const recent = await Booking.find({
    businessId,
    clientId,
    status: BOOKING_STATUS.COMPLETED,
  })
    .sort({ completedAt: -1, startsAt: -1 })
    .limit(ME_PAST_LIMIT)
    .select('serviceId completedAt startsAt');

  if (recent.length === 0) return null;

  const rated = new Set(
    (
      await Review.find({
        businessId,
        bookingId: { $in: recent.map((b) => String(b._id)) },
      }).select('bookingId')
    ).map((r) => r.bookingId),
  );

  const unrated = recent.find((b) => !rated.has(String(b._id)));
  if (!unrated) return null;

  const service = await Service.findById(unrated.serviceId).select('name');

  return {
    bookingId: String(unrated._id),
    serviceName: service?.name ?? 'your visit',
    visitedAt: (unrated.completedAt ?? unrated.startsAt).toISOString(),
  };
}
