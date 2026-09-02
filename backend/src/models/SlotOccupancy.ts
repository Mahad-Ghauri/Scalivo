import { Schema, model } from 'mongoose';

/**
 * The double-booking arbiter. One row per base increment a booking occupies.
 *
 * Why it exists at all: `Booking` carries {businessId, staffId, startsAt}, and a
 * unique index on those three only catches *identical* start times. A 45-min
 * service at 4:00 and a 20-min at 4:15 for one staff member have different
 * startsAt — both insert cleanly, and nothing ever notices the overlap.
 *
 * Decomposing into grid points removes the ambiguity: the 45-min booking claims
 * 4:00, 4:15, 4:30; the 20-min one claims 4:15. They collide on 4:15, the unique
 * index rejects it, and the transaction wrapping both this insert and the
 * booking insert aborts the whole thing.
 *
 * Never check-then-write. Read-then-insert has a window between the read and the
 * insert, and that window is exactly where a double booking lives. Insert, and
 * let the duplicate-key error be the answer.
 */
const slotOccupancySchema = new Schema(
  {
    businessId: { type: String, required: true },
    staffId: { type: String, required: true },

    /** UTC, always aligned to the business's increment grid — see alignToGrid(). */
    slotStart: { type: Date, required: true },

    /** Deleting a booking's rows by this id is how a cancellation frees time. */
    bookingId: { type: String, required: true, index: true },
  },
  { timestamps: true },
);

// THE constraint of the whole booking system. If this index is missing or not
// unique, every guarantee above evaporates silently — nothing errors, bookings
// just start overlapping. seed.ts calls syncIndexes() for this reason.
slotOccupancySchema.index({ businessId: 1, staffId: 1, slotStart: 1 }, { unique: true });

// Availability reads a whole day for a set of staff at once.
slotOccupancySchema.index({ businessId: 1, slotStart: 1 });

export const SlotOccupancy = model('SlotOccupancy', slotOccupancySchema);
