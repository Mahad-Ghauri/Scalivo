import { Schema, model } from 'mongoose';

/** Named inventory; each unit gets its own transactional occupancy claim. */
const schema = new Schema(
  {
    businessId: { type: String, required: true },
    name: { type: String, required: true, maxlength: 80 },
    kind: { type: String, enum: ['room', 'bed', 'chair', 'equipment'], required: true },
    quantity: { type: Number, default: 1, min: 1, max: 20 },
    fixedRoomId: { type: String, default: null },
    active: { type: Boolean, default: true },
  },
  { timestamps: true },
);
schema.index({ businessId: 1, active: 1 });
schema.index({ businessId: 1, fixedRoomId: 1, active: 1 });
schema.index({ businessId: 1, name: 1 }, { unique: true });
export const Resource = model('Resource', schema);
