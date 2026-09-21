import { Schema, model } from 'mongoose';

/**
 * One person's relationship with ONE business.
 *
 * The split from `Client` is a tenancy boundary, not normalisation. A Client is
 * a person, global across the platform — the same phone number books a salon on
 * Tuesday and a gym on Thursday. Spend, visit history, tags and the owner's
 * notes belong to a relationship, and putting them on the Client would let one
 * salon read another's notes about a customer they share.
 *
 * Every numeric field here is a CACHE of what the Booking collection already
 * says. That is deliberate — the owner opens a profile seconds after a booking
 * lands, and an aggregation over every booking for every profile view is a
 * query that gets slower for exactly the businesses doing best. recompute() in
 * crm/profile.ts rebuilds any of it from the bookings, which is what makes the
 * cache safe to keep.
 *
 * Tags are NOT stored. See crm/tags.ts: LAPSED is a function of elapsed time,
 * and nothing happens when a customer stops coming — there is no event to hook.
 * A stored tag would be wrong from the moment it was written.
 */
const clientProfileSchema = new Schema(
  {
    businessId: { type: String, required: true },
    clientId: { type: String, required: true },

    /** COMPLETED bookings only. A booking that was made is not a visit. */
    totalVisits: { type: Number, default: 0 },
    noShows: { type: Number, default: 0 },
    cancellations: { type: Number, default: 0 },

    /** Sum of priceMinor over completed bookings, in paisa. */
    lifetimeSpendMinor: { type: Number, default: 0 },

    firstVisitAt: { type: Date, default: null },
    lastVisitAt: { type: Date, default: null },

    /**
     * The last time they booked ANYTHING, including a future appointment.
     *
     * Distinct from lastVisitAt and load-bearing: someone who booked yesterday
     * for next month has not visited, but is obviously not at risk of lapsing.
     */
    lastBookingAt: { type: Date, default: null },

    /** Counts by id, so "usual service" and "their stylist" are one read. */
    serviceCounts: { type: Map, of: Number, default: () => new Map<string, number>() },
    staffCounts: { type: Map, of: Number, default: () => new Map<string, number>() },

    /** The one manual field in the whole CRM. */
    notes: { type: String, default: '' },

    /**
     * STOP, scoped to THIS business.
     *
     * Per-business because a customer silencing one salon's offers has not
     * asked to be silenced by every business on the platform — and because the
     * opt-out has to survive them being a happy customer somewhere else.
     */
    marketingOptOut: { type: Boolean, default: false },
    lastMarketingMessageAt: { type: Date, default: null },

    /**
     * History from before Scalivo, as the owner's CSV stated it (2.7).
     *
     * Kept apart from the counters because the counters are a cache of the
     * Booking collection, and recompute() rebuilds them from bookings alone —
     * folding the import straight into totalVisits would let the first
     * recompute quietly erase a customer's twelve pre-Scalivo visits. Recompute
     * adds this back on instead, so it survives and re-importing REPLACES it
     * rather than doubling it.
     */
    imported: {
      type: {
        visits: { type: Number, default: 0 },
        spendMinor: { type: Number, default: 0 },
        firstVisitAt: { type: Date, default: null },
        lastVisitAt: { type: Date, default: null },
        importedAt: { type: Date, required: true },
        _id: false,
      },
      default: null,
    },
  },
  { timestamps: true },
);

/**
 * One profile per person per business. Unique rather than merely indexed: two
 * rows would split a customer's history in half, and each half would look like
 * a quieter customer than they are.
 */
clientProfileSchema.index({ businessId: 1, clientId: 1 }, { unique: true });

/** The CRM list: a business's customers, most recently active first. */
clientProfileSchema.index({ businessId: 1, lastBookingAt: -1 });

export const ClientProfile = model('ClientProfile', clientProfileSchema);
