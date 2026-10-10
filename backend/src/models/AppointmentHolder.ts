import { Schema, model } from 'mongoose';

/** The person treated, separately from the contact receiving WhatsApp messages. */
const schema = new Schema(
  {
    businessId: { type: String, required: true },
    clientId: { type: String, required: true },
    name: { type: String, required: true, maxlength: 80 },
    active: { type: Boolean, default: true },
  },
  { timestamps: true },
);
schema.index({ businessId: 1, clientId: 1, active: 1 });
export const AppointmentHolder = model('AppointmentHolder', schema);
