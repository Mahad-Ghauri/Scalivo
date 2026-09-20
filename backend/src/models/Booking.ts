import { Schema, model } from 'mongoose';
import { BOOKING_STATUS } from '@scalivo/shared';

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
  },
  { timestamps: true },
);

// Calendar reads (a business's day/week) and CRM reads (one client's history).
bookingSchema.index({ businessId: 1, startsAt: 1 });
bookingSchema.index({ businessId: 1, clientId: 1, startsAt: -1 });
/** The review pass: one business's recently completed appointments. */
bookingSchema.index({ businessId: 1, completedAt: 1 }, { sparse: true });

export const Booking = model('Booking', bookingSchema);
