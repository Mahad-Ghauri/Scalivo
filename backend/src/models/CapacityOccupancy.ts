import { Schema, model } from 'mongoose';

/** Minute claims protect physical assets and appointment holders across display grids. */
const schema = new Schema({
  businessId: { type: String, required: true },
  capacityKey: { type: String, required: true },
  slotStart: { type: Date, required: true },
  bookingId: { type: String, required: true },
});
schema.index({ businessId: 1, capacityKey: 1, slotStart: 1 }, { unique: true });
schema.index({ businessId: 1, bookingId: 1 });
export const CapacityOccupancy = model('CapacityOccupancy', schema);
