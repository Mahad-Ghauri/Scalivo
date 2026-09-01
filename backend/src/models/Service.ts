import { Schema, model } from 'mongoose';

const serviceSchema = new Schema(
  {
    businessId: { type: String, required: true, index: true },
    name: { type: String, required: true },

    /** Drives how many grid increments a booking spans. */
    durationMinutes: { type: Number, required: true },

    /** Minor units (paisa) — never floats for money. */
    priceMinor: { type: Number, required: true },

    depositRequired: { type: Boolean, default: false },
    depositAmountMinor: { type: Number, default: null },
    displayOrder: { type: Number, default: 0 },
  },
  { timestamps: true },
);

export const Service = model('Service', serviceSchema);
