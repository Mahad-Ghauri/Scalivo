import { Schema, model } from 'mongoose';
import { BOOKING_STATUS, DEPOSIT_STATUS } from '@scalivo/shared';

/**
 * An appointment. `startsAt` is always UTC.
 *
 * Note what is NOT here: the double-booking arbiter. A unique index on
 * {businessId, staffId, startsAt} would only catch identical start times and
 * would sail straight past a 45-min service at 4:00 overlapping a 20-min at
 * 4:15. That job belongs to the slotOccupancy grid built in Phase 1.3, written
 * with this document inside one transaction. This model is the record; it is
 * not the guard.
 */
const bookingSchema = new Schema(
  {
    businessId: { type: String, required: true, index: true },
    staffId: { type: String, required: true },
    clientId: { type: String, required: true },
    serviceId: { type: String, required: true },

    startsAt: { type: Date, required: true },
    durationMinutes: { type: Number, required: true },

    status: {
      type: String,
      enum: Object.values(BOOKING_STATUS),
      default: BOOKING_STATUS.PENDING,
    },
    priceMinor: { type: Number, required: true },

    /** Which surface created it — WhatsApp vs web is an evaluation metric. */
    source: { type: String, enum: ['whatsapp', 'web', 'owner'], required: true },

    /**
     * When the owner marked this done. Null until they do, and never unset.
     *
     * Its own field rather than `updatedAt`, because the review request is sent
     * a fixed delay after this moment and `updatedAt` moves on every later
     * write — editing a note on last week's appointment would make it newly due
     * for a rating request, days after the visit.
     */
    completedAt: { type: Date, default: null },

    /**
     * The deposit asked for, in paisa — null when none was.
     *
     * Copied from the service at booking time rather than looked up later, for
     * two reasons: an owner raising the deposit next month must not change what
     * this customer owed, and "was a deposit required?" is the split the whole
     * no-show comparison (SPEC §12.3) runs on. A lookup would answer it with
     * today's settings instead of the ones the customer actually booked under.
     */
    depositMinor: { type: Number, default: null },
    depositStatus: { type: String, enum: [...Object.values(DEPOSIT_STATUS), null], default: null },
    /** When an unpaid booking releases its slot. */
    depositDueBy: { type: Date, default: null },
    /**
     * The capability in the payment link. Random, not the booking id: the link
     * goes out over WhatsApp and gets forwarded, and an id is guessable enough
     * to walk through other people's appointments.
     */
    depositToken: { type: String, default: null },
    depositPaidAt: { type: Date, default: null },
  },
  { timestamps: true },
);

// Calendar reads (a business's day/week) and CRM reads (one client's history).
bookingSchema.index({ businessId: 1, startsAt: 1 });
bookingSchema.index({ businessId: 1, clientId: 1, startsAt: -1 });
/** The review pass: one business's recently completed appointments. */
bookingSchema.index({ businessId: 1, completedAt: 1 }, { sparse: true });

/** The expiry pass: unpaid bookings whose window has closed. */
bookingSchema.index({ status: 1, depositDueBy: 1 }, { sparse: true });
bookingSchema.index(
  { depositToken: 1 },
  { unique: true, partialFilterExpression: { depositToken: { $type: 'string' } } },
);

export const Booking = model('Booking', bookingSchema);
