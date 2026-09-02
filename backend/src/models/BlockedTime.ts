import { Schema, model } from 'mongoose';

/**
 * Time nobody can book: Eid, a wedding, a sick afternoon, a supplier visit.
 *
 * Not stored as occupancy rows on purpose. Occupancy rows belong to a booking
 * and die with it, and a business-wide holiday would mean writing one row per
 * staff member per increment for an entire day — thousands of rows to say
 * "we're closed". An interval is the honest shape for an interval.
 *
 * The cost is that availability must subtract it explicitly rather than getting
 * it for free from the unique index. That is one range query per availability
 * call, and it is why blocked time cannot double-book anything on its own: it
 * only ever removes offers.
 */
const blockedTimeSchema = new Schema(
  {
    businessId: { type: String, required: true },

    /** null blocks the whole business — a holiday, not one person's day off. */
    staffId: { type: String, default: null },

    /** UTC half-open interval: [startsAt, endsAt). */
    startsAt: { type: Date, required: true },
    endsAt: { type: Date, required: true },

    reason: { type: String, default: null },
  },
  { timestamps: true },
);

// Availability asks "what blocks this day?" — a range scan over one business.
blockedTimeSchema.index({ businessId: 1, startsAt: 1, endsAt: 1 });

export const BlockedTime = model('BlockedTime', blockedTimeSchema);
