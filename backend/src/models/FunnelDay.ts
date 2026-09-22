import { Schema, model } from 'mongoose';
import { GROW_CHANNELS } from '@scalivo/shared';

/**
 * Profile views and booking-form starts, counted per business, per LOCAL day,
 * per channel (SPEC §10 funnel).
 *
 * Counters rather than one document per event. The questions asked of this are
 * "how many, over this range, from where" — never "which visitor" — and a row
 * per page view would store a browsing history nobody needs and grow without
 * bound. The day is the business's own calendar date, so "yesterday" in the
 * report is the owner's yesterday, not the server's.
 *
 * Bookings are deliberately NOT counted here. The booking document is already
 * the record, with its channel on it; a second counter could only drift from it.
 */
const funnelDaySchema = new Schema(
  {
    businessId: { type: String, required: true },
    /** 'YYYY-MM-DD' in the business's timezone. */
    day: { type: String, required: true },
    channel: { type: String, enum: GROW_CHANNELS, required: true },
    views: { type: Number, default: 0 },
    starts: { type: Number, default: 0 },
  },
  { timestamps: false },
);

// The upsert's target, and the report's range scan — the same index serves both.
funnelDaySchema.index({ businessId: 1, day: 1, channel: 1 }, { unique: true });

export const FunnelDay = model('FunnelDay', funnelDaySchema);
