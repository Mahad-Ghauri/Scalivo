import { Schema, model } from 'mongoose';

const serviceSchema = new Schema(
  {
    businessId: { type: String, required: true, index: true },
    name: { type: String, required: true },

    /** Drives how many grid increments a booking spans. */
    durationMinutes: { type: Number, required: true },

    /**
     * Turnaround after the appointment — room cleaned, machine reset.
     *
     * It extends the OCCUPANCY a booking writes, not the appointment: the
     * treatment must fit inside working hours, its buffer may run past closing.
     * Default 0 keeps every existing service behaving exactly as before.
     */
    bufferMinutes: { type: Number, default: 0 },

    /** Minor units (paisa) — never floats for money. */
    priceMinor: { type: Number, required: true },

    depositRequired: { type: Boolean, default: false },
    depositAmountMinor: { type: Number, default: null },
    displayOrder: { type: Number, default: 0 },

    /**
     * Retiring a service hides it from the menu without breaking history.
     *
     * There is no hard delete on purpose: every Booking stores a serviceId, and
     * removing the row would leave past appointments referencing nothing — the
     * calendar and the client's visit history would both show a blank.
     */
    active: { type: Boolean, default: true },
  },
  { timestamps: true },
);

export const Service = model('Service', serviceSchema);
