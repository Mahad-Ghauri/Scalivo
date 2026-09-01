import { Schema, model } from 'mongoose';

/**
 * Working hours are LOCAL WALL-CLOCK ('09:00'), not UTC instants — they are
 * converted through the business timezone at query time. Storing them as
 * instants would break the moment a business's offset changed.
 */
const workingHoursSchema = new Schema(
  {
    /** 0 = Sunday. */
    dayOfWeek: { type: Number, required: true },
    opensAt: { type: String, required: true },
    closesAt: { type: String, required: true },
    breaks: {
      type: [{ startsAt: String, endsAt: String, _id: false }],
      default: [],
    },
  },
  { _id: false },
);

const staffSchema = new Schema(
  {
    businessId: { type: String, required: true, index: true },
    name: { type: String, required: true },
    serviceIds: { type: [String], default: [] },
    workingHours: { type: [workingHoursSchema], default: [] },

    /** Inactive staff disappear from availability without losing their history. */
    active: { type: Boolean, default: true },
  },
  { timestamps: true },
);

export const Staff = model('Staff', staffSchema);
