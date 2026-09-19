import { Schema, model } from 'mongoose';

/**
 * A customer's rating of one appointment.
 *
 * The model exists ahead of milestone 2.2 because the public profile reads it
 * now; 2.2 is what will write it (the WhatsApp rating request after an
 * appointment is marked complete).
 *
 * `published` is the whole public/private split in one field. 2.2's rule is
 * that 4–5 stars publish and ≤3 goes privately to the owner — and the public
 * read path filters on this flag AND on the rating, so a mis-set flag on a
 * 2-star review still never reaches a stranger.
 */
const reviewSchema = new Schema(
  {
    businessId: { type: String, required: true },
    /** Null for seeded fixtures; always set once 2.2 writes these from a booking. */
    bookingId: { type: String, default: null },
    clientId: { type: String, default: null },

    /** What the public sees — a first name, never the phone number. */
    authorName: { type: String, required: true },
    rating: { type: Number, required: true, min: 1, max: 5 },
    comment: { type: String, default: '' },
    serviceName: { type: String, default: null },

    published: { type: Boolean, default: false },
  },
  { timestamps: true },
);

reviewSchema.index({ businessId: 1, published: 1, createdAt: -1 });
// One rating per appointment, however many times the request is answered.
reviewSchema.index(
  { bookingId: 1 },
  { unique: true, partialFilterExpression: { bookingId: { $type: 'string' } } },
);

export const Review = model('Review', reviewSchema);
