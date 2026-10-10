import { Schema, model } from 'mongoose';

const schema = new Schema(
  {
    businessId: { type: String, required: true },
    bookingId: { type: String, required: true },
    actorId: { type: String, required: true },
    reason: { type: String, required: true, maxlength: 200 },
    before: { type: String, required: true },
    after: { type: String, required: true },
    revision: { type: Number, required: true },
  },
  { timestamps: true },
);
schema.index({ businessId: 1, bookingId: 1, revision: 1 }, { unique: true });
export const BookingAudit = model('BookingAudit', schema);
